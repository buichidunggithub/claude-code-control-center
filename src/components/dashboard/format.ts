import type { TokenFieldName } from "@/core/parse/types";

const NUMBER = new Intl.NumberFormat("en-US");

export const fmt = (n: number): string => NUMBER.format(n);

export const TOKEN_LABELS: Readonly<Record<TokenFieldName, string>> = {
  inputTokens: "Input",
  outputTokens: "Output",
  cacheReadTokens: "Cache read",
  cacheCreationTokens: "Cache creation",
};

export const TOKEN_ORDER: readonly TokenFieldName[] = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"];

export const sumTokens = (t: Readonly<Record<TokenFieldName, number>>): number => TOKEN_ORDER.reduce((total, f) => total + t[f], 0);

/**
 * Shown next to every token total (Overview and Usage). One wording, so the pages cannot drift apart.
 * It describes what the totals ARE (usage records captured in the ingested transcripts and accepted by the
 * accounting pipeline) and what they are NOT, without claiming any figure about what is missing.
 */
export const TOKEN_DISCLAIMER =
  "Token totals count usage records found in the ingested transcripts and accepted by the accounting pipeline (repeats of one message are counted once; conflicting or ambiguous records are kept out and shown separately). Transcripts may not capture every API call, so totals can be incomplete and may differ from Claude Code's own cumulative counters. They are not billing totals, complete session totals or exact API cost; no pricing is applied.";
/**
 * Describes the actual aggregation: a settled record is counted even if one counter is not valid, and that
 * counter then adds nothing to its own total. It does not claim the total is a bound on all usage.
 */
export const COUNTER_COMPLETENESS =
  "A settled record is counted even when one of its counters is missing, null or invalid; that counter then adds nothing to its own total, so each token total sums only the records where that counter has a valid value. Data quality shows how many counters are not valid.";

export const ESTIMATE_DISCLAIMER = "Estimated tokens are bytes / 4, a rough size estimate and not tokenizer output.";
