/**
 * Response contracts of the read-only analysis API. Every payload is built from counts, fixed code
 * words, opaque ids and rule metadata. No paths, file text, commands, env values or salts.
 */
import type { AccountingState, TokenFieldName } from "../parse/types";
import type { Recommendation, RuleEvaluation } from "../recommend";
import type { ConfigScanStatus, UsageScanStatus } from "../store";

/**
 * - ok: data present.
 * - no-database: no database file exists at the configured location (nothing was created).
 * - no-completed-scan: the database is usable but holds no completed scan for this section.
 * - unavailable: the database exists but cannot be used; `errorCode` says why (fixed codes only).
 */
export type DataState = "ok" | "no-database" | "no-completed-scan" | "unavailable";

export interface ApiEnvelope<T> {
  readonly state: DataState;
  readonly data: T | null;
  readonly errorCode: string | null;
}

export type SidechainMode = "include" | "exclude";
export type TokenTotals = Readonly<Record<TokenFieldName, number>>;
export type FieldStates = Readonly<Record<"missing" | "null" | "invalid" | "value", number>>;

export interface Page {
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

export interface SourceBreakdown {
  readonly key: string | null;
  readonly records: number;
  readonly tokens: TokenTotals;
}

export interface UsageSummary {
  readonly sidechain: SidechainMode;
  /** Accepted records only: the one figure that is settled. Counters captured in the ingested transcripts: not billing, not complete session totals. */
  readonly settled: TokenTotals & { readonly records: number };
  /** Same identity, different counters: a range, never a total. */
  readonly conflicting: { readonly groups: number; readonly lower: TokenTotals; readonly upper: TokenTotals };
  /** No reliable identity: reported under both interpretations. */
  readonly ambiguous: { readonly records: number; readonly ifRepeats: TokenTotals; readonly ifDistinct: TokenTotals };
  readonly duplicates: number;
  /** Counts over ALL stored records; the sidechain filter does not apply to them. */
  readonly stateCounts: Readonly<Record<AccountingState, number>>;
}

export interface ModelBreakdown extends Page {
  readonly sidechain: SidechainMode;
  readonly items: readonly SourceBreakdown[];
}

export interface DayBreakdown extends Page {
  readonly sidechain: SidechainMode;
  readonly from: string | null;
  readonly to: string | null;
  /** Calendar days are UTC. */
  readonly items: readonly SourceBreakdown[];
  /** Settled records with no usable timestamp. Never filtered by the date range. */
  readonly undated: SourceBreakdown | null;
}

export interface SessionItem {
  /** Opaque, salted fingerprint prefix. Not a Claude session id. */
  readonly id: string | null;
  readonly records: number;
  readonly tokens: TokenTotals;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
}

export interface SessionBreakdown extends Page {
  readonly sidechain: SidechainMode;
  readonly items: readonly SessionItem[];
}

export interface UsageQuality {
  readonly stateCounts: Readonly<Record<AccountingState, number>>;
  /**
   * Sources whose anonymous identity is currently uncertain: a successful rewrite flagged the source and anonymous
   * records are still stored for it. Unchanged reads, appends, failed reads and failed scans never clear it; only
   * the absence of anonymous records does. `latestScan.anonymousIdentityUncertainSources` is the per-run figure.
   */
  readonly identityUncertainSources: number;
  readonly tokenFieldStates: Readonly<Record<TokenFieldName, FieldStates>>;
  readonly latestScan: {
    readonly id: number;
    readonly status: string;
    readonly errorCode: string | null;
    readonly sources: number;
    readonly outcomes: Readonly<Record<string, number>>;
    readonly errorCodes: Readonly<Record<string, number>>;
    readonly anonymousIdentityUncertainSources: number;
    readonly skippedLines: { readonly blank: number; readonly malformed: number; readonly oversized: number; readonly nonObject: number; readonly usageObjectsMalformed: number };
    readonly eventsWithoutUsage: number;
    readonly unusableTimestamps: number;
    readonly unrecognizedUsageKeys: number;
  } | null;
}

export interface ConfigSummary {
  readonly scan: ConfigScanStatus | null;
  readonly rows: readonly {
    readonly scope: string;
    readonly category: string;
    readonly files: number;
    readonly skipped: number;
    readonly estimatedTokensOnDisk: number;
  }[];
  /** Files by activation status. There is deliberately no "loaded" bucket. */
  readonly activation: Readonly<Record<string, number>>;
  readonly skippedByCode: Readonly<Record<string, number>>;
  readonly importsByStatus: Readonly<Record<string, number>>;
  readonly note: string;
}

export interface FindingItem {
  /** Stable finding id, referenced by recommendations as evidence. */
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly ruleTitle: string | null;
  readonly severity: string;
  readonly confidence: string;
  readonly sourceId: string | null;
  readonly relatedSourceId: string | null;
  readonly evidence: Readonly<Record<string, number | boolean | string>>;
  readonly evidenceRedacted: boolean;
  readonly limitations: string;
  readonly recommendation: string;
}

export interface FindingsPage extends Page {
  readonly filter: { readonly severity: string | null; readonly ruleId: string | null };
  readonly items: readonly FindingItem[];
  /** Counts over the whole current snapshot, independent of the filter, for building filters. */
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byRule: Readonly<Record<string, number>>;
  readonly note: string;
}

export interface RecommendationsPage extends Page {
  readonly filter: { readonly category: string | null; readonly priority: string | null };
  readonly items: readonly Recommendation[];
  /** Counts over all generated recommendations, independent of the filter. */
  readonly byCategory: Readonly<Record<string, number>>;
  readonly byPriority: Readonly<Record<string, number>>;
  /** One entry per rule: whether it generated, was not triggered, or lacked evidence, and why (a fixed code). */
  readonly rules: readonly RuleEvaluation[];
  /** Which sections had a completed scan. A rule needing an unavailable section reports insufficient evidence. */
  readonly availability: { readonly usage: boolean; readonly config: boolean };
  readonly note: string;
}

export interface StatusReport {
  readonly schemaVersion: number;
  readonly usage: { readonly state: "ok" | "no-completed-scan"; readonly completedScans: number; readonly latestScan: UsageScanStatus | null };
  readonly config: { readonly state: "ok" | "no-completed-scan"; readonly latestScan: ConfigScanStatus | null };
}

export const RECOMMENDATIONS_NOTE =
  "Recommendations are suggestions for human review, derived from audit findings and usage aggregates. Nothing has been changed, applied or executed, and no saving is claimed.";
export const FINDINGS_NOTE =
  "Findings describe files found on disk. None of them shows that a file is loaded or in effect, and none claims a saving.";
export const CONFIG_NOTE =
  "Inventoried means present on disk. Activation is unverified; estimated tokens are bytes / 4 and are not a measure of what is loaded.";

/**
 * How a stored run ended, from persisted data only:
 * - complete / partial: finished; every source read, or some failed (readable sources were committed).
 * - failed: finished and committed, but every source failed.
 * - rolled-back: the whole scan failed with a run-level error; its writes were rolled back, so no usage records
 *   came from it. The per-outcome counters were never recorded for it.
 * - unfinished: the run row never reached a final status; its counters were never recorded.
 */
export type RunKind = "complete" | "partial" | "failed" | "rolled-back" | "unfinished";

export interface RunCounts {
  readonly sources: Readonly<Record<"new" | "unchanged" | "appended" | "modified" | "failed", number>>;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
}

export interface RunItem {
  readonly id: number;
  readonly kind: RunKind;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Run-level fixed code (a rolled-back scan). Per-source codes are in the detail. */
  readonly errorCode: string | null;
  readonly sourcesRequested: number;
  /** null = not recorded for this run (never a zero). Present for every run that finished and was committed. */
  readonly counts: RunCounts | null;
}

export interface RunHistoryPage extends Page {
  readonly items: readonly RunItem[];
  readonly note: string;
}

export interface RunSourceItem {
  /** Position within the run (1-based, insertion order). Not a path, label or fingerprint. */
  readonly ordinal: number;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly anonymousIdentityUncertain: boolean;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
  readonly recordsRetained: number;
  readonly usageRecordsParsed: number;
  readonly skippedLines: { readonly blank: number; readonly malformed: number; readonly oversized: number; readonly nonObject: number; readonly usageObjectsMalformed: number };
  readonly eventsWithoutUsage: number;
  readonly unusableTimestamps: number;
  readonly unrecognizedUsageKeys: number;
}

export interface RunDetailReport {
  /** null when no such run is stored. */
  readonly run: RunItem | null;
  readonly sourceErrorCodes: Readonly<Record<string, number>>;
  readonly anonymousIdentityUncertainSources: number;
  readonly sourcePage: Page;
  readonly sources: readonly RunSourceItem[];
}

export const RUN_HISTORY_NOTE =
  "History lists scans recorded in the database, newest first. A figure shown as not recorded was never stored for that run; it is not zero. Source details never include paths, labels or file content.";

export type SourceOutcomeName = "new" | "unchanged" | "appended" | "modified" | "failed";

/** A run named by its id (as listed in Run History) and its recorded start time, which may be unusable. */
export interface RunRef {
  readonly runId: number;
  readonly startedAt: string | null;
}

export interface SourceItem {
  /** Opaque, stable within this database: a one-way digest of the stored (already salted) source fingerprint. Not a path, name or internal id. */
  readonly ref: string;
  /** The run in which this source was first stored. */
  readonly firstSeen: RunRef;
  /** The last run that read this source successfully (new, unchanged, appended or modified). Failed reads do not move it. */
  readonly lastRead: RunRef;
  /** Result rows attributed to this source. Failed reads of a not-yet-stored source cannot be attributed, so this is a lower bound. */
  readonly resultCount: number;
  /** Counts of attributed results by outcome; a 0 is a counted zero. */
  readonly outcomes: Readonly<Record<SourceOutcomeName, number>>;
  readonly latestResult: (RunRef & { readonly outcome: string; readonly errorCode: string | null }) | null;
  /** Usage records currently stored for this source (all accounting states). Not a history figure. */
  readonly recordsStored: number;
  /**
   * Whether the newest committed run has a result for this source. false does NOT mean the source was deleted or is
   * gone: a scan only covers the files it was asked to read. null: no committed run exists to compare with.
   */
  readonly inLatestCommittedRun: boolean | null;
  /** true when the first-seen or last-read run has no attributed result row, so the recorded history is known to have a gap. */
  readonly historyIncomplete: boolean;
}

export interface SourceCoveragePage extends Page {
  readonly items: readonly SourceItem[];
  readonly latestCommittedRun: (RunRef & { readonly kind: RunKind }) | null;
  readonly note: string;
}

export interface SourceResultItem {
  readonly run: RunRef & { readonly kind: RunKind };
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly anonymousIdentityUncertain: boolean;
  /** null for a failed read: nothing was read, so no record or line figure exists for it (not zero). */
  readonly counts: {
    readonly recordsInserted: number;
    readonly recordsRemoved: number;
    readonly recordsRetained: number;
    readonly usageRecordsParsed: number;
    readonly skippedLines: { readonly blank: number; readonly malformed: number; readonly oversized: number; readonly nonObject: number; readonly usageObjectsMalformed: number };
    readonly eventsWithoutUsage: number;
    readonly unusableTimestamps: number;
    readonly unrecognizedUsageKeys: number;
  } | null;
}

export interface SourceDetailReport {
  /** null when no stored source has this reference. */
  readonly source: SourceItem | null;
  readonly historyPage: Page;
  /** Newest first. */
  readonly history: readonly SourceResultItem[];
  readonly note: string;
}

export const SOURCE_COVERAGE_NOTE =
  "These are the sources this database has observed, not all Claude Code activity. A source seen in an earlier run may be absent from the latest run without being deleted: a scan covers only the files it was asked to read. A failed or partial run does not show complete coverage. Failed reads of a file that was not yet stored cannot be attributed to any source, so each history can be missing such attempts. Figures shown as not recorded were never stored; they are not zero. References are opaque; paths, names and content are never stored in this view.";
