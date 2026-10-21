import type { DatabaseSync } from "node:sqlite";
import type { AccountingSummary, TokenSums } from "../parse";
import { TOKEN_FIELDS, type AccountingState, type TokenFieldName } from "../parse/types";
import { TOKEN_COLUMN_PREFIX } from "./reconcile";
import { all, num, one, optStr, str, type Row } from "./sql";

export interface AggregateOptions {
  readonly includeSidechain?: boolean;
}

export interface SettledGroup<K> {
  readonly key: K | null;
  readonly records: number;
  readonly tokens: TokenSums;
}

export interface SettledSessionGroup extends SettledGroup<string> {
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
}

const PREFIXES = TOKEN_FIELDS.map((f) => [f, TOKEN_COLUMN_PREFIX[f]] as const);

// Only fixed strings are interpolated below; every user-visible value is bound as a parameter.
const sidechain = (o: AggregateOptions) => (o.includeSidechain === false ? "AND (ur.is_sidechain IS NULL OR ur.is_sidechain = 0)" : "");
const sumColumns = PREFIXES.map(([, p]) => `COALESCE(SUM(ur.${p}_value), 0) AS ${p}_sum`).join(", ");

function tokensFrom(row: Row, suffix: string): TokenSums {
  return Object.fromEntries(PREFIXES.map(([field, p]) => [field, num(row, `${p}${suffix}`)])) as Record<TokenFieldName, number>;
}

function settledBy(db: DatabaseSync, groupSql: string, joinSql: string, options: AggregateOptions, extra = "") {
  return all(
    db,
    `SELECT ${groupSql} AS k, COUNT(*) AS records, ${sumColumns}${extra}
       FROM usage_records ur ${joinSql}
      WHERE ur.accounting = 'accepted' ${sidechain(options)}
      GROUP BY k ORDER BY k IS NULL, k`,
  );
}

const keyed = (row: Row) => optStr(row, "k");

/** Settled = accepted records only. Conflicting and ambiguous usage is never included here. */
export function settledByModel(db: DatabaseSync, options: AggregateOptions = {}): SettledGroup<string>[] {
  return settledBy(db, "ur.model", "", options).map((row) => ({ key: keyed(row), records: num(row, "records"), tokens: tokensFrom(row, "_sum") }));
}

/** Dates are UTC calendar days (YYYY-MM-DD); records with no usable timestamp land under a null key. */
export function settledByDate(db: DatabaseSync, options: AggregateOptions = {}): SettledGroup<string>[] {
  return settledBy(db, "ur.day", "", options).map((row) => ({ key: keyed(row), records: num(row, "records"), tokens: tokensFrom(row, "_sum") }));
}

/** Session keys are salted fingerprints, not the source session ids. */
export function settledBySession(db: DatabaseSync, options: AggregateOptions = {}): SettledSessionGroup[] {
  return settledBy(db, "s.fingerprint", "LEFT JOIN sessions s ON s.id = ur.session_id", options, ", MIN(ur.ts) AS first_ts, MAX(ur.ts) AS last_ts").map((row) => ({
    key: keyed(row),
    records: num(row, "records"),
    tokens: tokensFrom(row, "_sum"),
    firstTimestamp: optStr(row, "first_ts"),
    lastTimestamp: optStr(row, "last_ts"),
  }));
}

/** Same shape and meaning as the in-memory `summarizeAccounting`, computed from stored rows. */
export function accountingSummary(db: DatabaseSync, options: AggregateOptions = {}): AccountingSummary {
  const sc = sidechain(options);
  const settled = one(db, `SELECT COUNT(*) AS records, ${sumColumns} FROM usage_records ur WHERE ur.accounting = 'accepted' ${sc}`);
  const lowHigh = PREFIXES.map(([, p]) => `MIN(COALESCE(ur.${p}_value, 0)) AS ${p}_lo, MAX(COALESCE(ur.${p}_value, 0)) AS ${p}_hi`).join(", ");
  const sumOf = (suffix: string) => PREFIXES.map(([, p]) => `COALESCE(SUM(${p}${suffix}), 0) AS ${p}${suffix}`).join(", ");
  const conflicting = one(
    db,
    `SELECT COUNT(*) AS grp, ${sumOf("_lo")}, ${sumOf("_hi")} FROM (
       SELECT ${lowHigh} FROM usage_records ur WHERE ur.accounting = 'conflicting' ${sc} GROUP BY ur.event_key_fp)`,
  );
  const columns = PREFIXES.map(([, p]) => `ur.${p}_state, ur.${p}_value`).join(", ");
  const ambiguousAll = one(db, `SELECT COUNT(*) AS records, ${sumColumns} FROM usage_records ur WHERE ur.accounting = 'ambiguous' ${sc}`);
  const ambiguousDistinct = one(
    db,
    `SELECT ${PREFIXES.map(([, p]) => `COALESCE(SUM(${p}_value), 0) AS ${p}_sum`).join(", ")} FROM (
       SELECT DISTINCT ${columns} FROM usage_records ur WHERE ur.accounting = 'ambiguous' ${sc})`,
  );
  const duplicates = one(db, `SELECT COUNT(*) AS n FROM usage_records ur WHERE ur.accounting = 'duplicate' ${sc}`);
  if (!settled || !conflicting || !ambiguousAll || !ambiguousDistinct || !duplicates) throw new TypeError("aggregate query returned no row");

  return {
    settled: { ...tokensFrom(settled, "_sum"), records: num(settled, "records") },
    conflicting: { groups: num(conflicting, "grp"), lower: tokensFrom(conflicting, "_lo"), upper: tokensFrom(conflicting, "_hi") },
    ambiguous: { records: num(ambiguousAll, "records"), ifRepeats: tokensFrom(ambiguousDistinct, "_sum"), ifDistinct: tokensFrom(ambiguousAll, "_sum") },
    duplicates: num(duplicates, "n"),
  };
}

export function accountingStateCounts(db: DatabaseSync): Record<AccountingState, number> {
  const counts: Record<AccountingState, number> = { accepted: 0, duplicate: 0, conflicting: 0, ambiguous: 0 };
  for (const row of all(db, "SELECT accounting, COUNT(*) AS n FROM usage_records GROUP BY accounting")) {
    counts[str(row, "accounting") as AccountingState] = num(row, "n");
  }
  return counts;
}

/** Raw counter states across every stored record: missing, null, invalid and value stay distinct. */
export function tokenFieldStateCounts(db: DatabaseSync): Record<TokenFieldName, Record<"missing" | "null" | "invalid" | "value", number>> {
  return Object.fromEntries(
    PREFIXES.map(([field, p]) => {
      const counts = { missing: 0, null: 0, invalid: 0, value: 0 };
      for (const row of all(db, `SELECT ${p}_state AS s, COUNT(*) AS n FROM usage_records GROUP BY ${p}_state`)) {
        counts[str(row, "s") as keyof typeof counts] = num(row, "n");
      }
      return [field, counts];
    }),
  ) as Record<TokenFieldName, Record<"missing" | "null" | "invalid" | "value", number>>;
}

export interface SourceDiagnostics {
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly anonymousIdentityUncertain: boolean;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
  readonly recordsRetained: number;
  readonly skipped: { readonly blank: number; readonly malformed: number; readonly oversized: number; readonly nonObject: number; readonly usageObjectsMalformed: number };
  readonly eventsWithoutUsage: number;
  readonly unusableTimestamps: number;
  readonly unrecognizedUsageKeyCount: number;
  readonly usageRecordsParsed: number;
}

export interface ScanDiagnostics {
  readonly scanRunId: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly sources: readonly SourceDiagnostics[];
}

/** Diagnostics for one scan run (default: the latest). Counts and codes only. */
export function scanDiagnostics(db: DatabaseSync, scanRunId?: number): ScanDiagnostics | null {
  const run = scanRunId === undefined ? one(db, "SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1") : one(db, "SELECT * FROM scan_runs WHERE id = ?", scanRunId);
  if (!run) return null;
  const id = num(run, "id");
  return {
    scanRunId: id,
    status: str(run, "status"),
    errorCode: optStr(run, "error_code"),
    sources: all(db, "SELECT * FROM source_scan_results WHERE scan_run_id = ? ORDER BY id", id).map((r) => ({
      outcome: str(r, "outcome"),
      errorCode: optStr(r, "error_code"),
      anonymousIdentityUncertain: num(r, "anonymous_identity_uncertain") === 1,
      recordsInserted: num(r, "records_inserted"),
      recordsRemoved: num(r, "records_removed"),
      recordsRetained: num(r, "records_retained"),
      skipped: { blank: num(r, "blank_lines"), malformed: num(r, "malformed_lines"), oversized: num(r, "oversized_lines"), nonObject: num(r, "non_object_lines"), usageObjectsMalformed: num(r, "usage_objects_malformed") },
      eventsWithoutUsage: num(r, "events_without_usage"),
      unusableTimestamps: num(r, "unusable_timestamps"),
      unrecognizedUsageKeyCount: num(r, "unrecognized_usage_key_count"),
      usageRecordsParsed: num(r, "usage_records_parsed"),
    })),
  };
}
