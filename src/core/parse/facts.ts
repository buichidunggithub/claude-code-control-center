/**
 * Privacy-safe classifiers for prompt length and tool names.
 *
 * Both functions map untrusted input to a member of a small fixed vocabulary. Nothing derived from the
 * input other than that vocabulary member is returned, so their output is safe to persist or display.
 * Neither claims anything about real Claude Code transcripts: the recognized shapes are an assumption
 * validated only against synthetic fixtures.
 */

/** Upper bounds, in UTF-16 code units, of each coarse prompt-length bucket. `xl` is everything above `LARGE`. */
export const PROMPT_LENGTH_THRESHOLDS = {
  EXTRA_SMALL: 50,
  SMALL: 200,
  MEDIUM: 1000,
  LARGE: 5000,
} as const;

export const PROMPT_LENGTH_BUCKETS = ["empty", "xs", "s", "m", "l", "xl"] as const;

export type PromptLengthBucket = (typeof PROMPT_LENGTH_BUCKETS)[number];

/**
 * What is known about the text size of a source-typed user event. This is a HEURISTIC about supported text
 * content, never a claim that the event is a prompt:
 * - a bucket: supported text was read and measured (only when `readPromptLength` is true);
 * - `unsupported`: content was read but is not text this helper supports (missing, object, tool result, ...);
 * - `not-read`: the opt-in was off, so the content was not read at all.
 */
export const TEXT_LENGTH_STATES = [...PROMPT_LENGTH_BUCKETS, "unsupported", "not-read"] as const;

export type TextLengthState = (typeof TEXT_LENGTH_STATES)[number];

export function bucketForLength(length: number): PromptLengthBucket {
  if (length <= 0) return "empty";
  if (length <= PROMPT_LENGTH_THRESHOLDS.EXTRA_SMALL) return "xs";
  if (length <= PROMPT_LENGTH_THRESHOLDS.SMALL) return "s";
  if (length <= PROMPT_LENGTH_THRESHOLDS.MEDIUM) return "m";
  if (length <= PROMPT_LENGTH_THRESHOLDS.LARGE) return "l";
  return "xl";
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Length of the text blocks of a content array, or null when it is not a supported prompt shape. */
function textBlocksLength(blocks: readonly unknown[]): number | null {
  let total = 0;
  let textBlocks = 0;
  for (const block of blocks) {
    if (!isPlainRecord(block)) continue;
    const type = block["type"];
    // A tool result makes the event a result carrier rather than typed text, even when text is mixed in.
    if (type === "tool_result") return null;
    if (type !== "text") continue;
    const text = block["text"];
    if (typeof text !== "string") continue;
    total += text.length;
    textBlocks += 1;
  }
  return textBlocks === 0 ? null : total;
}

/**
 * Heuristic coarse length bucket of a user event's `message.content`, or null when the content is not text this
 * helper supports (missing, non-string, an object, no text blocks, or any tool result).
 *
 * Supported: a string, or an array whose `{type:"text", text:<string>}` blocks are summed. Everything
 * else in an array is skipped, never stringified and never traversed: there is no recursion.
 * The content is read in memory only to take a `.length`; no text is returned or retained.
 */
export function promptLengthBucket(content: unknown): PromptLengthBucket | null {
  try {
    if (typeof content === "string") return bucketForLength(content.length);
    if (!Array.isArray(content)) return null;
    const length = textBlocksLength(content);
    return length === null ? null : bucketForLength(length);
  } catch {
    // Deliberately empty of detail: an error message (e.g. from a hostile getter) could quote content.
    return null;
  }
}

/** Tool names that may be stored verbatim. Extending this list needs explicit approval. */
export const TOOL_NAME_ALLOWLIST = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
] as const;

/**
 * Vocabulary of stored tool names: an allowlisted name, `other` for any other string with at least one
 * character (including `mcp__*`, padded or differently cased names and overlong names), or `unknown` for a
 * missing or non-string value.
 */
export const TOOL_BUCKETS = [...TOOL_NAME_ALLOWLIST, "other", "unknown"] as const;

export type ToolBucket = (typeof TOOL_BUCKETS)[number];

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_NAME_ALLOWLIST);

/**
 * Exact, case-sensitive match on the RAW value: no trimming and no length cap, so `" Read"` and a 300-character
 * name are `other`, never a near-miss of an allowlisted name. Anything not on the allowlist collapses, so no
 * arbitrary name survives.
 */
export function toolNameBucket(name: unknown): ToolBucket {
  if (typeof name !== "string" || name.length === 0) return "unknown";
  return ALLOWED_TOOL_NAMES.has(name) ? (name as ToolBucket) : "other";
}
