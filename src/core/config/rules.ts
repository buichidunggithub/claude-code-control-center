import { createHash } from "node:crypto";
import type { Confidence, Evidence, Finding, Severity } from "./types";

interface RuleDef {
  readonly title: string;
  readonly severity: Severity;
  readonly limitations: string;
  readonly recommend: (e: Evidence) => string;
}

const n = (e: Evidence, key: string): number => {
  const v = e[key];
  return typeof v === "number" ? v : 0;
};

const NOT_LOADED =
  "Existing on disk does not show a file is loaded in any session, so real per-session cost and any possible saving are unmeasured.";
const ESTIMATE = "Token figures are rough estimates (bytes / 4), not tokenizer output.";
const REVIEW = "This is a review prompt, not a claim that anything is unnecessary.";

/**
 * Stable rule catalog. IDs never change meaning; add new IDs instead. Recommendation text is built only
 * from counts and code words in the evidence, so it can never contain file content.
 */
export const RULES = {
  "CFG-SIZE-001": {
    title: "Large instruction file",
    severity: "low",
    limitations: `${ESTIMATE} ${NOT_LOADED} Thresholds are heuristics.`,
    recommend: (e) =>
      `About ${n(e, "estimatedTokens")} estimated tokens over ${n(e, "lines")} lines. Consider whether rarely needed parts could live in on-demand files (skills or imports), then measure before and after. No saving is claimed.`,
  },
  "CFG-SIZE-002": {
    title: "Very large instruction file",
    severity: "medium",
    limitations: `${ESTIMATE} ${NOT_LOADED} Thresholds are heuristics.`,
    recommend: (e) =>
      `About ${n(e, "estimatedTokens")} estimated tokens over ${n(e, "lines")} lines. This is far above the heuristic threshold; review whether it can be split, then measure. No saving is claimed.`,
  },
  "CFG-SIZE-003": {
    title: "File too large to analyze",
    severity: "info",
    limitations: "The file was not read, so none of its other properties are known.",
    recommend: (e) => `The file is ${n(e, "sizeBytes")} bytes, above the ${n(e, "limitBytes")} byte analysis limit. Review it manually or raise the limit deliberately.`,
  },
  "CFG-DUP-001": {
    title: "Identical content in multiple files",
    severity: "low",
    limitations: `Byte-identical content is a fact; whether the copies are redundant is not. They may be intentional (different scopes or triggers). ${NOT_LOADED}`,
    recommend: (e) => `${n(e, "fileCount")} files have identical content. Check whether all copies are needed. ${REVIEW}`,
  },
  "CFG-DUP-002": {
    title: "Near-duplicate content",
    severity: "low",
    limitations: `Similarity is the share of identical normalized lines (Jaccard), a rough heuristic. Similar files may differ in meaning. ${NOT_LOADED}`,
    recommend: (e) => `${n(e, "sharedLines")} normalized lines are shared (similarity ${n(e, "similarityPct")}%). Compare the two files for overlap. ${REVIEW}`,
  },
  "CFG-SCOPE-001": {
    title: "Same file name in user and project scope",
    severity: "low",
    limitations: "How Claude Code merges or prioritizes same-named files across scopes is not verified here. The file names matching may be intentional.",
    recommend: () => `A user-level and a project-level file share the same layout path. Confirm which one is meant to apply. ${REVIEW}`,
  },
  "CFG-SCOPE-002": {
    title: "Rules with identical path patterns",
    severity: "low",
    limitations: "Only exactly identical pattern sets are compared; partial overlap between different patterns is not detected. Matching is not evaluated against real files.",
    recommend: (e) => `${n(e, "fileCount")} rule files declare the same ${n(e, "globCount")} path pattern(s). Consider whether they should be merged. ${REVIEW}`,
  },
  "CFG-META-001": {
    title: "Malformed frontmatter",
    severity: "medium",
    limitations: "The frontmatter reader supports a small YAML subset. Valid but unusual YAML may be reported as malformed.",
    recommend: () => "Fix the frontmatter block so it opens and closes with --- and uses simple key: value lines.",
  },
  "CFG-META-002": {
    title: "Missing required metadata",
    severity: "medium",
    limitations: "Required fields follow documented conventions that may differ across Claude Code versions.",
    recommend: () => "Add the missing field to the frontmatter.",
  },
  "CFG-META-003": {
    title: "Invalid metadata value",
    severity: "low",
    limitations: "Format and length limits follow documented conventions that may differ across versions.",
    recommend: () => "Correct the field value to the expected format.",
  },
  "CFG-IMP-001": {
    title: "Import target not found",
    severity: "medium",
    limitations: "Imports are detected heuristically from @path tokens; prose that looks like a path can be misread as an import.",
    recommend: () => "Fix the path, remove the reference, or confirm it is not meant to be an import.",
  },
  "CFG-IMP-002": {
    title: "Import outside the allowed roots",
    severity: "low",
    limitations: "The target was deliberately not read, so its existence and content are unknown.",
    recommend: () => "This import points outside the directories the scan was allowed to read. Review it manually.",
  },
  "CFG-IMP-003": {
    title: "Import cycle",
    severity: "medium",
    limitations: "Detected only among files the scan could read and resolve.",
    recommend: () => "Break the cycle so the files do not import each other.",
  },
  "CFG-IMP-004": {
    title: "Import chain too deep",
    severity: "low",
    limitations: "The depth limit follows documented behavior that may differ across versions. Deeper targets were not read.",
    recommend: (e) => `The import chain exceeds ${n(e, "maxDepth")} levels. Flatten it so the intended files are reachable.`,
  },
  "CFG-CONF-001": {
    title: "Possibly opposing instructions",
    severity: "medium",
    limitations: "Detected only for lines beginning with always/never (or do not) whose remaining words are identical. Context, scope and conditions are not understood, so this may be a false positive.",
    recommend: () => "Two instructions with the same wording appear to say always and never. Check whether they conflict in the same context.",
  },
  "CFG-CONF-002": {
    title: "Permission both allowed and denied",
    severity: "medium",
    limitations: "Precedence between allow and deny rules, and between settings files, is not verified here.",
    recommend: (e) => `${n(e, "overlappingRules")} permission rule(s) appear in both an allow and a deny list. Remove the one that is not intended.`,
  },
  "CFG-HOOK-001": {
    title: "Same hook command registered more than once",
    severity: "low",
    limitations: "Whether duplicate registrations across files run twice or are merged is not verified here. Only exact command text matches are detected.",
    recommend: (e) => `The same hook command is registered ${n(e, "occurrences")} times for one event. Confirm that is intended.`,
  },
  "CFG-ACT-001": {
    title: "Activation cannot be established from files alone",
    severity: "info",
    limitations: "Activation depends on runtime behavior (launch directory, matching files, invocation) that a static scan cannot observe.",
    recommend: () => "Treat this file as present, not as loaded. Do not infer cost from its size without measurement.",
  },
  "CFG-FS-001": {
    title: "File skipped by the safety rules",
    severity: "info",
    limitations: "The file was not opened. Its content and size are unknown.",
    recommend: () => "A symlink or path resolved outside the allowed roots, or the file could not be read safely. Review it manually if it matters.",
  },
  "CFG-SET-001": {
    title: "Settings file could not be analyzed",
    severity: "medium",
    limitations: "Only valid JSON objects within the depth limit are analyzed.",
    recommend: () => "Fix the settings file so it is a valid JSON object.",
  },
  "CFG-SCAN-001": {
    title: "Scan limit reached",
    severity: "info",
    limitations: "Some candidate files were not inventoried, so findings may be incomplete.",
    recommend: (e) => `The scan stopped at ${n(e, "limit")} files. Narrow the roots or raise the limit deliberately.`,
  },
} as const satisfies Record<string, RuleDef>;

export type RuleId = keyof typeof RULES;

const EVIDENCE_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const EVIDENCE_CODE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

/** Evidence may hold only numbers, booleans and short code words: free text is rejected. */
export function isSafeEvidence(evidence: Evidence): boolean {
  return Object.entries(evidence).every(
    ([key, value]) =>
      EVIDENCE_KEY.test(key) &&
      (typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && EVIDENCE_CODE.test(value))),
  );
}

export interface FindingInput {
  readonly sourceId?: string | null;
  readonly relatedSourceId?: string | null;
  readonly confidence: Confidence;
  readonly severity?: Severity;
  readonly evidence: Evidence;
  /** Distinguishes several findings of one rule on the same files. */
  readonly discriminator?: string;
}

export function makeFinding(ruleId: RuleId, input: FindingInput): Finding {
  const rule: RuleDef = RULES[ruleId];
  if (!isSafeEvidence(input.evidence)) throw new TypeError(`unsafe evidence for ${ruleId}`);
  const sourceId = input.sourceId ?? null;
  const relatedSourceId = input.relatedSourceId ?? null;
  const key = createHash("sha256")
    .update([ruleId, sourceId ?? "", relatedSourceId ?? "", input.discriminator ?? ""].join("|"))
    .digest("hex")
    .slice(0, 24);
  return {
    key,
    ruleId,
    severity: input.severity ?? rule.severity,
    confidence: input.confidence,
    sourceId,
    relatedSourceId,
    evidence: input.evidence,
    limitations: rule.limitations,
    recommendation: rule.recommend(input.evidence),
  };
}
