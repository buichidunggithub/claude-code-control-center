/**
 * Scan ingestion and reconciliation.
 *
 * Record identity
 *  - Identity-bearing events (message id, else line uuid) are grouped by a salted fingerprint of
 *    that id across ALL sources. The accounting state (accepted/duplicate/conflicting/ambiguous)
 *    is recomputed per group with the M1.1 policy whenever any member is added or removed.
 *  - Anonymous events have no event identity. Their row identity is (source fingerprint, line
 *    number). They are never merged on counter equality.
 *
 * Rescan semantics (per source, all inside one transaction for the whole scan)
 *  - new:       insert all rows.
 *  - unchanged: same keyed content hash, no row writes.
 *  - appended:  the previously stored bytes are an exact prefix and ended on a newline, so earlier
 *               line numbers are stable; rows are still replaced wholesale.
 *  - modified:  anything else (edit, insertion, truncation, replacement). Rows for the source are
 *               replaced wholesale. Anonymous positions cannot be linked across versions, which is
 *               reported as `anonymousIdentityUncertain`.
 *  - failed:    unreadable or missing source. Its prior rows are NEVER deleted: absence during a
 *               failed or partial scan is not evidence that the usage did not happen.
 *
 * Limits: deduplication is by identity only. The same bytes copied to a second path give identity-
 * bearing duplicates (collapsed) but a second set of anonymous rows (counted under ifDistinct).
 * A session replayed into a new file with fresh message ids cannot be recognized.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { snapshotKey } from "../parse/accounting";
import { TOKEN_FIELDS, type UsageObservation } from "../parse/types";
import { fingerprint, type Store } from "./database";
import { FactsWriteError, recomputeToolDedup, replaceSourceFacts, sourceFactsStale } from "./facts-store";
import { TOKEN_COLUMN_PREFIX, recomputeAccounting } from "./reconcile";
import type { SourceInput, SourceScan } from "./source-reader";
import { all, inTransaction, num, one, run, sqliteErrorCode, str } from "./sql";

export type ScanStatus = "complete" | "partial" | "failed";
export type SourceOutcome = "new" | "unchanged" | "appended" | "modified" | "failed";

export interface SourceReport {
  readonly sourceFingerprint: string | null;
  readonly outcome: SourceOutcome;
  readonly errorCode: string | null;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
  readonly recordsRetained: number;
  readonly anonymousIdentityUncertain: boolean;
  /** Whether this scan replaced the source's event facts. Informational: it never affects usage rows. */
  readonly factsRefreshed?: boolean;
}

export interface IngestSummary {
  readonly scanRunId: number;
  readonly status: ScanStatus;
  readonly sources: readonly SourceReport[];
}

export interface IngestOptions {
  readonly now?: () => Date;
}

/** Carries only a code; the underlying error text is dropped because it may quote data. */
export class IngestError extends Error {
  /** `facts`: the failure came from writing event facts. Either way the whole scan was rolled back. */
  constructor(
    readonly code: string,
    readonly phase: "usage" | "facts" = "usage",
  ) {
    super(`ingest failed (${code})`);
    this.name = "IngestError";
  }
}

const errorCodeOf = (error: unknown): string => sqliteErrorCode(error, "INGEST_ERROR");

const flag = (value: boolean): number => (value ? 1 : 0);

interface PriorSource {
  readonly id: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly endedWithNewline: boolean;
  readonly factsVersion: number;
}

function findPrior(db: DatabaseSync, sourceFingerprint: string): PriorSource | null {
  const row = one(
    db,
    "SELECT id, content_hash, size_bytes, ended_with_newline, facts_version FROM source_files WHERE fingerprint = ?",
    sourceFingerprint,
  );
  return row
    ? {
        id: num(row, "id"),
        contentHash: str(row, "content_hash"),
        sizeBytes: num(row, "size_bytes"),
        endedWithNewline: num(row, "ended_with_newline") === 1,
        factsVersion: num(row, "facts_version"),
      }
    : null;
}

function sessionRowId(db: DatabaseSync, store: Store, cache: Map<string, number>, sessionId: string | null): number | null {
  if (sessionId === null) return null;
  const sessionFp = fingerprint(store.salt, "session", sessionId);
  const cached = cache.get(sessionFp);
  if (cached !== undefined) return cached;
  run(db, "INSERT INTO sessions (fingerprint) VALUES (?) ON CONFLICT (fingerprint) DO NOTHING", sessionFp);
  const row = one(db, "SELECT id FROM sessions WHERE fingerprint = ?", sessionFp);
  if (!row) throw new TypeError("session row missing after insert");
  cache.set(sessionFp, num(row, "id"));
  return num(row, "id");
}

const RECORD_COLUMNS = [
  "source_file_id", "line_number", "identity_kind", "event_key_fp", "session_id", "model", "event_type", "ts", "day",
  "is_sidechain",
  ...TOKEN_FIELDS.flatMap((f) => [`${TOKEN_COLUMN_PREFIX[f]}_state`, `${TOKEN_COLUMN_PREFIX[f]}_value`]),
  "accounting", "group_size",
];
// Placeholders are derived from the column list so the two can never drift apart.
const INSERT_RECORD_SQL = `INSERT INTO usage_records (${RECORD_COLUMNS.join(", ")}) VALUES (${RECORD_COLUMNS.map(() => "?").join(", ")})`;

function insertRecord(
  db: DatabaseSync,
  store: Store,
  sessions: Map<string, number>,
  sourceFileId: number,
  observation: UsageObservation,
): void {
  const eventKeyFp = observation.eventKey === null ? null : fingerprint(store.salt, "event", observation.eventKey);
  const tokenParams = TOKEN_FIELDS.flatMap((field): SQLInputValue[] => {
    const count = observation.tokens[field];
    return [count.kind, count.kind === "value" ? count.value : null];
  });
  run(
    db,
    INSERT_RECORD_SQL,
    sourceFileId,
    observation.lineNumber,
    observation.identity,
    eventKeyFp,
    sessionRowId(db, store, sessions, observation.sessionId),
    observation.model,
    observation.eventType,
    observation.timestamp,
    observation.timestamp === null ? null : observation.timestamp.slice(0, 10),
    observation.isSidechain === null ? null : flag(observation.isSidechain),
    ...tokenParams,
    // Provisional: identity groups are recomputed from all sources before the transaction ends.
    eventKeyFp === null ? "ambiguous" : "accepted",
    1,
  );
}

function recordSignature(line: number, eventKeyFp: string | null, tokenKey: string): string {
  return `${line}|${eventKeyFp ?? ""}|${tokenKey}`;
}

function signaturesForSource(db: DatabaseSync, sourceFileId: number) {
  const rows = all(db, "SELECT * FROM usage_records WHERE source_file_id = ?", sourceFileId);
  const signatures = new Set<string>();
  const eventKeyFps = new Set<string>();
  let anonymous = 0;
  for (const row of rows) {
    const eventKeyFp = row["event_key_fp"] === null ? null : str(row, "event_key_fp");
    if (eventKeyFp === null) anonymous += 1;
    else eventKeyFps.add(eventKeyFp);
    const tokenKey = TOKEN_FIELDS.map((f) => {
      const p = TOKEN_COLUMN_PREFIX[f];
      const state = str(row, `${p}_state`);
      return state === "value" ? `v${num(row, `${p}_value`)}` : state;
    }).join("|");
    signatures.add(recordSignature(num(row, "line_number"), eventKeyFp, tokenKey));
  }
  return { count: rows.length, signatures, eventKeyFps, anonymous };
}

interface WriteContext {
  readonly store: Store;
  readonly runId: number;
  readonly affected: Set<string>;
  readonly sessions: Map<string, number>;
  /** Salted tool-use ids whose cross-source deduplication must be recomputed before the scan commits. */
  readonly affectedToolIds: Set<string>;
}

function writeSource(ctx: WriteContext, src: SourceScan): SourceReport {
  const { store, runId, affected, sessions } = ctx;
  const db = store.db;
  const prior = findPrior(db, src.fingerprint);
  const observations = src.scan.usage;
  const newSignatures = observations.map((o) =>
    recordSignature(o.lineNumber, o.eventKey === null ? null : fingerprint(store.salt, "event", o.eventKey), snapshotKey(o.tokens)),
  );
  for (const o of observations) {
    if (o.eventKey !== null) affected.add(fingerprint(store.salt, "event", o.eventKey));
  }
  const newAnonymous = observations.filter((o) => o.eventKey === null).length;

  if (prior && prior.contentHash === src.contentHash) {
    run(db, "UPDATE source_files SET last_read_scan_id = ? WHERE id = ?", runId, prior.id);
    // Same usage bytes does not mean facts were collected: sources from before schema v4 never had them.
    const refreshed = sourceFactsStale(db, prior, src.scan);
    if (refreshed) replaceSourceFacts(store, ctx.affectedToolIds, prior.id, src.scan);
    return { sourceFingerprint: src.fingerprint, outcome: "unchanged", errorCode: null, recordsInserted: 0, recordsRemoved: 0, recordsRetained: observations.length, anonymousIdentityUncertain: false, factsRefreshed: refreshed };
  }

  let sourceFileId: number;
  let outcome: SourceOutcome = "new";
  let removed = 0;
  let retained = 0;
  let oldAnonymous = 0;
  if (!prior) {
    sourceFileId = run(
      db,
      `INSERT INTO source_files (fingerprint, label, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      src.fingerprint, src.label, src.contentHash, src.sizeBytes, flag(src.endedWithNewline), runId, runId,
    );
  } else {
    sourceFileId = prior.id;
    const old = signaturesForSource(db, prior.id);
    old.eventKeyFps.forEach((fp) => affected.add(fp));
    removed = old.count;
    oldAnonymous = old.anonymous;
    retained = newSignatures.filter((s) => old.signatures.has(s)).length;
    const appended =
      prior.endedWithNewline &&
      src.sizeBytes > prior.sizeBytes &&
      src.prefixCheck !== null &&
      src.prefixCheck.size === prior.sizeBytes &&
      src.prefixCheck.hash === prior.contentHash;
    outcome = appended ? "appended" : "modified";
    run(db, "DELETE FROM usage_records WHERE source_file_id = ?", prior.id);
    run(
      db,
      "UPDATE source_files SET content_hash = ?, size_bytes = ?, ended_with_newline = ?, last_read_scan_id = ? WHERE id = ?",
      src.contentHash, src.sizeBytes, flag(src.endedWithNewline), runId, prior.id,
    );
  }
  for (const observation of observations) insertRecord(db, store, sessions, sourceFileId, observation);
  replaceSourceFacts(store, ctx.affectedToolIds, sourceFileId, src.scan);

  return {
    sourceFingerprint: src.fingerprint,
    outcome,
    errorCode: null,
    recordsInserted: observations.length,
    recordsRemoved: removed,
    recordsRetained: retained,
    anonymousIdentityUncertain: outcome === "modified" && oldAnonymous + newAnonymous > 0,
    factsRefreshed: true,
  };
}

function insertSourceResult(db: DatabaseSync, runId: number, input: SourceInput, report: SourceReport): void {
  const known = report.sourceFingerprint === null ? null : one(db, "SELECT id FROM source_files WHERE fingerprint = ?", report.sourceFingerprint);
  const c = input.kind === "ok" ? input.scan.counters : null;
  const detail = c ? JSON.stringify({ eventsByType: c.eventsByType, tokenFieldIssues: c.tokenFieldIssues }) : "{}";
  run(
    db,
    `INSERT INTO source_scan_results (
       scan_run_id, source_file_id, outcome, error_code, anonymous_identity_uncertain,
       records_inserted, records_removed, records_retained, lines_read, blank_lines, malformed_lines,
       oversized_lines, non_object_lines, events_without_usage, usage_objects_malformed,
       unusable_timestamps, missing_session_ids, missing_models, sidechain_records,
       unrecognized_usage_key_count, usage_records_parsed, detail_json
     ) VALUES (${Array.from({ length: 22 }, () => "?").join(", ")})`,
    runId, known ? num(known, "id") : null, report.outcome, report.errorCode, flag(report.anonymousIdentityUncertain),
    report.recordsInserted, report.recordsRemoved, report.recordsRetained,
    c?.linesRead ?? 0, c?.blankLines ?? 0, c?.malformedLines ?? 0, c?.oversizedLines ?? 0, c?.nonObjectLines ?? 0,
    c?.eventsWithoutUsage ?? 0, c?.usageObjectsMalformed ?? 0, c?.unusableTimestamps ?? 0, c?.missingSessionIds ?? 0,
    c?.missingModels ?? 0, c?.sidechainRecords ?? 0, c?.unrecognizedUsageKeyCount ?? 0,
    input.kind === "ok" ? input.scan.usage.length : 0, detail,
  );
}

function writeScan(store: Store, inputs: readonly SourceInput[], startedAt: string, now: () => Date): IngestSummary {
  const db = store.db;
  const runId = run(db, "INSERT INTO scan_runs (started_at, status, sources_requested) VALUES (?, 'running', ?)", startedAt, inputs.length);
  const ctx: WriteContext = { store, runId, affected: new Set(), sessions: new Map(), affectedToolIds: new Set() };

  const reports = inputs.map((input): SourceReport => {
    const report: SourceReport =
      input.kind === "ok"
        ? writeSource(ctx, input)
        : { sourceFingerprint: input.fingerprint, outcome: "failed", errorCode: input.errorCode, recordsInserted: 0, recordsRemoved: 0, recordsRetained: 0, anonymousIdentityUncertain: false };
    insertSourceResult(db, runId, input, report);
    return report;
  });

  recomputeAccounting(db, ctx.affected);
  recomputeToolDedup(db, ctx.affectedToolIds);
  run(db, "DELETE FROM sessions WHERE id NOT IN (SELECT session_id FROM usage_records WHERE session_id IS NOT NULL)");

  const count = (o: SourceOutcome) => reports.filter((r) => r.outcome === o).length;
  const failed = count("failed");
  const status: ScanStatus = failed === 0 ? "complete" : failed === reports.length ? "failed" : "partial";
  run(
    db,
    `UPDATE scan_runs SET finished_at = ?, status = ?, sources_new = ?, sources_unchanged = ?, sources_appended = ?,
       sources_modified = ?, sources_failed = ?, records_inserted = ?, records_removed = ? WHERE id = ?`,
    now().toISOString(), status, count("new"), count("unchanged"), count("appended"), count("modified"), failed,
    reports.reduce((n, r) => n + r.recordsInserted, 0), reports.reduce((n, r) => n + r.recordsRemoved, 0), runId,
  );
  return { scanRunId: runId, status, sources: reports };
}

/**
 * Writes one scan atomically. If anything throws, every row from this call (including partial
 * reconciliation) is rolled back, a `failed` scan run with an error code is recorded, and an
 * `IngestError` carrying only that code is thrown.
 */
export function ingestSources(store: Store, inputs: readonly SourceInput[], options: IngestOptions = {}): IngestSummary {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  try {
    return inTransaction(store.db, () => writeScan(store, inputs, startedAt, now));
  } catch (error) {
    const phase = error instanceof FactsWriteError ? "facts" : "usage";
    const code = errorCodeOf(error instanceof FactsWriteError ? error.original : error);
    run(
      store.db,
      "INSERT INTO scan_runs (started_at, finished_at, status, error_code, sources_requested) VALUES (?, ?, 'failed', ?, ?)",
      startedAt, now().toISOString(), code, inputs.length,
    );
    throw new IngestError(code, phase);
  }
}
