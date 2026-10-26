/**
 * Contracts of the recommendation engine. Recommendations are derived from existing audit findings and
 * usage aggregates at read time. They are suggestions for human review: nothing is applied, stored or
 * executed, and no field can carry file text, paths, commands, environment values or salts.
 */

export const CATEGORIES = ["configuration-hygiene", "context-efficiency", "usage-insight", "data-quality"] as const;
export type RecommendationCategory = (typeof CATEGORIES)[number];

/**
 * Priority is the suggested ORDER OF HUMAN REVIEW, not a measure of harm or saving:
 * - high: reserved; no initial rule emits it.
 * - medium: left unaddressed, a decision or a figure could be misleading.
 * - low: housekeeping worth a look when convenient.
 * - info: an observation; no action is expected.
 */
export const PRIORITIES = ["high", "medium", "low", "info"] as const;
export type RecommendationPriority = (typeof PRIORITIES)[number];

/**
 * Confidence is confidence in the OBSERVATION (that the evidence is accurate as measured), never in
 * the benefit of acting on it. It is the weakest confidence among the findings a recommendation rests
 * on, or the rule's own stated rationale for aggregate metrics. "unknown" means it cannot be supported.
 */
export type RecommendationConfidence = "high" | "medium" | "low" | "unknown";

/**
 * Impact is qualitative and never numeric. "unknown": no measurable evidence of any effect exists, so
 * none is claimed. "limited": a bounded, described effect on interpretation (not on cost or tokens).
 */
export type ImpactLevel = "unknown" | "limited";

export type RecommendationStatus = "informational" | "needs-review";

export type RuleOutcome = "generated" | "not-triggered" | "insufficient-evidence";

/** A finding as the engine sees it. `id` is the stable finding key from the audit. */
export interface EngineFinding {
  readonly id: string;
  /** Opaque id of the inventoried item the finding is about, if any. */
  readonly sourceId: string | null;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly severity: string;
  readonly confidence: string;
  readonly evidence: Readonly<Record<string, number | boolean | string>>;
}

export interface EngineModelUsage {
  /** null when the records carry no model name. */
  readonly name: string | null;
  readonly records: number;
  readonly outputTokens: number;
}

/**
 * Usage aggregates over ALL settled events, sidechain (sub-agent) events included. Unresolved quantities
 * are in RECORDS: `conflictingRecords` is the number of records that sit in conflicting groups, not the
 * number of groups, so it is in the same unit as `settledRecords` and `ambiguousRecords`.
 */
export interface EngineUsage {
  readonly settledRecords: number;
  /** Settled records flagged as sidechain; they are included in `settledRecords`. Only settled records. */
  readonly settledSidechainRecords: number;
  /** Records flagged as sidechain that sit in conflicting groups, and that are ambiguous. Both are unresolved. */
  readonly conflictingSidechainRecords: number;
  readonly ambiguousSidechainRecords: number;
  readonly conflictingGroups: number;
  readonly conflictingRecords: number;
  readonly ambiguousRecords: number;
  readonly duplicates: number;
  /** Sources a rewrite flagged as identity-uncertain that still store anonymous records (see identityUncertainSourceCount). */
  readonly identityUncertainSources: number;
  readonly invalidCounterValues: number;
  readonly missingCounterValues: number;
  readonly models: readonly EngineModelUsage[];
}

/** `null` means the section has no completed scan, which is different from "present but empty". */
export interface EngineInput {
  readonly config: { readonly findings: readonly EngineFinding[]; readonly activation: Readonly<Record<string, number>> } | null;
  readonly usage: EngineUsage | null;
}

export interface EvidenceMetric {
  /** Fixed, rule-defined identifier. */
  readonly name: string;
  readonly value: number;
}

export interface Recommendation {
  /** Stable for the same rule and subject: the rule id, plus ":subject" when a rule yields several. */
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly category: RecommendationCategory;
  readonly priority: RecommendationPriority;
  readonly status: RecommendationStatus;
  readonly title: string;
  readonly explanation: string;
  /** What the data shows. */
  readonly facts: readonly string[];
  /** What is being inferred from the facts; empty when nothing is inferred. */
  readonly inferences: readonly string[];
  readonly evidence: {
    /** Audit finding ids (sorted, capped). `findingCount` in metrics gives the true total. */
    readonly findingIds: readonly string[];
    readonly metrics: readonly EvidenceMetric[];
  };
  readonly confidence: { readonly level: RecommendationConfidence; readonly rationale: string };
  readonly impact: { readonly level: ImpactLevel; readonly statement: string };
  readonly limitations: readonly string[];
  readonly assumptions: readonly string[];
  /** A safe action for a human. Never an instruction to this tool to change anything. */
  readonly nextStep: string;
}

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly title: string;
  readonly category: RecommendationCategory;
  readonly evidenceRequirement: string;
  readonly outcome: RuleOutcome;
  /** Fixed code, see REASON_TEXT. */
  readonly reason: string;
}

export interface EngineResult {
  readonly recommendations: readonly Recommendation[];
  readonly rules: readonly RuleEvaluation[];
}
