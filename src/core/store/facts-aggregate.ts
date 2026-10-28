/**
 * Read-only aggregate queries over the persisted event facts (schema v4).
 *
 * These read `source_user_events`, `tool_calls` and `source_files.facts_version` only. They never touch
 * `usage_records`, token columns or the `sessions` table, so nothing here can feed token totals. Results are
 * plain grouped counts; vocabulary validation and redaction happen in the analysis layer. Session
 * fingerprints are returned for grouping and must not leave the server.
 */
import type { DatabaseSync } from "node:sqlite";
import { CURRENT_FACTS_VERSION } from "./facts-store";
import { all, num, one, optNum, optStr, str } from "./sql";

export interface FactsCoverageCounts {
  readonly sources: number;
  /** facts_version is the current one. */
  readonly current: number;
  /** Collected by an older facts logic: 0 < facts_version < current. */
  readonly outdated: number;
  /** facts_version is 0: the facts of the source were never collected. */
  readonly neverCollected: number;
}

export function factsCoverageCounts(db: DatabaseSync): FactsCoverageCounts {
  const row = one(
    db,
    `SELECT COUNT(*) AS sources,
            COALESCE(SUM(facts_version >= ?), 0) AS current,
            COALESCE(SUM(facts_version = 0), 0) AS never
       FROM source_files`,
    CURRENT_FACTS_VERSION,
  );
  if (!row) throw new TypeError("coverage query returned no row");
  const sources = num(row, "sources");
  const current = num(row, "current");
  const neverCollected = num(row, "never");
  return { sources, current, outdated: sources - current - neverCollected, neverCollected };
}

export interface UserEventGroup {
  /** UTC calendar day, or null when the event had no usable timestamp. */
  readonly day: string | null;
  readonly sidechain: boolean | null;
  /** Raw stored value; the caller validates it against the known vocabulary. */
  readonly sizeState: string;
  readonly count: number;
}

export interface ToolCallGroup {
  readonly day: string | null;
  readonly sidechain: boolean | null;
  readonly bucket: string;
  readonly dedup: string;
  /** No tool-use id was recorded. Such calls are never merged and are always kept. */
  readonly anonymous: boolean;
  readonly count: number;
}

const sidechainOf = (value: number | null): boolean | null => (value === null ? null : value === 1);

/** `sessionFp` undefined: all rows. A string: only that session. Never null: facts without a session are not selectable. */
export function userEventGroups(db: DatabaseSync, sessionFp?: string): UserEventGroup[] {
  const where = sessionFp === undefined ? "" : "WHERE session_fp = ?";
  const params = sessionFp === undefined ? [] : [sessionFp];
  return all(
    db,
    `SELECT day, is_sidechain, size_state, COUNT(*) AS n FROM source_user_events ${where}
      GROUP BY day, is_sidechain, size_state ORDER BY day IS NULL, day, is_sidechain, size_state`,
    ...params,
  ).map((r) => ({ day: optStr(r, "day"), sidechain: sidechainOf(optNum(r, "is_sidechain")), sizeState: str(r, "size_state"), count: num(r, "n") }));
}

export function toolCallGroups(db: DatabaseSync, sessionFp?: string): ToolCallGroup[] {
  const where = sessionFp === undefined ? "" : "WHERE session_fp = ?";
  const params = sessionFp === undefined ? [] : [sessionFp];
  return all(
    db,
    `SELECT day, is_sidechain, tool_bucket, dedup, tool_id_fp IS NULL AS anonymous, COUNT(*) AS n FROM tool_calls ${where}
      GROUP BY day, is_sidechain, tool_bucket, dedup, anonymous ORDER BY day IS NULL, day, is_sidechain, tool_bucket, dedup, anonymous`,
    ...params,
  ).map((r) => ({
    day: optStr(r, "day"),
    sidechain: sidechainOf(optNum(r, "is_sidechain")),
    bucket: str(r, "tool_bucket"),
    dedup: str(r, "dedup"),
    anonymous: num(r, "anonymous") === 1,
    count: num(r, "n"),
  }));
}

/** Kept id-bearing calls grouped by how many occurrences share their id. */
export function toolGroupSizeCounts(db: DatabaseSync): { readonly size: number; readonly groups: number }[] {
  return all(
    db,
    `SELECT dedup_group_size AS size, COUNT(*) AS n FROM tool_calls
      WHERE dedup = 'kept' AND tool_id_fp IS NOT NULL GROUP BY dedup_group_size ORDER BY dedup_group_size`,
  ).map((r) => ({ size: num(r, "size"), groups: num(r, "n") }));
}

export interface SessionFactRow {
  /** Salted fingerprint, or null for facts with no session id. Server-side only. */
  readonly sessionFp: string | null;
  readonly userEvents: number;
  readonly toolOccurrences: number;
  readonly toolKept: number;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
}

const SESSION_FACTS = `
  SELECT session_fp, SUM(u) AS user_events, SUM(t) AS tool_occurrences, SUM(k) AS tool_kept,
         MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
    FROM (SELECT session_fp, COUNT(*) AS u, 0 AS t, 0 AS k, MIN(ts) AS first_ts, MAX(ts) AS last_ts
            FROM source_user_events GROUP BY session_fp
          UNION ALL
          SELECT session_fp, 0, COUNT(*), SUM(dedup = 'kept'), MIN(ts), MAX(ts)
            FROM tool_calls GROUP BY session_fp)`;

function toSessionRow(r: ReturnType<typeof all>[number]): SessionFactRow {
  return {
    sessionFp: optStr(r, "session_fp"),
    userEvents: num(r, "user_events"),
    toolOccurrences: num(r, "tool_occurrences"),
    toolKept: num(r, "tool_kept"),
    firstTimestamp: optStr(r, "first_ts"),
    lastTimestamp: optStr(r, "last_ts"),
  };
}

export function sessionFactCount(db: DatabaseSync): number {
  const row = one(db, "SELECT COUNT(*) AS n FROM (SELECT session_fp FROM source_user_events UNION SELECT session_fp FROM tool_calls)");
  return row ? num(row, "n") : 0;
}

/** Most recent activity first, then fingerprint, so paging is deterministic. Sessions with no timestamp come last. */
export function sessionFactPage(db: DatabaseSync, limit: number, offset: number): SessionFactRow[] {
  return all(
    db,
    `${SESSION_FACTS} GROUP BY session_fp ORDER BY last_ts IS NULL, last_ts DESC, session_fp IS NULL, session_fp LIMIT ? OFFSET ?`,
    limit,
    offset,
  ).map(toSessionRow);
}

export function sessionFactSummary(db: DatabaseSync, sessionFp: string): SessionFactRow | null {
  const row = one(db, `${SESSION_FACTS} WHERE session_fp = ? GROUP BY session_fp`, sessionFp);
  return row ? toSessionRow(row) : null;
}

/** Fingerprints starting with `prefix` (at most 2: enough to detect an ambiguous reference). */
export function sessionFpsWithPrefix(db: DatabaseSync, prefix: string): string[] {
  return all(
    db,
    `SELECT session_fp FROM (SELECT session_fp FROM source_user_events UNION SELECT session_fp FROM tool_calls)
      WHERE session_fp IS NOT NULL AND substr(session_fp, 1, ?) = ? ORDER BY session_fp LIMIT 2`,
    prefix.length,
    prefix,
  ).map((r) => str(r, "session_fp"));
}
