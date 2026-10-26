/**
 * Deterministic recommendation engine. Pure: the same input and rule versions always give the same
 * output, in the same order. It reads nothing, writes nothing and calls no model.
 */
import { RECOMMENDATION_RULES, type RecommendationRuleId } from "./catalog";
import { EVALUATORS } from "./evaluate";
import { CATEGORIES, PRIORITIES, type EngineInput, type EngineResult, type Recommendation, type RuleEvaluation } from "./types";

const RULE_ORDER = Object.keys(RECOMMENDATION_RULES) as RecommendationRuleId[];

const priorityRank = (r: Recommendation) => PRIORITIES.indexOf(r.priority);
const categoryRank = (r: Recommendation) => CATEGORIES.indexOf(r.category);

export function compareRecommendations(a: Recommendation, b: Recommendation): number {
  return priorityRank(a) - priorityRank(b) || categoryRank(a) - categoryRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Equivalent recommendations share an id; the first in rule order wins, so the result is order-independent. */
export function dedupeById(items: readonly Recommendation[]): Recommendation[] {
  const seen = new Map<string, Recommendation>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

export function recommend(input: EngineInput): EngineResult {
  const all: Recommendation[] = [];
  const rules: RuleEvaluation[] = [];
  for (const id of RULE_ORDER) {
    const decl = RECOMMENDATION_RULES[id];
    const evaluation = EVALUATORS[id](input);
    all.push(...evaluation.recommendations);
    rules.push({
      ruleId: decl.id,
      ruleVersion: decl.version,
      title: decl.title,
      category: decl.category,
      evidenceRequirement: decl.evidenceRequirement,
      outcome: evaluation.outcome,
      reason: evaluation.reason,
    });
  }
  return { recommendations: dedupeById(all).sort(compareRecommendations), rules };
}
