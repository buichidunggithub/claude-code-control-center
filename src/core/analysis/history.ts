/**
 * Run history: shapes the persisted `scan_runs` / `source_scan_results` rows for the read-only API.
 *
 * Only stored values are reported. A counter is reported only when the run recorded it: counters are written
 * once, when a scan finishes and commits, so a rolled-back or unfinished run has none and shows `null`
 * rather than the column default of 0. Anything not in a known set (status, outcome, code, timestamp) fails
 * closed instead of echoing database text.
 */
import type { DatabaseSync } from "node:sqlite";
import { listUsageRuns, scanDiagnostics, usageRunById, usageRunCount, type UsageRunRow } from "../store";
import { countBy } from "./counts";
import type { RunDetailQuery, RunsQuery } from "./params";
import { RUN_HISTORY_NOTE, type RunDetailReport, type RunHistoryPage, type RunItem, type RunKind, type RunSourceItem } from "./types";

const RUN_STATUSES = ["running", "complete", "partial", "failed"] as const;
export const SOURCE_OUTCOMES = ["new", "unchanged", "appended", "modified", "failed"] as const;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export const isOneOf = <T extends string>(set: readonly T[], value: string): value is T => (set as readonly string[]).includes(value);

/** Codes are written by this app as fixed words; anything else is replaced, never shown. */
export const safeCode = (code: string | null): string | null => (code === null ? null : CODE_PATTERN.test(code) ? code : "UNKNOWN_CODE");
export const safeTime = (value: string | null): string | null => (value !== null && ISO_PATTERN.test(value) ? value : null);

export function kindOf(run: Pick<UsageRunRow, "status" | "errorCode">): RunKind {
  if (!isOneOf(RUN_STATUSES, run.status)) throw new TypeError("unknown run status");
  if (run.status === "running") return "unfinished";
  // A run-level error is recorded only when the scan transaction was rolled back.
  if (run.status === "failed" && run.errorCode !== null) return "rolled-back";
  return run.status;
}

function toRunItem(run: UsageRunRow): RunItem {
  const kind = kindOf(run);
  const recorded = kind === "complete" || kind === "partial" || kind === "failed";
  return {
    id: run.id,
    kind,
    startedAt: safeTime(run.startedAt),
    finishedAt: safeTime(run.finishedAt),
    errorCode: safeCode(run.errorCode),
    sourcesRequested: run.sourcesRequested,
    counts: recorded
      ? {
          sources: { new: run.sourcesNew, unchanged: run.sourcesUnchanged, appended: run.sourcesAppended, modified: run.sourcesModified, failed: run.sourcesFailed },
          recordsInserted: run.recordsInserted,
          recordsRemoved: run.recordsRemoved,
        }
      : null,
  };
}

export function runHistory(db: DatabaseSync, q: RunsQuery): RunHistoryPage {
  return { limit: q.limit, offset: q.offset, total: usageRunCount(db), items: listUsageRuns(db, q.limit, q.offset).map(toRunItem), note: RUN_HISTORY_NOTE };
}

export function runDetail(db: DatabaseSync, q: RunDetailQuery): RunDetailReport {
  const stored = usageRunById(db, q.id);
  const diagnostics = stored === null ? null : scanDiagnostics(db, q.id);
  const all: RunSourceItem[] = (diagnostics?.sources ?? []).map((s, index) => {
    if (!isOneOf(SOURCE_OUTCOMES, s.outcome)) throw new TypeError("unknown source outcome");
    return {
      ordinal: index + 1,
      outcome: s.outcome,
      errorCode: safeCode(s.errorCode),
      anonymousIdentityUncertain: s.anonymousIdentityUncertain,
      recordsInserted: s.recordsInserted,
      recordsRemoved: s.recordsRemoved,
      recordsRetained: s.recordsRetained,
      usageRecordsParsed: s.usageRecordsParsed,
      skippedLines: s.skipped,
      eventsWithoutUsage: s.eventsWithoutUsage,
      unusableTimestamps: s.unusableTimestamps,
      unrecognizedUsageKeys: s.unrecognizedUsageKeyCount,
    };
  });
  return {
    run: stored === null ? null : toRunItem(stored),
    sourceErrorCodes: countBy(all.filter((s) => s.errorCode !== null), (s) => s.errorCode ?? "UNKNOWN_CODE"),
    anonymousIdentityUncertainSources: all.filter((s) => s.anonymousIdentityUncertain).length,
    sourcePage: { limit: q.limit, offset: q.offset, total: all.length },
    sources: all.slice(q.offset, q.offset + q.limit),
  };
}
