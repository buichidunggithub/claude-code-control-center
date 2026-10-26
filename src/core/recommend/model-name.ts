/**
 * The one definition of a "recognized" model identifier, used for display, aggregation, the attribution
 * threshold and the distinct-model count in BOTH `/api/usage/models` and the recommendation engine.
 *
 * Grammar (ASCII only, at most 64 characters in total, compared case-insensitively):
 *
 *   [ PROVIDER "/" ]  BASE  [ "@" VERSION ]  [ "[" CONTEXT "]" ]
 *
 *   PROVIDER  one of a short allowlist of well-known provider/gateway prefixes (below). Exactly one "/"
 *             is allowed and only after such a prefix, so "anthropic/claude-sonnet-4.5" is accepted while
 *             "home/user" or "a/b/c" is not.
 *   BASE      starts with a letter or digit, then letters, digits and "." "_" ":" "-"; never contains "..".
 *             (":" covers Bedrock ids such as "us.anthropic.claude-sonnet-4-5-20250929-v1:0".)
 *   VERSION   6-10 digits or "latest" (Vertex style: "claude-3-5-sonnet-v2@20241022"). Not free text, so
 *             an email-like "name@host" is rejected.
 *   CONTEXT   digits followed by "k" or "m" ("[1m]", "[200k]"): the context-window suffix. No other
 *             bracketed text is accepted.
 *
 * Canonical form: lower case. "Model-A" and "model-a" are one model everywhere.
 *
 * Always rejected (all become "unrecognized"): empty values, whitespace and control characters, "\", "~",
 * leading "/" or ".", ".." or "//", "://", "<" ">" quotes, braces, ";" "=" "?" "#" "%" "$" "&" "*" "!",
 * any non-ASCII character, any "/" not preceded by an allowlisted provider, a second "/" or "@" or "[",
 * and anything longer than 64 characters.
 *
 * Limitations: a provider outside the allowlist is rejected even if legitimate (add it here deliberately);
 * a value that merely looks like a model id is accepted, so recognition is a shape check, not proof that
 * the model exists. Unrecognized values are never displayed, only counted.
 */
const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "meta-llama",
  "mistralai",
  "deepseek",
  "x-ai",
  "amazon",
  "cohere",
  "qwen",
  "bedrock",
  "vertex_ai",
  "azure",
  "openrouter",
] as const;

export const MODEL_NAME_MAX_LENGTH = 64;

const MODEL_NAME = new RegExp(
  `^(?:(?:${PROVIDERS.join("|")})/)?[a-z0-9][a-z0-9._:-]*(?:@(?:\\d{6,10}|latest))?(?:\\[\\d{1,3}[km]\\])?$`,
  "i",
);

export const UNRECOGNIZED_MODEL_LABEL = "(unrecognized model name)";

/** Returns the canonical (lower-case) identifier, or null when the value is absent or fails validation. */
export function recognizeModelName(name: string | null | undefined): string | null {
  if (typeof name !== "string" || name.length > MODEL_NAME_MAX_LENGTH || name.includes("..") || !MODEL_NAME.test(name)) return null;
  return name.toLowerCase();
}

/** Locale-independent ordering by UTF-16 code unit, so ties never depend on the machine's locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
