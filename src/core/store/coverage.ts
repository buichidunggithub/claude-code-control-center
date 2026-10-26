/**
 * Read-only per-source coverage queries over `source_files` and `source_scan_results`.
 *
 * What these tables establish, and what they do not:
 * - A result row is attributed to a source only when the source was already stored at the time of the read, so a
 *   failed read of a source that had not yet been stored (or whose path could not be resolved) has no source link.
 *   Attribution is therefore a lower bound of what was attempted, never a complete record.
 * - "Latest" is by run start time, then run id, then result id, matching the run history order.
 * - Nothing here says a source still exists on disk: the absence of a result in a run is not a deletion.
 */
import type { DatabaseSync } from "node:sqlite";
import { all, num, one, optNum, optStr, str, type Row } from "./sql";

export interface SourceCoverageRow {
  /** Internal; never exposed. */
  readonly id: number;
  /** Internal salted value; never exposed. */
  readonly fingerprint: string;
  readonly firstSeenRunId: number;
  readonly firstSeenAt: string | null;
  readonly lastReadRunId: number;
  readonly lastReadAt: string | null;
  readonly resultCount: number;
  readonly recordsStored: number;
  readonly resultsInFirstSeenRun: number;
  readonly resultsInLastReadRun: number;
  readonly resultsInLatestCommittedRun: number;
  readonly latest: { readonly outcome: string; readonly errorCode: string | null; readonly runId: number; readonly startedAt: string | null } | null;
  readonly outcomeCounts: Readonly<Record<string, number>>;
}

export interface SourceResultRow {
  readonly runId: number;
  readonly runStartedAt: string | null;
  readonly runStatus: string;
  readonly runErrorCode: string | null;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly anonymousIdentityUncertain: boolean;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
  readonly recordsRetained: number;
  readonly usageRecordsParsed: number;
  readonly blankLines: number;
  readonly malformedLines: number;
  readonly oversizedLines: number;
  readonly nonObjectLines: number;
  readonly usageObjectsMalformed: number;
  readonly eventsWithoutUsage: number;
  readonly unusableTimestamps: number;
  readonly unrecognizedUsageKeys: number;
}

const RESULT_ORDER = "r.started_at DESC, r.id DESC, x.id DESC";

const BASE_SELECT = `
SELECT sf.id AS id, sf.fingerprint AS fingerprint,
       sf.first_seen_scan_id AS first_run, fr.started_at AS first_at,
       sf.last_read_scan_id AS last_run, lr.started_at AS last_at,
       (SELECT COUNT(*) FROM source_scan_results x WHERE x.source_file_id = sf.id) AS result_count,
       (SELECT COUNT(*) FROM usage_records u WHERE u.source_file_id = sf.id) AS stored_records,
       (SELECT COUNT(*) FROM source_scan_results x WHERE x.source_file_id = sf.id AND x.scan_run_id = sf.first_seen_scan_id) AS first_results,
       (SELECT COUNT(*) FROM source_scan_results x WHERE x.source_file_id = sf.id AND x.scan_run_id = sf.last_read_scan_id) AS last_results,
       (SELECT COUNT(*) FROM source_scan_results x WHERE x.source_file_id = sf.id AND x.scan_run_id = ?) AS latest_results,
       latest.outcome AS latest_outcome, latest.error_code AS latest_error, latest.scan_run_id AS latest_run, lt.started_at AS latest_at
  FROM source_files sf
  LEFT JOIN scan_runs fr ON fr.id = sf.first_seen_scan_id
  LEFT JOIN scan_runs lr ON lr.id = sf.last_read_scan_id
  LEFT JOIN source_scan_results latest ON latest.id = (
         SELECT x.id FROM source_scan_results x JOIN scan_runs r ON r.id = x.scan_run_id
          WHERE x.source_file_id = sf.id ORDER BY ${RESULT_ORDER} LIMIT 1)
  LEFT JOIN scan_runs lt ON lt.id = latest.scan_run_id`;

/** The newest scan that committed (finished, no run-level error). Null when none did. */
export function latestCommittedRunId(db: DatabaseSync): number | null {
  const r = one(
    db,
    `SELECT id FROM scan_runs WHERE finished_at IS NOT NULL AND status IN ('complete','partial','failed') AND error_code IS NULL
      ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  return r ? num(r, "id") : null;
}

export function sourceCount(db: DatabaseSync): number {
  const r = one(db, "SELECT COUNT(*) AS n FROM source_files");
  return r ? num(r, "n") : 0;
}

/** Every stored source's identity pair, for resolving an opaque reference. Internal use only. */
export function listSourceIdentities(db: DatabaseSync): { readonly id: number; readonly fingerprint: string }[] {
  return all(db, "SELECT id, fingerprint FROM source_files ORDER BY id").map((r) => ({ id: num(r, "id"), fingerprint: str(r, "fingerprint") }));
}

function outcomeCountsFor(db: DatabaseSync, ids: readonly number[]): Map<number, Record<string, number>> {
  const out = new Map<number, Record<string, number>>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  for (const r of all(db, `SELECT source_file_id AS id, outcome, COUNT(*) AS n FROM source_scan_results WHERE source_file_id IN (${marks}) GROUP BY source_file_id, outcome ORDER BY outcome`, ...ids)) {
    const id = num(r, "id");
    out.set(id, { ...(out.get(id) ?? {}), [str(r, "outcome")]: num(r, "n") });
  }
  return out;
}

function toRow(r: Row, counts: Map<number, Record<string, number>>): SourceCoverageRow {
  const id = num(r, "id");
  return {
    id,
    fingerprint: str(r, "fingerprint"),
    firstSeenRunId: num(r, "first_run"),
    firstSeenAt: optStr(r, "first_at"),
    lastReadRunId: num(r, "last_run"),
    lastReadAt: optStr(r, "last_at"),
    resultCount: num(r, "result_count"),
    recordsStored: num(r, "stored_records"),
    resultsInFirstSeenRun: num(r, "first_results"),
    resultsInLastReadRun: num(r, "last_results"),
    resultsInLatestCommittedRun: num(r, "latest_results"),
    latest: r["latest_outcome"] === null ? null : { outcome: str(r, "latest_outcome"), errorCode: optStr(r, "latest_error"), runId: num(r, "latest_run"), startedAt: optStr(r, "latest_at") },
    outcomeCounts: counts.get(id) ?? {},
  };
}

/** Most recently observed first (run start, then run id, then source id); sources with no attributed result come last. */
export function listSourceCoverage(db: DatabaseSync, latestRunId: number | null, limit: number, offset: number): SourceCoverageRow[] {
  const rows = all(db, `${BASE_SELECT} ORDER BY lt.started_at IS NULL, lt.started_at DESC, latest.scan_run_id DESC, sf.id DESC LIMIT ? OFFSET ?`, latestRunId, limit, offset);
  const counts = outcomeCountsFor(db, rows.map((r) => num(r, "id")));
  return rows.map((r) => toRow(r, counts));
}

export function sourceCoverageById(db: DatabaseSync, latestRunId: number | null, id: number): SourceCoverageRow | null {
  const r = one(db, `${BASE_SELECT} WHERE sf.id = ?`, latestRunId, id);
  return r ? toRow(r, outcomeCountsFor(db, [id])) : null;
}

export function sourceResultCount(db: DatabaseSync, sourceId: number): number {
  const r = one(db, "SELECT COUNT(*) AS n FROM source_scan_results WHERE source_file_id = ?", sourceId);
  return r ? num(r, "n") : 0;
}

export function listSourceResults(db: DatabaseSync, sourceId: number, limit: number, offset: number): SourceResultRow[] {
  return all(
    db,
    `SELECT x.*, r.started_at AS run_started_at, r.status AS run_status, r.error_code AS run_error
       FROM source_scan_results x JOIN scan_runs r ON r.id = x.scan_run_id
      WHERE x.source_file_id = ? ORDER BY ${RESULT_ORDER} LIMIT ? OFFSET ?`,
    sourceId,
    limit,
    offset,
  ).map((r) => ({
    runId: num(r, "scan_run_id"),
    runStartedAt: optStr(r, "run_started_at"),
    runStatus: str(r, "run_status"),
    runErrorCode: optStr(r, "run_error"),
    outcome: str(r, "outcome"),
    errorCode: optStr(r, "error_code"),
    anonymousIdentityUncertain: optNum(r, "anonymous_identity_uncertain") === 1,
    recordsInserted: num(r, "records_inserted"),
    recordsRemoved: num(r, "records_removed"),
    recordsRetained: num(r, "records_retained"),
    usageRecordsParsed: num(r, "usage_records_parsed"),
    blankLines: num(r, "blank_lines"),
    malformedLines: num(r, "malformed_lines"),
    oversizedLines: num(r, "oversized_lines"),
    nonObjectLines: num(r, "non_object_lines"),
    usageObjectsMalformed: num(r, "usage_objects_malformed"),
    eventsWithoutUsage: num(r, "events_without_usage"),
    unusableTimestamps: num(r, "unusable_timestamps"),
    unrecognizedUsageKeys: num(r, "unrecognized_usage_key_count"),
  }));
}
