/**
 * Event-facts analytics: shapes grouped counts from the persisted facts into API payloads.
 *
 * Nothing here reads usage records or token columns. Stored vocabulary values are validated and an unknown
 * one fails the whole query closed (the caller reports QUERY_FAILED) instead of echoing database text.
 * Session fingerprints are reduced to the same 16-character opaque prefix the usage sessions API uses.
 */
import type { DatabaseSync } from "node:sqlite";
import { TEXT_LENGTH_STATES, TOOL_BUCKETS, type TextLengthState, type ToolBucket } from "../parse";
import {
  CURRENT_FACTS_VERSION,
  factsCoverageCounts,
  sessionFactCount,
  sessionFactPage,
  sessionFactSummary,
  sessionFpsWithPrefix,
  toolCallGroups,
  toolGroupSizeCounts,
  userEventGroups,
  type SessionFactRow,
  type ToolCallGroup,
  type UserEventGroup,
} from "../store";
import type { SessionDetailQuery, TrendsQuery } from "./analytics-params";
import {
  ANALYTICS_NOTE,
  ANALYTICS_VALIDATION,
  type AnalyticsBase,
  type AnalyticsSessionDetail,
  type AnalyticsSessions,
  type AnalyticsSummary,
  type AnalyticsTools,
  type AnalyticsTrends,
  type DayFacts,
  type FactsCoverage,
  type FactsSlice,
  type SidechainCounts,
  type SizeStateCounts,
  type ToolBucketRow,
  type ToolCallSummary,
  type UserEventSummary,
  type SessionFactsItem,
} from "./analytics-types";
import type { PageParams } from "./params";

const SESSION_ID_CHARS = 16;
const GROUP_SIZE_CAP = 10;
const GROUP_SIZE_OVERFLOW_KEY = `${GROUP_SIZE_CAP}+`;

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T => (values as readonly string[]).includes(value);

function sizeState(value: string): TextLengthState {
  if (!isOneOf(TEXT_LENGTH_STATES, value)) throw new TypeError("unknown size state");
  return value;
}

function toolBucket(value: string): ToolBucket {
  if (!isOneOf(TOOL_BUCKETS, value)) throw new TypeError("unknown tool bucket");
  return value;
}

function dedupState(value: string): "kept" | "duplicate" {
  if (value !== "kept" && value !== "duplicate") throw new TypeError("unknown dedup state");
  return value;
}

const zeroSizes = (): Record<TextLengthState, number> => Object.fromEntries(TEXT_LENGTH_STATES.map((s) => [s, 0])) as Record<TextLengthState, number>;

/** A mutable tally that never leaves this module: callers receive frozen-shape copies from `toSlice`. */
interface Tally {
  userEvents: number;
  sidechain: number;
  main: number;
  unknown: number;
  sizes: Record<TextLengthState, number>;
  toolOccurrences: number;
  toolKept: number;
  toolDuplicates: number;
}

const newTally = (): Tally => ({ userEvents: 0, sidechain: 0, main: 0, unknown: 0, sizes: zeroSizes(), toolOccurrences: 0, toolKept: 0, toolDuplicates: 0 });

function addUserEvents(tally: Tally, group: UserEventGroup): void {
  tally.userEvents += group.count;
  if (group.sidechain === null) tally.unknown += group.count;
  else if (group.sidechain) tally.sidechain += group.count;
  else tally.main += group.count;
  tally.sizes[sizeState(group.sizeState)] += group.count;
}

function addToolCalls(tally: Tally, group: ToolCallGroup): void {
  toolBucket(group.bucket);
  tally.toolOccurrences += group.count;
  if (dedupState(group.dedup) === "kept") tally.toolKept += group.count;
  else tally.toolDuplicates += group.count;
}

const sidechainOf = (t: Tally): SidechainCounts => ({ sidechain: t.sidechain, main: t.main, unknown: t.unknown });

function toSlice(t: Tally): FactsSlice {
  return {
    userEvents: t.userEvents,
    userEventsBySidechain: sidechainOf(t),
    sizeStates: { ...t.sizes },
    toolOccurrences: t.toolOccurrences,
    toolKept: t.toolKept,
    toolDuplicates: t.toolDuplicates,
  };
}

function coverageOf(db: DatabaseSync): FactsCoverage {
  const c = factsCoverageCounts(db);
  return {
    currentFactsVersion: CURRENT_FACTS_VERSION,
    sources: c.sources,
    collected: c.current,
    outdated: c.outdated,
    notCollected: c.neverCollected,
    complete: c.sources === 0 ? null : c.current === c.sources,
  };
}

function baseOf(db: DatabaseSync): AnalyticsBase {
  const coverage = coverageOf(db);
  return {
    validation: ANALYTICS_VALIDATION,
    note: ANALYTICS_NOTE,
    state: coverage.collected + coverage.outdated > 0 ? "collected" : "none-collected",
    coverage,
  };
}

function groupSizesOf(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries([...Array.from({ length: GROUP_SIZE_CAP - 1 }, (_, i) => [String(i + 1), 0]), [GROUP_SIZE_OVERFLOW_KEY, 0]]);
  for (const { size, groups } of toolGroupSizeCounts(db)) {
    const key = size >= GROUP_SIZE_CAP ? GROUP_SIZE_OVERFLOW_KEY : String(size);
    out[key] = (out[key] ?? 0) + groups;
  }
  return out;
}

function bucketRows(groups: readonly ToolCallGroup[]): ToolBucketRow[] {
  const rows = new Map<ToolBucket, { occurrences: number; kept: number; duplicates: number }>(TOOL_BUCKETS.map((b) => [b, { occurrences: 0, kept: 0, duplicates: 0 }]));
  for (const g of groups) {
    const row = rows.get(toolBucket(g.bucket));
    if (!row) continue;
    row.occurrences += g.count;
    if (dedupState(g.dedup) === "kept") row.kept += g.count;
    else row.duplicates += g.count;
  }
  return TOOL_BUCKETS.map((bucket) => ({ bucket, ...(rows.get(bucket) ?? { occurrences: 0, kept: 0, duplicates: 0 }) }));
}

function toolSummary(db: DatabaseSync, groups: readonly ToolCallGroup[]): ToolCallSummary {
  const t = newTally();
  let anonymous = 0;
  for (const g of groups) {
    addToolCalls(t, g);
    if (g.anonymous) anonymous += g.count;
  }
  return { occurrences: t.toolOccurrences, kept: t.toolKept, duplicates: t.toolDuplicates, anonymous, groupSizes: groupSizesOf(db) };
}

export function analyticsSummary(db: DatabaseSync): AnalyticsSummary {
  const base = baseOf(db);
  if (base.state === "none-collected") return { ...base, userEvents: null, toolCalls: null };
  const t = newTally();
  const events = userEventGroups(db);
  for (const g of events) addUserEvents(t, g);
  const userEvents: UserEventSummary = {
    total: t.userEvents,
    bySidechain: sidechainOf(t),
    sizeStates: { ...t.sizes },
    undated: events.filter((g) => g.day === null).reduce((n, g) => n + g.count, 0),
  };
  return { ...base, userEvents, toolCalls: toolSummary(db, toolCallGroups(db)) };
}

export function analyticsTools(db: DatabaseSync): AnalyticsTools {
  const base = baseOf(db);
  if (base.state === "none-collected") return { ...base, toolCalls: null };
  const groups = toolCallGroups(db);
  return { ...base, toolCalls: { ...toolSummary(db, groups), byBucket: bucketRows(groups) } };
}

/** Day tallies from both fact kinds, newest day first; facts with no day are returned separately. */
function dayTallies(events: readonly UserEventGroup[], tools: readonly ToolCallGroup[]): { days: DayFacts[]; undated: FactsSlice | null } {
  const byDay = new Map<string | null, Tally>();
  const tallyFor = (day: string | null): Tally => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const created = newTally();
    byDay.set(day, created);
    return created;
  };
  for (const g of events) addUserEvents(tallyFor(g.day), g);
  for (const g of tools) addToolCalls(tallyFor(g.day), g);
  const days = [...byDay.entries()]
    .flatMap(([day, tally]) => (day === null ? [] : [{ day, ...toSlice(tally) }]))
    .sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1));
  const undated = byDay.get(null);
  return { days, undated: undated ? toSlice(undated) : null };
}

export function analyticsTrends(db: DatabaseSync, q: TrendsQuery): AnalyticsTrends {
  const base = baseOf(db);
  const page = { from: q.from, to: q.to, limit: q.limit, offset: q.offset };
  if (base.state === "none-collected") return { ...base, ...page, total: 0, items: [], undated: null };
  const { days, undated } = dayTallies(userEventGroups(db), toolCallGroups(db));
  const inRange = days.filter((d) => (q.from === null || d.day >= q.from) && (q.to === null || d.day <= q.to));
  return { ...base, ...page, total: inRange.length, items: inRange.slice(q.offset, q.offset + q.limit), undated };
}

function toSessionItem(row: SessionFactRow): SessionFactsItem {
  return {
    id: row.sessionFp === null ? null : row.sessionFp.slice(0, SESSION_ID_CHARS),
    userEvents: row.userEvents,
    toolOccurrences: row.toolOccurrences,
    toolKept: row.toolKept,
    firstTimestamp: row.firstTimestamp,
    lastTimestamp: row.lastTimestamp,
  };
}

export function analyticsSessions(db: DatabaseSync, q: PageParams): AnalyticsSessions {
  const base = baseOf(db);
  if (base.state === "none-collected") return { ...base, limit: q.limit, offset: q.offset, total: 0, items: [] };
  return { ...base, limit: q.limit, offset: q.offset, total: sessionFactCount(db), items: sessionFactPage(db, q.limit, q.offset).map(toSessionItem) };
}

export function analyticsSessionDetail(db: DatabaseSync, q: SessionDetailQuery): AnalyticsSessionDetail {
  const base = baseOf(db);
  const absent = (total: number): AnalyticsSessionDetail => ({
    ...base,
    session: null,
    sizeStates: null,
    toolBuckets: null,
    daysPage: { limit: q.limit, offset: q.offset, total },
    days: [],
  });
  if (base.state === "none-collected") return absent(0);
  // An ambiguous reference (two fingerprints sharing the prefix) is treated as unknown rather than guessed.
  const matches = sessionFpsWithPrefix(db, q.id);
  const fp = matches.length === 1 ? matches[0] : undefined;
  const summary = fp === undefined ? null : sessionFactSummary(db, fp);
  if (fp === undefined || summary === null) return absent(0);

  const events = userEventGroups(db, fp);
  const tools = toolCallGroups(db, fp);
  const sizes = newTally();
  for (const g of events) addUserEvents(sizes, g);
  const { days } = dayTallies(events, tools);
  return {
    ...base,
    session: toSessionItem(summary),
    sizeStates: { ...sizes.sizes } satisfies SizeStateCounts,
    toolBuckets: bucketRows(tools),
    daysPage: { limit: q.limit, offset: q.offset, total: days.length },
    days: days.slice(q.offset, q.offset + q.limit),
  };
}
