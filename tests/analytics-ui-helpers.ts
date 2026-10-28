import type {
  AnalyticsBase,
  AnalyticsSessionDetail,
  AnalyticsSessions,
  AnalyticsSummary,
  AnalyticsTools,
  AnalyticsTrends,
  ApiEnvelope,
  DataState,
  FactsCoverage,
  FactsSlice,
  SessionFactsItem,
  SizeStateCounts,
} from "@/core/analysis";
import { ANALYTICS_NOTE, ANALYTICS_VALIDATION } from "@/core/analysis";
import { TEXT_LENGTH_STATES, TOOL_BUCKETS } from "@/core/parse";

export const ok = <T,>(data: T): ApiEnvelope<T> => ({ state: "ok", data, errorCode: null });
export const notOk = <T,>(state: Exclude<DataState, "ok">, errorCode: string | null): ApiEnvelope<T> => ({ state, data: null, errorCode });

export const coverage = (over: Partial<FactsCoverage> = {}): FactsCoverage => ({
  currentFactsVersion: 1, sources: 3, collected: 3, outdated: 0, notCollected: 0, complete: true, ...over,
});

export const sizes = (over: Partial<Record<(typeof TEXT_LENGTH_STATES)[number], number>> = {}): SizeStateCounts =>
  Object.fromEntries(TEXT_LENGTH_STATES.map((s) => [s, over[s] ?? 0])) as SizeStateCounts;

export const baseOf = (cov: FactsCoverage, state: AnalyticsBase["state"] = "collected"): AnalyticsBase => ({
  validation: ANALYTICS_VALIDATION, note: ANALYTICS_NOTE, state, coverage: cov,
});

export function summaryOf(over: Partial<AnalyticsSummary> = {}, cov: FactsCoverage = coverage()): AnalyticsSummary {
  return {
    ...baseOf(cov),
    userEvents: { total: 12, bySidechain: { sidechain: 1, main: 2, unknown: 9 }, sizeStates: sizes({ empty: 1, xs: 4, s: 1, unsupported: 6 }), undated: 0 },
    toolCalls: { occurrences: 11, kept: 9, duplicates: 2, anonymous: 1, groupSizes: { "1": 6, "2": 2, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0, "10+": 0 } },
    ...over,
  };
}

export const noFacts = (cov: FactsCoverage): AnalyticsSummary => ({ ...baseOf(cov, "none-collected"), userEvents: null, toolCalls: null });

export function toolsOf(over: Partial<NonNullable<AnalyticsTools["toolCalls"]>> = {}): AnalyticsTools {
  const rows = TOOL_BUCKETS.map((bucket) => {
    const table: Record<string, [number, number, number]> = { Read: [5, 4, 1], Bash: [3, 3, 0], other: [2, 1, 1], unknown: [1, 1, 0] };
    const [occurrences, kept, duplicates] = table[bucket] ?? [0, 0, 0];
    return { bucket, occurrences, kept, duplicates };
  });
  return {
    ...baseOf(coverage()),
    toolCalls: { occurrences: 11, kept: 9, duplicates: 2, anonymous: 1, groupSizes: { "1": 6, "2": 2, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0, "10+": 1 }, byBucket: rows, ...over },
  };
}

export const slice = (over: Partial<FactsSlice> = {}): FactsSlice => ({
  userEvents: 4, userEventsBySidechain: { sidechain: 1, main: 1, unknown: 2 }, sizeStates: sizes({ xs: 1, "not-read": 3 }), toolOccurrences: 5, toolKept: 4, toolDuplicates: 1, ...over,
});

export function trendsOf(over: Partial<AnalyticsTrends> = {}): AnalyticsTrends {
  return {
    ...baseOf(coverage()), from: null, to: null, limit: 50, offset: 0, total: 2,
    items: [{ day: "2026-04-01", ...slice() }, { day: "2026-01-10", ...slice({ userEvents: 2, sizeStates: sizes({ unsupported: 2 }), toolOccurrences: 0, toolKept: 0, toolDuplicates: 0 }) }],
    undated: null, ...over,
  };
}

export const REF_A = "0123456789abcdef";
export const REF_B = "fedcba9876543210";

export const sessionItem = (id: string | null, over: Partial<SessionFactsItem> = {}): SessionFactsItem => ({
  id, userEvents: 3, toolOccurrences: 4, toolKept: 3, firstTimestamp: "2026-04-01T00:00:01.000Z", lastTimestamp: "2026-04-01T00:00:13.000Z", ...over,
});

export function sessionsOf(over: Partial<AnalyticsSessions> = {}): AnalyticsSessions {
  return { ...baseOf(coverage()), limit: 50, offset: 0, total: 2, items: [sessionItem(REF_A), sessionItem(REF_B)], ...over };
}

export function detailOf(over: Partial<AnalyticsSessionDetail> = {}): AnalyticsSessionDetail {
  return {
    ...baseOf(coverage()),
    session: sessionItem(REF_A), sizeStates: sizes({ xs: 2, "not-read": 1 }),
    toolBuckets: TOOL_BUCKETS.map((bucket) => ({ bucket, occurrences: bucket === "Read" ? 4 : 0, kept: bucket === "Read" ? 3 : 0, duplicates: bucket === "Read" ? 1 : 0 })),
    daysPage: { limit: 50, offset: 0, total: 1 },
    days: [{ day: "2026-04-01", ...slice({ userEvents: 3, toolOccurrences: 4, toolKept: 3, toolDuplicates: 1 }) }],
    ...over,
  };
}
