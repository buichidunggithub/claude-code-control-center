import type { RecommendationCategory } from "./types";

export interface RuleDeclaration {
  readonly id: string;
  /** Bumped when the trigger, evidence requirement or wording changes meaning. */
  readonly version: number;
  readonly category: RecommendationCategory;
  readonly title: string;
  readonly evidenceRequirement: string;
  readonly confidenceRationale: string;
  readonly limitations: readonly string[];
  readonly assumptions: readonly string[];
  /** Audit rule versions this rule understands, by audit rule id. Other versions are ignored. */
  readonly findingVersions: Readonly<Record<string, readonly number[]>>;
}

const NOT_LOADED = "Items found on disk are not shown to be loaded in any session, so real per-session effect is unmeasured.";
const NO_SAVING = "No saving or performance improvement is claimed or estimated.";

/** The rule catalog. Rule ids are never reused for a different meaning; add a new id or bump the version. */
export const RECOMMENDATION_RULES = {
  "REC-CFG-DUP": {
    id: "REC-CFG-DUP",
    version: 1,
    category: "configuration-hygiene",
    title: "Review identical configuration content",
    evidenceRequirement: "At least one CFG-DUP-001 (byte-identical content) finding, version 1, covering two or more items, from a completed configuration scan.",
    confidenceRationale: "Byte-identical content is a fact established by comparing keyed hashes, so confidence is that of the underlying findings. Whether the copies are redundant is not established.",
    limitations: ["Identical content may be intentional, for example the same text at different scopes or triggers.", NOT_LOADED, NO_SAVING, "Near-duplicate findings (CFG-DUP-002) are not sufficient evidence for this recommendation."],
    assumptions: ["The scanned roots are the ones you intended to review."],
    findingVersions: { "CFG-DUP-001": [1] },
  },
  "REC-CFG-CONFLICT": {
    id: "REC-CFG-CONFLICT",
    version: 2,
    category: "configuration-hygiene",
    title: "Review possibly conflicting instructions or permissions",
    evidenceRequirement: "At least one CFG-CONF-001 (always/never lines with identical wording, version 1) or CFG-CONF-002 (a permission rule in both allow and deny lists, version 1 or 2) finding. The distinct permission-rule count is exact only from CFG-CONF-002 version 2 evidence; otherwise it is reported as a lower bound.",
    confidenceRationale: "Confidence is the weakest confidence among the contributing findings. The findings prove a textual overlap only, never a semantic conflict.",
    limitations: ["Context, scope, conditions and precedence are not understood or evaluated, so a reported overlap may not be a real conflict.", "A permission rule is identified by its exact string: entries that differ only in whitespace or case are different rules, because the stored evidence is a hash of the exact text and normalizing could merge rules Claude Code treats differently.", NOT_LOADED, NO_SAVING],
    assumptions: ["The audit finding's own limitations apply in full."],
    findingVersions: { "CFG-CONF-001": [1], "CFG-CONF-002": [1, 2] },
  },
  "REC-CTX-SIZE": {
    id: "REC-CTX-SIZE",
    version: 1,
    category: "context-efficiency",
    title: "Review large instruction files",
    evidenceRequirement: "At least one CFG-SIZE-001 or CFG-SIZE-002 (large instruction file) finding, version 1. An item flagged by both counts once, as very large.",
    confidenceRationale: "Sizes are estimates (bytes / 4) measured against heuristic thresholds, so confidence is that of the underlying findings and is never above medium.",
    limitations: ["Token figures are rough estimates, not tokenizer output.", "Thresholds are heuristics, not limits of Claude Code.", NOT_LOADED, "Splitting a file may not change token usage at all, and the effect cannot be stated without measurement.", NO_SAVING],
    assumptions: ["Smaller, focused instruction files are easier to review."],
    findingVersions: { "CFG-SIZE-001": [1], "CFG-SIZE-002": [1] },
  },
  "REC-CFG-ACTIVATION": {
    id: "REC-CFG-ACTIVATION",
    version: 2,
    category: "configuration-hygiene",
    title: "Inventory does not show what is active",
    evidenceRequirement: "A completed configuration scan whose inventory contains at least one item. Counts come from the inventory itself, so every inventoried item is covered; CFG-ACT-001 findings (version 1), which exist only for items with a non-candidate status, are cited as supporting evidence when present.",
    confidenceRationale: "That a static scan cannot establish activation is a fact about the method, and the item counts are read directly from the inventory, so confidence in the observation is high.",
    limitations: ["Activation depends on runtime behavior (launch directory, matching files, invocation) that a static scan cannot observe.", "This recommendation never suggests deleting or rewriting an item because its activation is unknown."],
    assumptions: [],
    findingVersions: { "CFG-ACT-001": [1] },
  },
  "REC-DQ-ACCOUNTING": {
    id: "REC-DQ-ACCOUNTING",
    version: 3,
    category: "data-quality",
    title: "Resolve usage accounting uncertainty before relying on settled totals",
    evidenceRequirement: "A completed usage scan with at least one conflicting group, ambiguous record, or source with uncertain anonymous identity (a rewrite flagged it and anonymous records are still stored for it). Counts cover all events, sidechain included, and sidechain records are reported by accounting state.",
    confidenceRationale: "The counts are read directly from stored accounting states, so the observation is high confidence. How much the uncertainty matters is not established.",
    limitations: ["Settled totals exclude conflicting and ambiguous events by design; the size of the gap is unknown.", "Which interpretation of ambiguous events is correct cannot be determined from the data.", "Sidechain counts use the stored per-record sidechain flag; records whose flag is unknown are not counted as sidechain.", "Identity uncertainty is cleared only when no anonymous record remains for the source. The schema keeps no per-read count, so a source that was resolved and later gains new anonymous records through an append is reported uncertain again.", NO_SAVING],
    assumptions: ["Decisions about usage would otherwise rely on the settled totals."],
    findingVersions: {},
  },
  "REC-USE-MODELS": {
    id: "REC-USE-MODELS",
    version: 3,
    category: "usage-insight",
    title: "Descriptive model usage observation",
    evidenceRequirement: "In RECORDS, over all events (sidechain included): at least 30 settled records; at least 90% of settled records carry a recognized model identifier; at least 2 distinct recognized models; and unresolved records (records in conflicting groups plus ambiguous records) at most 10% of settled plus unresolved records. A recognized identifier follows the policy in model-name.ts (a plain id, optionally with an allowlisted provider prefix, a Vertex-style @date and a context suffix such as [1m]), is at most 64 ASCII characters and is compared case-insensitively.",
    confidenceRationale: "Counts are exact for the ingested transcripts, but they describe only those transcripts, so confidence is medium at most.",
    limitations: ["Describes recorded events only; it does not say whether any model was a good or bad choice.", "No task-quality evidence exists, so it never suggests changing models or claims another model would give the same quality.", "Correlation in the counts implies no cause.", "Transcripts you ingested may not represent all usage.", "Recognition is a shape check, not proof that a model exists; a legitimate provider outside the allowlist is treated as unrecognized.", NO_SAVING],
    assumptions: ["Model identifiers are as recorded in the transcripts; names that fail validation are not attributed to any model."],
    findingVersions: {},
  },
} as const satisfies Record<string, RuleDeclaration>;

export type RecommendationRuleId = keyof typeof RECOMMENDATION_RULES;

/** Percent thresholds are integers so comparisons are exact; "at least"/"at most" are inclusive. */
export const MODEL_RULE_THRESHOLDS = {
  minSettledRecords: 30,
  minModelAttributedPercent: 90,
  minDistinctModels: 2,
  maxUnresolvedPercent: 10,
  maxModelsListed: 5,
} as const;

export const MAX_EVIDENCE_FINDING_IDS = 25;

/** Reason codes attached to each rule outcome. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  met: "The evidence requirement is met.",
  "no-completed-scan": "The data this rule needs has no completed scan yet.",
  "no-matching-findings": "The scan completed and contains no finding this rule can use.",
  "unsupported-finding-version": "Matching findings exist, but from a rule version this recommendation does not understand.",
  "no-inventoried-items": "The completed configuration scan inventoried no items.",
  "unresolved-count-inconsistent": "The stored counts of conflicting groups and records disagree, so the unresolved share cannot be stated.",
  "no-unresolved-usage": "The completed scan shows no conflicting, ambiguous or identity-uncertain usage.",
  "sample-too-small": "There are too few settled records for a descriptive observation.",
  "model-attribution-too-low": "Too many settled records have no recognized model identifier.",
  "single-model": "Settled records use fewer than two distinct recognized models.",
  "unresolved-share-too-high": "Unresolved records are too large a share of all records; resolve them first (see the data-quality recommendation).",
};
