/**
 * Normalized shapes for the synthetic-first JSONL parser.
 *
 * The recognized source shape is an ASSUMPTION about Claude Code transcripts, validated only
 * against synthetic fixtures: one JSON object per line, with optional top-level `type`, `uuid`,
 * `sessionId`, `timestamp`, `isSidechain`, and a `message` object carrying `id`, `model`,
 * `content[]` blocks and a `usage` object with four token counters.
 */

import type { TextLengthState, ToolBucket } from "./facts";

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
  /** Index of the block in the ORIGINAL `message.content` array, counting every block, recognized or not. */
  readonly blockIndex: number;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  /** Bucket of the RAW name (not of `toolName`, which is trimmed and capped). The only name-derived value safe to persist. */
  readonly toolBucket: ToolBucket;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly isSidechain: boolean | null;
}

/**
 * An event whose source `type` is "user". Nothing more is claimed: it may be typed text, a tool-result carrier
 * or something else, and whether any of these is a real prompt or turn is UNRESOLVED (the shapes are validated
 * only against synthetic fixtures). It is produced for every such event and reads no content.
 *
 * `textLength` is an optional heuristic: `not-read` unless `ParseOptions.readPromptLength` is true, then a
 * coarse bucket of supported text or `unsupported`. It must not be read as "prompt length".
 */
export interface SourceUserEventFact extends SourcePosition {
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly isSidechain: boolean | null;
  readonly textLength: TextLengthState;
}

/**
 * A deduplicated tool call with its name reduced to a safe bucket. There is no name, argument or result field.
 *
 * Identity, by scope:
 * - `(sourceIndex, lineNumber, blockIndex)` is unique and stable only for one version of one source. It is
 *   what tells apart blocks that have no id, and it is NOT stable across a modified file: line numbers shift,
 *   so anonymous calls must be recomputed on re-ingestion and never linked across versions.
 *   After an append the earlier positions are unchanged; any other edit gives no link at all.
 * - `toolUseId` is the opaque source id, meant to be salted-fingerprinted before persistence. When present
 *   it deduplicates across events and sources within one parse call (first occurrence wins), so which
 *   occurrence is kept depends on source order and must be recomputed when sources change.
 * - A call with a null `toolUseId` is never deduplicated or merged.
 */
export interface ToolCallFact extends SourcePosition {
  /** Index in the original `message.content` array (see `ToolEvent.blockIndex`). */
  readonly blockIndex: number;
  readonly toolUseId: string | null;
  readonly toolBucket: ToolBucket;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly isSidechain: boolean | null;
}

/** Facts for future persistence. Independent of usage accounting: never read by it, never changes totals. */
export interface ParseFacts {
  readonly sourceUserEvents: readonly SourceUserEventFact[];
  readonly toolCalls: readonly ToolCallFact[];
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
  readonly promptLengthEnabled: boolean;
  readonly sourceUserEventFacts: number;
  /** Counts per text-length state. Every source-typed user event is `not-read` while the opt-in is off. */
  readonly textLengthStates: Readonly<Record<TextLengthState, number>>;
  readonly toolCallsByBucket: Readonly<Record<ToolBucket, number>>;
}

export interface ParseResult {
  readonly usageRecords: readonly UsageRecord[];
  readonly toolEvents: readonly ToolEvent[];
  readonly facts: ParseFacts;
  readonly diagnostics: ParseDiagnostics;
}

export interface ParseOptions {
  /** Maximum raw bytes per line, excluding the "\n" terminator. */
  readonly maxLineBytes?: number;
  /**
   * Opt-in, default false. When false no user-event content is read and every `textLength` is `not-read`.
   * When true, content is read in memory only to compute a coarse, heuristic length bucket.
   */
  readonly readPromptLength?: boolean;
}

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
