/**
 * Persistence of privacy-safe event facts (schema v4), kept apart from usage accounting: nothing here reads or
 * writes `usage_records`, `sessions` or any token column, so facts cannot change settled totals.
 *
 * Source lifecycle
 *  - A source's facts are replaced wholesale whenever its usage rows are (new, appended, modified), inside the
 *    same transaction, so a rollback leaves usage and facts consistent.
 *  - An UNCHANGED source (same content hash) is refreshed when its facts are stale: never collected
 *    (`facts_version` below the current one, which covers every source that predates v4), or collected without
 *    reading text length while this scan did read it. The scan already holds the facts, so no separate re-read
 *    mode exists: a source is refreshed only when the caller names it. There is no discovery and no downgrade:
 *    a source with stored text-length buckets keeps them when later scanned with the opt-in off.
 *  - A failed or absent source keeps its previous facts.
 *
 * Tool-call deduplication
 *  - Every occurrence is stored. For one salted tool-use id across ALL stored sources, the occurrence with the
 *    smallest (source fingerprint, line number, block index) is `kept`; the others are `duplicate`. This depends
 *    only on stored data, never on ingestion or filesystem order. The source fingerprint is a salted hash of the
 *    path, so which of two copies wins is stable within a database but arbitrary across databases.
 *  - The kept occurrence's bucket is the one that counts, even if a duplicate was recorded with another name.
 *  - It is recomputed for every id touched by a scan, whether added, changed or removed. Any future code that
 *    deletes a source must collect the affected ids first and call `recomputeToolDedup` afterwards.
 *  - Calls with no id are never merged; their only identity is (source, line, block index), valid for one
 *    version of that source and recomputed whenever the source changes.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ScanResult } from "../parse/scan";
import { fingerprint, type Store } from "./database";
import { all, num, one, run, str } from "./sql";

/** Bump when the stored facts logic changes in a way old rows cannot express. 0 is reserved for "never collected". */
export const CURRENT_FACTS_VERSION = 1;

const flag = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);
const dayOf = (timestamp: string | null): string | null => (timestamp === null ? null : timestamp.slice(0, 10));

/**
 * Marks a failure that happened while writing event facts. It wraps the original error so the caller can still
 * reduce it to a database error code; its own message is fixed and never quotes data.
 */
export class FactsWriteError extends Error {
  constructor(readonly original: unknown) {
    super("facts write failed");
    this.name = "FactsWriteError";
  }
}

export interface FactsSourceState {
  readonly id: number;
  readonly factsVersion: number;
}

function sessionFp(store: Store, sessionId: string | null): string | null {
  return sessionId === null ? null : fingerprint(store.salt, "session", sessionId);
}

/** True when this scan would add facts the stored source lacks. See the lifecycle notes above. */
export function sourceFactsStale(db: DatabaseSync, prior: FactsSourceState, scan: ScanResult): boolean {
  if (prior.factsVersion < CURRENT_FACTS_VERSION) return true;
  if (!scan.userEvents.some((event) => event.textLength !== "not-read")) return false;
  return one(db, "SELECT 1 AS present FROM source_user_events WHERE source_file_id = ? AND size_state = 'not-read' LIMIT 1", prior.id) !== undefined;
}

const INSERT_USER_EVENT = `INSERT INTO source_user_events (source_file_id, line_number, session_fp, ts, day, is_sidechain, size_state)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
// Provisional state: id-bearing calls start as duplicates (so no two can be `kept`), anonymous ones are kept.
const INSERT_TOOL_CALL = `INSERT INTO tool_calls (source_file_id, line_number, block_index, tool_id_fp, tool_bucket, session_fp, ts, day, is_sidechain, dedup, dedup_group_size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

/**
 * Replaces one source's facts with those of `scan` and stamps the source with the current facts version.
 * Adds every tool-use id it removes or inserts to `affectedToolIds` for the caller's dedup recomputation.
 */
export function replaceSourceFacts(
  store: Store,
  affectedToolIds: Set<string>,
  sourceFileId: number,
  scan: ScanResult,
): void {
  try {
    writeSourceFacts(store, affectedToolIds, sourceFileId, scan);
  } catch (error) {
    throw new FactsWriteError(error);
  }
}

function writeSourceFacts(store: Store, affectedToolIds: Set<string>, sourceFileId: number, scan: ScanResult): void {
  const db = store.db;
  for (const row of all(db, "SELECT DISTINCT tool_id_fp FROM tool_calls WHERE source_file_id = ? AND tool_id_fp IS NOT NULL", sourceFileId)) {
    affectedToolIds.add(str(row, "tool_id_fp"));
  }
  run(db, "DELETE FROM tool_calls WHERE source_file_id = ?", sourceFileId);
  run(db, "DELETE FROM source_user_events WHERE source_file_id = ?", sourceFileId);

  for (const event of scan.userEvents) {
    run(
      db, INSERT_USER_EVENT, sourceFileId, event.lineNumber, sessionFp(store, event.sessionId),
      event.timestamp, dayOf(event.timestamp), flag(event.isSidechain), event.textLength,
    );
  }
  for (const call of scan.tools) {
    const toolIdFp = call.toolUseId === null ? null : fingerprint(store.salt, "tool", call.toolUseId);
    if (toolIdFp !== null) affectedToolIds.add(toolIdFp);
    run(
      db, INSERT_TOOL_CALL, sourceFileId, call.lineNumber, call.blockIndex, toolIdFp, call.toolBucket,
      sessionFp(store, call.sessionId), call.timestamp, dayOf(call.timestamp), flag(call.isSidechain),
      toolIdFp === null ? "kept" : "duplicate",
    );
  }
  run(db, "UPDATE source_files SET facts_version = ? WHERE id = ?", CURRENT_FACTS_VERSION, sourceFileId);
}

/** Re-derives `dedup` and `dedup_group_size` for each given salted tool-use id across all stored sources. */
export function recomputeToolDedup(db: DatabaseSync, toolIdFingerprints: ReadonlySet<string>): void {
  try {
    recomputeDedupGroups(db, toolIdFingerprints);
  } catch (error) {
    throw new FactsWriteError(error);
  }
}

function recomputeDedupGroups(db: DatabaseSync, toolIdFingerprints: ReadonlySet<string>): void {
  for (const toolIdFp of [...toolIdFingerprints].sort()) {
    const rows = all(
      db,
      `SELECT tc.id FROM tool_calls tc JOIN source_files sf ON sf.id = tc.source_file_id
        WHERE tc.tool_id_fp = ? ORDER BY sf.fingerprint, tc.line_number, tc.block_index`,
      toolIdFp,
    );
    // Demote first: the unique index allows at most one `kept` per id, even between statements.
    run(db, "UPDATE tool_calls SET dedup = 'duplicate' WHERE tool_id_fp = ? AND dedup <> 'duplicate'", toolIdFp);
    rows.forEach((row, index) => {
      run(db, "UPDATE tool_calls SET dedup = ?, dedup_group_size = ? WHERE id = ?", index === 0 ? "kept" : "duplicate", rows.length, num(row, "id"));
    });
  }
}
