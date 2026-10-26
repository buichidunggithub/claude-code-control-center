/**
 * Source coverage and provenance: shapes the persisted per-source rows for the read-only API.
 *
 * Only what the stored data establishes is reported (see `store/coverage.ts`). A source is addressed by an opaque
 * reference derived from its stored fingerprint with a one-way hash; neither the fingerprint, the internal id, a label
 * nor a path leaves this module. Unknown enum values fail closed.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  latestCommittedRunId,
  listSourceCoverage,
  listSourceIdentities,
  listSourceResults,
  sourceCount,
  sourceCoverageById,
  sourceResultCount,
  usageRunById,
  type SourceCoverageRow,
  type SourceResultRow,
} from "../store";
import { SOURCE_OUTCOMES, isOneOf, kindOf, safeCode, safeTime } from "./history";
import type { SourceDetailQuery, SourcesQuery } from "./params";
import {
  SOURCE_COVERAGE_NOTE,
  type SourceCoveragePage,
  type SourceDetailReport,
  type SourceItem,
  type SourceOutcomeName,
  type SourceResultItem,
} from "./types";

const REF_CHARS = 32;

export function sourceRef(storedFingerprint: string): string {
  return createHash("sha256").update(`source-ref\0${storedFingerprint}`).digest("hex").slice(0, REF_CHARS);
}

function outcomesOf(raw: Readonly<Record<string, number>>): Record<SourceOutcomeName, number> {
  if (Object.keys(raw).some((k) => !isOneOf(SOURCE_OUTCOMES, k))) throw new TypeError("unknown source outcome");
  return { new: raw["new"] ?? 0, unchanged: raw["unchanged"] ?? 0, appended: raw["appended"] ?? 0, modified: raw["modified"] ?? 0, failed: raw["failed"] ?? 0 };
}

function toSourceItem(row: SourceCoverageRow, hasCommittedRun: boolean): SourceItem {
  if (row.latest !== null && !isOneOf(SOURCE_OUTCOMES, row.latest.outcome)) throw new TypeError("unknown source outcome");
  return {
    ref: sourceRef(row.fingerprint),
    firstSeen: { runId: row.firstSeenRunId, startedAt: safeTime(row.firstSeenAt) },
    lastRead: { runId: row.lastReadRunId, startedAt: safeTime(row.lastReadAt) },
    resultCount: row.resultCount,
    outcomes: outcomesOf(row.outcomeCounts),
    latestResult: row.latest && { runId: row.latest.runId, startedAt: safeTime(row.latest.startedAt), outcome: row.latest.outcome, errorCode: safeCode(row.latest.errorCode) },
    recordsStored: row.recordsStored,
    inLatestCommittedRun: hasCommittedRun ? row.resultsInLatestCommittedRun > 0 : null,
    historyIncomplete: row.resultsInFirstSeenRun === 0 || row.resultsInLastReadRun === 0,
  };
}

function latestCommittedRun(db: DatabaseSync, id: number | null): SourceCoveragePage["latestCommittedRun"] {
  const run = id === null ? null : usageRunById(db, id);
  return run === null ? null : { runId: run.id, startedAt: safeTime(run.startedAt), kind: kindOf(run) };
}

export function sourceCoverage(db: DatabaseSync, q: SourcesQuery): SourceCoveragePage {
  const latestId = latestCommittedRunId(db);
  return {
    limit: q.limit,
    offset: q.offset,
    total: sourceCount(db),
    items: listSourceCoverage(db, latestId, q.limit, q.offset).map((row) => toSourceItem(row, latestId !== null)),
    latestCommittedRun: latestCommittedRun(db, latestId),
    note: SOURCE_COVERAGE_NOTE,
  };
}

function toResultItem(r: SourceResultRow): SourceResultItem {
  if (!isOneOf(SOURCE_OUTCOMES, r.outcome)) throw new TypeError("unknown source outcome");
  const read = r.outcome !== "failed";
  return {
    run: { runId: r.runId, startedAt: safeTime(r.runStartedAt), kind: kindOf({ status: r.runStatus, errorCode: r.runErrorCode }) },
    outcome: r.outcome,
    errorCode: safeCode(r.errorCode),
    anonymousIdentityUncertain: r.anonymousIdentityUncertain,
    counts: read
      ? {
          recordsInserted: r.recordsInserted,
          recordsRemoved: r.recordsRemoved,
          recordsRetained: r.recordsRetained,
          usageRecordsParsed: r.usageRecordsParsed,
          skippedLines: { blank: r.blankLines, malformed: r.malformedLines, oversized: r.oversizedLines, nonObject: r.nonObjectLines, usageObjectsMalformed: r.usageObjectsMalformed },
          eventsWithoutUsage: r.eventsWithoutUsage,
          unusableTimestamps: r.unusableTimestamps,
          unrecognizedUsageKeys: r.unrecognizedUsageKeys,
        }
      : null,
  };
}

export function sourceDetail(db: DatabaseSync, q: SourceDetailQuery): SourceDetailReport {
  const matches = listSourceIdentities(db).filter((s) => sourceRef(s.fingerprint) === q.ref);
  // An ambiguous reference (a hash collision) is treated as unknown rather than guessed.
  const found = matches.length === 1 ? matches[0] : undefined;
  const latestId = latestCommittedRunId(db);
  const row = found === undefined ? null : sourceCoverageById(db, latestId, found.id);
  return {
    source: row === null ? null : toSourceItem(row, latestId !== null),
    historyPage: { limit: q.limit, offset: q.offset, total: found === undefined ? 0 : sourceResultCount(db, found.id) },
    history: found === undefined ? [] : listSourceResults(db, found.id, q.limit, q.offset).map(toResultItem),
    note: SOURCE_COVERAGE_NOTE,
  };
}
