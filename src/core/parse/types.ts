/**
 * Normalized shapes for the synthetic-first JSONL parser.
 *
 * The recognized source shape is an ASSUMPTION about Claude Code transcripts, validated only
 * against synthetic fixtures: one JSON object per line, with optional top-level `type`, `uuid`,
 * `sessionId`, `timestamp`, `isSidechain`, and a `message` object carrying `id`, `model`,
 * `content[]` blocks and a `usage` object with four token counters.
 */

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

export type TokenFieldName = (typeof TOKEN_FIELDS)[number];

/** Distinguishes an absent key, an explicit null, a malformed value and a real number (incl. 0). */
export type TokenCount =
  | { readonly kind: "missing" }
  | { readonly kind: "null" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: number };

export const EVENT_TYPE_BUCKETS = [
  "assistant",
  "user",
  "system",
  "summary",
  "progress",
  "file-history-snapshot",
  "queue-operation",
  "other",
  "missing",
] as const;

/** Unknown `type` values are collapsed into "other" so diagnostics never echo source strings. */
export type EventTypeBucket = (typeof EVENT_TYPE_BUCKETS)[number];

export type IdentityKind = "message-id" | "uuid" | "none";

/** Where an event was read: the input's index within one parse call, and its 1-based line. No paths. */
export interface SourcePosition {
  readonly sourceIndex: number;
  readonly lineNumber: number;
}

/**
 * How one usage event is treated in totals. Assigned per identity group, never by position:
 * - accepted: sole snapshot for its identity, or the representative of identical repeats.
 * - duplicate: repeat of an accepted record with identical counters; excluded from totals.
 * - conflicting: same identity, different counters. No snapshot is assumed authoritative, so
 *   all members are excluded from settled totals and reported as a lower/upper range.
 * - ambiguous: no reliable identity, so repeat versus distinct call cannot be told apart.
 *   Excluded from settled totals and reported under both interpretations.
 */
export type AccountingState = "accepted" | "duplicate" | "conflicting" | "ambiguous";

export interface UsageObservation extends SourcePosition {
  /** Stable source identity (opaque id from the source), or null when none is reliable. */
  readonly eventKey: string | null;
  readonly identity: IdentityKind;
  readonly eventType: EventTypeBucket;
  readonly timestamp: string | null;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly isSidechain: boolean | null;
  readonly tokens: Readonly<Record<TokenFieldName, TokenCount>>;
}

export interface UsageRecord extends UsageObservation {
  readonly accounting: AccountingState;
  /** Events sharing this record's identity across the whole parse call (1 when anonymous). */
  readonly groupSize: number;
}

/** A tool invocation observed in message content. Carries the tool name only, never arguments. */
export interface ToolEvent extends SourcePosition {
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly isSidechain: boolean | null;
}

export interface TokenFieldIssues {
  readonly missing: number;
  readonly null: number;
  readonly invalid: number;
}

/** Counts only. Never contains source strings, key names or line contents. */
export interface ParseDiagnostics {
  readonly linesRead: number;
  readonly blankLines: number;
  readonly malformedLines: number;
  readonly oversizedLines: number;
  readonly nonObjectLines: number;
  readonly eventsByType: Readonly<Record<EventTypeBucket, number>>;
  readonly eventsWithoutUsage: number;
  readonly usageObjectsMalformed: number;
  readonly sourcesScanned: number;
  readonly usageRecordsParsed: number;
  readonly accounting: Readonly<Record<AccountingState, number>>;
  readonly conflictGroups: number;
  /** Conflicts whose snapshots are field-wise ordered (consistent with a growing snapshot, unproven). */
  readonly conflictGroupsComparable: number;
  /** Conflicts where one counter rose while another fell, so they cannot be one growing snapshot. */
  readonly conflictGroupsContradictory: number;
  /** Duplicates whose sessionId, model or sidechain flag differs from the accepted record. */
  readonly duplicateMetadataMismatches: number;
  /** Counter tuples shared by 2+ distinct identities. Informational only: never merged. */
  readonly identicalPayloadDistinctIdentities: number;
  readonly unusableTimestamps: number;
  readonly missingSessionIds: number;
  readonly missingModels: number;
  readonly sidechainRecords: number;
  readonly unrecognizedUsageKeyCount: number;
  readonly tokenFieldIssues: Readonly<Record<TokenFieldName, TokenFieldIssues>>;
  readonly toolEventsParsed: number;
  readonly toolEventsKept: number;
}

export interface ParseResult {
  readonly usageRecords: readonly UsageRecord[];
  readonly toolEvents: readonly ToolEvent[];
  readonly diagnostics: ParseDiagnostics;
}

export interface ParseOptions {
  /** Maximum raw bytes per line, excluding the "\n" terminator. */
  readonly maxLineBytes?: number;
}

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
