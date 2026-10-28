/**
 * Response contracts of the event-facts analytics API.
 *
 * Everything here is OBSERVED SOURCE STRUCTURE, not yet validated against real Claude Code transcripts. A
 * "user event" is an event whose source type is "user"; it is not a verified prompt or turn. Prompt-size
 * states are optional heuristics, and `not-read` / `unsupported` are never a zero length. No field is a token
 * figure: these facts are independent of settled usage accounting. Payloads hold counts, fixed vocabulary
 * words and opaque references only.
 */
import type { TextLengthState, ToolBucket } from "../parse";
import type { Page } from "./types";

export const ANALYTICS_VALIDATION = "unverified-source-structure" as const;

export const ANALYTICS_NOTE =
  "Observed source structure, not yet validated against real Claude Code transcripts. A user event is an event whose source type is 'user': it is not a verified prompt or turn, and no prompt, turn, retry, success or productivity count is made. Prompt size is an optional heuristic: 'not-read' means content was never read and 'unsupported' means it was read but is not supported text; neither is a zero length. Tool calls are counted per recorded occurrence and, separately, once per tool-use id ('kept'). Figures cover only the sources whose facts have been collected (see coverage) and are independent of token accounting.";

export interface FactsCoverage {
  readonly currentFactsVersion: number;
  readonly sources: number;
  /** Facts collected by the current logic. */
  readonly collected: number;
  /** Facts collected by older logic. They are included in the figures. */
  readonly outdated: number;
  /** Facts never collected (every source stored before facts existed, until it is named in an ingest). Excluded from the figures. */
  readonly notCollected: number;
  /** true only when every stored source is collected by the current logic; null when there are no sources. */
  readonly complete: boolean | null;
}

/** `none-collected`: no source has facts, so every figure is absent (null or empty), never zero. */
export type FactsState = "collected" | "none-collected";

export interface AnalyticsBase {
  readonly validation: typeof ANALYTICS_VALIDATION;
  readonly note: string;
  readonly state: FactsState;
  readonly coverage: FactsCoverage;
}

export type SizeStateCounts = Readonly<Record<TextLengthState, number>>;

/** `unknown`: the event did not say whether it was a sidechain. */
export interface SidechainCounts {
  readonly sidechain: number;
  readonly main: number;
  readonly unknown: number;
}

export interface UserEventSummary {
  readonly total: number;
  readonly bySidechain: SidechainCounts;
  readonly sizeStates: SizeStateCounts;
  /** Events with no usable timestamp (they appear in no day). */
  readonly undated: number;
}

export interface ToolOccurrenceCounts {
  /** Every recorded tool_use block, repeats included. */
  readonly occurrences: number;
  /** One per tool-use id plus every call without an id. */
  readonly kept: number;
  readonly duplicates: number;
}

export interface ToolCallSummary extends ToolOccurrenceCounts {
  /** Calls with no recorded id: never merged, always kept. Included in `kept`. */
  readonly anonymous: number;
  /** Kept id-bearing calls by how many occurrences share the id: keys "1".."9" and "10+". */
  readonly groupSizes: Readonly<Record<string, number>>;
}

export interface AnalyticsSummary extends AnalyticsBase {
  readonly userEvents: UserEventSummary | null;
  readonly toolCalls: ToolCallSummary | null;
}

/** Counts for one slice (a UTC day, or the facts without a usable timestamp). */
export interface FactsSlice {
  readonly userEvents: number;
  readonly userEventsBySidechain: SidechainCounts;
  readonly sizeStates: SizeStateCounts;
  readonly toolOccurrences: number;
  readonly toolKept: number;
  readonly toolDuplicates: number;
}

export interface DayFacts extends FactsSlice {
  /** UTC calendar day. */
  readonly day: string;
}

export interface AnalyticsTrends extends AnalyticsBase, Page {
  readonly from: string | null;
  readonly to: string | null;
  /** Newest day first. Empty when `state` is `none-collected`. */
  readonly items: readonly DayFacts[];
  /** Facts with no usable timestamp; never filtered by the range. null when there are none. */
  readonly undated: FactsSlice | null;
}

export interface ToolBucketRow extends ToolOccurrenceCounts {
  readonly bucket: ToolBucket;
}

export interface AnalyticsTools extends AnalyticsBase {
  /** One row per bucket in a fixed order, counted zeros included. null when `state` is `none-collected`. */
  readonly toolCalls: (ToolCallSummary & { readonly byBucket: readonly ToolBucketRow[] }) | null;
}

export interface SessionFactsItem {
  /** Opaque, salted fingerprint prefix. Not a Claude session id. null: facts with no session id. */
  readonly id: string | null;
  readonly userEvents: number;
  readonly toolOccurrences: number;
  readonly toolKept: number;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
}

export interface AnalyticsSessions extends AnalyticsBase, Page {
  /** Most recent activity first. Empty when `state` is `none-collected`. */
  readonly items: readonly SessionFactsItem[];
}

export interface AnalyticsSessionDetail extends AnalyticsBase {
  /** null when no session has this reference (or it matches more than one). */
  readonly session: SessionFactsItem | null;
  readonly sizeStates: SizeStateCounts | null;
  readonly toolBuckets: readonly ToolBucketRow[] | null;
  /** Days of this session, newest first; the page applies to these. */
  readonly daysPage: Page;
  readonly days: readonly DayFacts[];
}
