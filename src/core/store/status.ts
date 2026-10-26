/** Read-only status queries for the scan history tables. Counts and fixed codes only. */
import type { DatabaseSync } from "node:sqlite";
import { all, num, one, optStr, str, type Row } from "./sql";

export interface UsageScanStatus {
  readonly id: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly sourcesRequested: number;
  readonly sourcesFailed: number;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
}

export interface ConfigScanStatus {
  readonly id: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly isCurrent: boolean;
  readonly rootsRequested: number;
  readonly rootsUnavailable: number;
  readonly filesInventoried: number;
  readonly filesSkipped: number;
  readonly findingsCount: number;
}

export function latestUsageScan(db: DatabaseSync): UsageScanStatus | null {
  const r = one(db, "SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1");
  if (!r) return null;
  return {
    id: num(r, "id"),
    status: str(r, "status"),
    errorCode: optStr(r, "error_code"),
    startedAt: str(r, "started_at"),
    finishedAt: optStr(r, "finished_at"),
    sourcesRequested: num(r, "sources_requested"),
    sourcesFailed: num(r, "sources_failed"),
    recordsInserted: num(r, "records_inserted"),
    recordsRemoved: num(r, "records_removed"),
  };
}

export function completedUsageScanCount(db: DatabaseSync): number {
  const r = one(db, "SELECT COUNT(*) AS n FROM scan_runs WHERE status = 'complete'");
  return r ? num(r, "n") : 0;
}

export function latestConfigScan(db: DatabaseSync): ConfigScanStatus | null {
  const r = one(db, "SELECT * FROM config_scans ORDER BY id DESC LIMIT 1");
  if (!r) return null;
  return {
    id: num(r, "id"),
    status: str(r, "status"),
    errorCode: optStr(r, "error_code"),
    startedAt: str(r, "started_at"),
    finishedAt: optStr(r, "finished_at"),
    isCurrent: num(r, "is_current") === 1,
    rootsRequested: num(r, "roots_requested"),
    rootsUnavailable: num(r, "roots_unavailable"),
    filesInventoried: num(r, "files_inventoried"),
    filesSkipped: num(r, "files_skipped"),
    findingsCount: num(r, "findings_count"),
  };
}

/** Files of the current snapshot by activation status. Never a "loaded" count: that is not knowable. */
export function configActivationCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    all(
      db,
      `SELECT f.activation AS k, COUNT(*) AS n FROM config_files f JOIN config_scans s ON s.id = f.scan_id AND s.is_current = 1 GROUP BY f.activation ORDER BY f.activation`,
    ).map((r) => [str(r, "k"), num(r, "n")]),
  );
}

/** Skipped files of the current snapshot by fixed error code. */
export function configSkipCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    all(
      db,
      `SELECT COALESCE(f.error_code, 'UNKNOWN') AS k, COUNT(*) AS n FROM config_files f JOIN config_scans s ON s.id = f.scan_id AND s.is_current = 1
        WHERE f.status = 'skipped' GROUP BY k ORDER BY k`,
    ).map((r) => [str(r, "k"), num(r, "n")]),
  );
}

export function configImportStatusCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    all(
      db,
      `SELECT i.status AS k, COUNT(*) AS n FROM config_imports i JOIN config_scans s ON s.id = i.scan_id AND s.is_current = 1 GROUP BY i.status ORDER BY i.status`,
    ).map((r) => [str(r, "k"), num(r, "n")]),
  );
}

/**
 * Sources whose anonymous event identity is currently uncertain.
 *
 * A `modified` read cannot link its anonymous events (no message id, no uuid) to the previous version, and
 * ingest flags that. The stored evidence that can settle the question later is the source's CURRENT records:
 *
 *   uncertain  <=>  a successful (complete or partial scan) `modified` read of the source flagged it,
 *                   AND the source still stores at least one anonymous record.
 *
 * Consequences, all deliberate:
 *  - An unchanged re-read, a failed source read or a failed scan changes nothing here (failed reads never
 *    delete a source's records, and `unchanged` evaluates nothing).
 *  - An append does not clear uncertainty: it re-reads the whole source but does not reconcile the
 *    anonymous records already stored, so the earlier ambiguity remains.
 *  - A rewrite does not clear it either, unless the stored records then contain no anonymous record at all;
 *    a clear flag on its own proves nothing about rows that are still there.
 *  - It clears only when no anonymous record remains for the source.
 *
 * Limitation: the schema keeps no per-read count of anonymous records. If a source was flagged, later
 * rewritten to have none (cleared), and then gains new anonymous records through an append, it is reported
 * as uncertain again although those new records have stable line positions. That errs on the side of
 * keeping the warning. Recording the anonymous-record count on each source result (the existing
 * `detail_json` column would hold it, with no migration) would remove this over-reporting.
 */
export function identityUncertainSourceCount(db: DatabaseSync): number {
  const row = one(
    db,
    `SELECT COUNT(*) AS n FROM source_files sf
      WHERE EXISTS (
              SELECT 1 FROM source_scan_results r JOIN scan_runs s ON s.id = r.scan_run_id
               WHERE r.source_file_id = sf.id AND r.outcome = 'modified' AND r.anonymous_identity_uncertain = 1
                 AND s.status IN ('complete', 'partial'))
        AND EXISTS (SELECT 1 FROM usage_records u WHERE u.source_file_id = sf.id AND u.identity_kind = 'none')`,
  );
  return row ? num(row, "n") : 0;
}

/**
 * Stored records flagged as sidechain, by accounting state. Every state is counted (settled, unresolved and
 * excluded duplicates); records whose sidechain flag is unknown are not counted as sidechain.
 */
export function sidechainStateCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    all(db, "SELECT accounting AS k, COUNT(*) AS n FROM usage_records WHERE is_sidechain = 1 GROUP BY accounting ORDER BY accounting").map((r) => [str(r, "k"), num(r, "n")]),
  );
}

/** One `scan_runs` row as stored. Counters are only meaningful for a run that finished (see the analysis layer). */
export interface UsageRunRow {
  readonly id: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly sourcesRequested: number;
  readonly sourcesNew: number;
  readonly sourcesUnchanged: number;
  readonly sourcesAppended: number;
  readonly sourcesModified: number;
  readonly sourcesFailed: number;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
}

function toUsageRun(r: Row): UsageRunRow {
  return {
    id: num(r, "id"),
    status: str(r, "status"),
    errorCode: optStr(r, "error_code"),
    startedAt: str(r, "started_at"),
    finishedAt: optStr(r, "finished_at"),
    sourcesRequested: num(r, "sources_requested"),
    sourcesNew: num(r, "sources_new"),
    sourcesUnchanged: num(r, "sources_unchanged"),
    sourcesAppended: num(r, "sources_appended"),
    sourcesModified: num(r, "sources_modified"),
    sourcesFailed: num(r, "sources_failed"),
    recordsInserted: num(r, "records_inserted"),
    recordsRemoved: num(r, "records_removed"),
  };
}

export function usageRunCount(db: DatabaseSync): number {
  const r = one(db, "SELECT COUNT(*) AS n FROM scan_runs");
  return r ? num(r, "n") : 0;
}

/** Newest first by start time; equal start times fall back to the id so the order is total and repeatable. */
export function listUsageRuns(db: DatabaseSync, limit: number, offset: number): UsageRunRow[] {
  return all(db, "SELECT * FROM scan_runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?", limit, offset).map(toUsageRun);
}

export function usageRunById(db: DatabaseSync, id: number): UsageRunRow | null {
  const r = one(db, "SELECT * FROM scan_runs WHERE id = ?", id);
  return r ? toUsageRun(r) : null;
}
