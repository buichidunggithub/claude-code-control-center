import { promptLengthBucket, toolNameBucket, type TextLengthState } from "./facts";
import {
  TOKEN_FIELDS,
  type EventTypeBucket,
  type TokenCount,
  type TokenFieldName,
  type ToolEvent,
  type SourcePosition,
  type UsageObservation,
  type SourceUserEventFact,
} from "./types";

export type JsonRecord = Readonly<Record<string, unknown>>;

const MAX_IDENTIFIER_LENGTH = 256;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant",
  "user",
  "system",
  "summary",
  "progress",
  "file-history-snapshot",
  "queue-operation",
]);

const SOURCE_KEY_BY_FIELD: Readonly<Record<TokenFieldName, string>> = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheCreationTokens: "cache_creation_input_tokens",
};

/** Usage keys seen alongside the counters that are not token counts; not drift. */
const IGNORED_USAGE_KEYS: ReadonlySet<string> = new Set([
  "service_tier",
  "cache_creation",
  "server_tool_use",
]);

export type UsageStatus = "absent" | "malformed" | "recognized";

export interface EventObservation {
  readonly eventType: EventTypeBucket;
  readonly usageStatus: UsageStatus;
  readonly usage: UsageObservation | null;
  readonly unrecognizedUsageKeyCount: number;
  readonly tools: readonly ToolEvent[];
  readonly userEvent: SourceUserEventFact | null;
}

export interface NormalizeOptions {
  /** The only switch that lets `message.content` of a user event be read for length. Default false. */
  readonly readPromptLength?: boolean;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDENTIFIER_LENGTH ? trimmed : null;
}

export function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_8601.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function readTokenCount(usage: JsonRecord, field: TokenFieldName): TokenCount {
  const key = SOURCE_KEY_BY_FIELD[field];
  if (!Object.hasOwn(usage, key)) return { kind: "missing" };
  const value = usage[key];
  if (value === null) return { kind: "null" };
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return { kind: "value", value };
  }
  return { kind: "invalid" };
}

function bucketEventType(value: unknown): EventTypeBucket {
  if (typeof value !== "string") return "missing";
  return KNOWN_EVENT_TYPES.has(value) ? (value as EventTypeBucket) : "other";
}

function countUnrecognizedUsageKeys(usage: JsonRecord): number {
  const recognized = new Set(Object.values(SOURCE_KEY_BY_FIELD));
  return Object.keys(usage).filter((key) => !recognized.has(key) && !IGNORED_USAGE_KEYS.has(key))
    .length;
}

function readTools(
  content: unknown,
  context: Pick<ToolEvent, "sourceIndex" | "lineNumber" | "sessionId" | "timestamp" | "isSidechain">,
): ToolEvent[] {
  if (!Array.isArray(content)) return [];
  // The index comes from the original array, so it is unaffected by which other blocks are recognized.
  return content.flatMap((block, blockIndex): ToolEvent[] => {
    if (!isRecord(block) || own(block, "type") !== "tool_use") return [];
    const rawName = own(block, "name");
    return [
      {
        blockIndex,
        toolUseId: readIdentifier(own(block, "id")),
        toolName: readIdentifier(rawName),
        toolBucket: toolNameBucket(rawName),
        ...context,
      },
    ];
  });
}

function resolveIdentity(
  event: JsonRecord,
  message: JsonRecord | null,
): Pick<UsageObservation, "eventKey" | "identity"> {
  const messageId = message ? readIdentifier(own(message, "id")) : null;
  if (messageId) return { eventKey: `msg:${messageId}`, identity: "message-id" };
  const uuid = readIdentifier(own(event, "uuid"));
  if (uuid) return { eventKey: `uuid:${uuid}`, identity: "uuid" };
  return { eventKey: null, identity: "none" };
}

/** The only place user content is read. Callers must have checked the opt-in. */
function readTextLength(message: JsonRecord | null): TextLengthState {
  return promptLengthBucket(message ? own(message, "content") : undefined) ?? "unsupported";
}

/** Pure classification of one parsed JSON object. Reads only explicitly recognized fields. */
export function normalizeEvent(
  event: JsonRecord,
  position: SourcePosition,
  options: NormalizeOptions = {},
): EventObservation {
  const eventType = bucketEventType(own(event, "type"));
  const messageValue = own(event, "message");
  const message = isRecord(messageValue) ? messageValue : null;

  const sessionId = readIdentifier(own(event, "sessionId"));
  const timestamp = readTimestamp(own(event, "timestamp"));
  const sidechainValue = own(event, "isSidechain");
  const isSidechain = typeof sidechainValue === "boolean" ? sidechainValue : null;

  const tools = readTools(message ? own(message, "content") : undefined, {
    sessionId,
    timestamp,
    isSidechain,
    ...position,
  });

  const userEvent: SourceUserEventFact | null =
    eventType === "user"
      ? {
          ...position,
          sessionId,
          timestamp,
          isSidechain,
          textLength: options.readPromptLength === true ? readTextLength(message) : "not-read",
        }
      : null;

  const usageValue = message ? own(message, "usage") : undefined;
  if (usageValue === undefined) {
    return { eventType, usageStatus: "absent", usage: null, unrecognizedUsageKeyCount: 0, tools, userEvent };
  }
  if (!isRecord(usageValue)) {
    return { eventType, usageStatus: "malformed", usage: null, unrecognizedUsageKeyCount: 0, tools, userEvent };
  }

  const tokens = Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, readTokenCount(usageValue, field)]),
  ) as Record<TokenFieldName, TokenCount>;

  const usage: UsageObservation = {
    ...resolveIdentity(event, message),
    ...position,
    eventType,
    timestamp,
    sessionId,
    model: message ? readIdentifier(own(message, "model")) : null,
    isSidechain,
    tokens,
  };
  return {
    eventType,
    usageStatus: "recognized",
    usage,
    unrecognizedUsageKeyCount: countUnrecognizedUsageKeys(usageValue),
    tools,
    userEvent,
  };
}
