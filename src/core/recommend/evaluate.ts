import { MAX_EVIDENCE_FINDING_IDS, MODEL_RULE_THRESHOLDS, RECOMMENDATION_RULES, type RecommendationRuleId, type RuleDeclaration } from "./catalog";
import { compareCodeUnits, recognizeModelName } from "./model-name";
import type {
  EngineFinding,
  EngineInput,
  EngineUsage,
  EvidenceMetric,
  Recommendation,
  RecommendationConfidence,
  RecommendationPriority,
  RuleOutcome,
} from "./types";

export interface Evaluation {
  readonly outcome: RuleOutcome;
  readonly reason: string;
  readonly recommendations: readonly Recommendation[];
}

const CONFIDENCE_RANK: Readonly<Record<string, number>> = { high: 3, medium: 2, low: 1 };
const REVIEW_STEP = "Review the items named in the Configuration audit (finding ids below) yourself and decide whether anything should change. Any change is yours to make, outside this tool; nothing has been applied.";

const none = (outcome: RuleOutcome, reason: string): Evaluation => ({ outcome, reason, recommendations: [] });
const generated = (...recommendations: Recommendation[]): Evaluation => ({ outcome: "generated", reason: "met", recommendations });
const metric = (name: string, value: number): EvidenceMetric => ({ name, value });
const num = (e: EngineFinding, key: string): number => (typeof e.evidence[key] === "number" ? (e.evidence[key] as number) : 0);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The weakest confidence among findings; "unknown" when there are none or a value is unrecognized. */
export function weakestConfidence(findings: readonly EngineFinding[]): RecommendationConfidence {
  let rank = Number.POSITIVE_INFINITY;
  for (const f of findings) rank = Math.min(rank, CONFIDENCE_RANK[f.confidence] ?? 0);
  return rank === 3 ? "high" : rank === 2 ? "medium" : rank === 1 ? "low" : "unknown";
}

function idsOf(findings: readonly EngineFinding[]): string[] {
  return [...new Set(findings.map((f) => f.id))].sort().slice(0, MAX_EVIDENCE_FINDING_IDS);
}

/** Findings of one audit rule, split into those whose rule version this recommendation understands and the rest. */
function usable(decl: RuleDeclaration, findings: readonly EngineFinding[], auditRuleId: string): { ok: EngineFinding[]; ignored: number } {
  const versions = decl.findingVersions[auditRuleId] ?? [];
  const matching = findings.filter((f) => f.ruleId === auditRuleId);
  const ok = matching.filter((f) => versions.includes(f.ruleVersion));
  return { ok, ignored: matching.length - ok.length };
}

function noneUsable(ignored: number): Evaluation {
  return none(ignored > 0 ? "insufficient-evidence" : "not-triggered", ignored > 0 ? "unsupported-finding-version" : "no-matching-findings");
}

function base(rule: RecommendationRuleId, subject: string | null) {
  const decl: RuleDeclaration = RECOMMENDATION_RULES[rule];
  return {
    id: subject ? `${decl.id}:${subject}` : decl.id,
    ruleId: decl.id,
    ruleVersion: decl.version,
    category: decl.category,
    limitations: decl.limitations,
    assumptions: decl.assumptions,
  };
}

function duplicates(input: EngineInput): Evaluation {
  const decl = RECOMMENDATION_RULES["REC-CFG-DUP"];
  if (!input.config) return none("insufficient-evidence", "no-completed-scan");
  const { ok, ignored } = usable(decl, input.config.findings, "CFG-DUP-001");
  const groups = ok.filter((f) => num(f, "fileCount") >= 2);
  if (groups.length === 0) return noneUsable(ignored);

  const items = groups.reduce((n, f) => n + num(f, "fileCount"), 0);
  const crossScope = groups.filter((f) => f.evidence.crossScope === true).length;
  return generated({
    ...base("REC-CFG-DUP", null),
    priority: "low",
    status: "needs-review",
    title: decl.title,
    explanation: "Some inventoried items have byte-identical content. Identical copies are a possible source of maintenance drift, but they may also be intentional.",
    facts: [`${plural(groups.length, "group", "groups")} of items with identical content ${groups.length === 1 ? "was" : "were"} found, covering ${items} items in total.`, `${plural(crossScope, "group spans", "groups span")} both user and project scope.`],
    inferences: ["Some of the copies may be unnecessary."],
    evidence: { findingIds: idsOf(groups), metrics: [metric("findingCount", groups.length), metric("itemsInGroups", items), metric("crossScopeGroups", crossScope)] },
    confidence: { level: weakestConfidence(groups), rationale: decl.confidenceRationale },
    impact: { level: "unknown", statement: "No measurable effect is established. Whether the copies are loaded, and what they cost if they are, is unknown." },
    nextStep: REVIEW_STEP,
  });
}

function conflicts(input: EngineInput): Evaluation {
  const decl = RECOMMENDATION_RULES["REC-CFG-CONFLICT"];
  if (!input.config) return none("insufficient-evidence", "no-completed-scan");
  const instructions = usable(decl, input.config.findings, "CFG-CONF-001");
  const permissions = usable(decl, input.config.findings, "CFG-CONF-002");
  if (instructions.ok.length === 0 && permissions.ok.length === 0) return noneUsable(instructions.ignored + permissions.ignored);

  const out: Recommendation[] = [];
  if (instructions.ok.length > 0) {
    const f = instructions.ok;
    const sameFile = f.filter((x) => x.evidence.sameFile === true).length;
    out.push({
      ...base("REC-CFG-CONFLICT", "instructions"),
      priority: "medium",
      status: "needs-review",
      title: "Review instructions that may say always and never about the same thing",
      explanation: "Lines starting with always and never were found with identical wording after that word. The check is textual only and cannot tell whether they apply in the same context.",
      facts: [`${plural(f.length, "such pair was", "such pairs were")} found, ${sameFile} within a single item and ${f.length - sameFile} across items.`],
      inferences: ["The paired lines might contradict each other when applied together."],
      evidence: { findingIds: idsOf(f), metrics: [metric("findingCount", f.length), metric("sameItemPairs", sameFile)] },
      confidence: { level: weakestConfidence(f), rationale: decl.confidenceRationale },
      impact: { level: "unknown", statement: "A real contradiction could make Claude's behavior harder to predict, but no effect is measured here." },
      nextStep: REVIEW_STEP,
    });
  }
  if (permissions.ok.length > 0) {
    const f = permissions.ok;
    // Per-file and per-pair findings repeat the same rule text, so their counts are never summed. Audit rule
    // v2 records the scan-wide distinct count on every finding; older findings only allow a lower bound.
    const exact = f.every((x) => typeof x.evidence.distinctRules === "number");
    const distinct = Math.max(...f.map((x) => Math.max(num(x, "distinctRules"), num(x, "overlappingRules"))));
    const reported = plural(f.length, "finding", "findings");
    out.push({
      ...base("REC-CFG-CONFLICT", "permissions"),
      priority: "medium",
      status: "needs-review",
      title: "Review permission rules that appear in both allow and deny lists",
      explanation: "The same permission rule text appears in an allow list and a deny list. Which one wins is not evaluated here.",
      facts: [
        exact
          ? `${plural(distinct, "distinct permission rule appears", "distinct permission rules appear")} in both an allow list and a deny list, reported by ${reported} because each file and each file pair is reported separately.`
          : `At least ${plural(distinct, "distinct permission rule appears", "distinct permission rules appear")} in both an allow list and a deny list (a lower bound: ${reported} from an older audit rule version did not record the distinct count).`,
      ],
      inferences: ["One of the two entries may be unintended."],
      evidence: { findingIds: idsOf(f), metrics: [metric("findingCount", f.length), metric(exact ? "distinctOverlappingRules" : "distinctOverlappingRulesAtLeast", distinct)] },
      confidence: { level: weakestConfidence(f), rationale: decl.confidenceRationale },
      impact: { level: "unknown", statement: "Precedence between allow and deny rules is not verified, so the effect on what is permitted is unknown." },
      nextStep: REVIEW_STEP,
    });
  }
  return generated(...out);
}

function size(input: EngineInput): Evaluation {
  const decl = RECOMMENDATION_RULES["REC-CTX-SIZE"];
  if (!input.config) return none("insufficient-evidence", "no-completed-scan");
  const large = usable(decl, input.config.findings, "CFG-SIZE-001");
  const veryLarge = usable(decl, input.config.findings, "CFG-SIZE-002");
  if (large.ok.length === 0 && veryLarge.ok.length === 0) return noneUsable(large.ignored + veryLarge.ignored);

  // One item is one issue: if it is flagged at both thresholds only the stronger finding counts.
  const strongestPerItem = collapsePerItem(large.ok, veryLarge.ok);
  const veryLargeCount = strongestPerItem.filter((f) => f.ruleId === "CFG-SIZE-002").length;
  const maxTokens = Math.max(...strongestPerItem.map((f) => num(f, "estimatedTokens")));
  const maxLines = Math.max(...strongestPerItem.map((f) => num(f, "lines")));
  return generated({
    ...base("REC-CTX-SIZE", null),
    priority: veryLargeCount > 0 ? "medium" : "low",
    status: "needs-review",
    title: decl.title,
    explanation: "Some instruction items are large by a rough size estimate. Large items can be harder to review and keep consistent.",
    facts: [`${plural(strongestPerItem.length, "item exceeds", "items exceed")} the size thresholds, ${veryLargeCount} of them the very-large threshold.`, `The largest is about ${maxTokens} estimated tokens over ${maxLines} lines (estimates, not tokenizer output).`],
    inferences: ["Splitting rarely needed parts into separate files might make the instructions easier to maintain."],
    evidence: { findingIds: idsOf(strongestPerItem), metrics: [metric("findingCount", strongestPerItem.length), metric("veryLargeItems", veryLargeCount), metric("maxEstimatedTokens", maxTokens), metric("maxLines", maxLines)] },
    confidence: { level: weakestConfidence(strongestPerItem), rationale: decl.confidenceRationale },
    impact: { level: "unknown", statement: "Whether these items are loaded is unknown, and no token or cost effect is measured, so none is claimed." },
    nextStep: REVIEW_STEP,
  });
}

/** One finding per inventoried item: later (stronger) findings replace earlier ones for the same item. */
function collapsePerItem(large: readonly EngineFinding[], veryLarge: readonly EngineFinding[]): EngineFinding[] {
  const strongest = new Map<string, EngineFinding>();
  for (const f of [...large, ...veryLarge]) strongest.set(f.sourceId ?? f.id, f);
  return [...strongest.values()];
}

const ACTIVATION_METRICS: Readonly<Record<string, string>> = {
  "unverified-candidate": "itemsUnverifiedCandidate",
  conditional: "itemsConditional",
  "on-demand": "itemsOnDemand",
  "import-only": "itemsImportOnly",
  unknown: "itemsUnknown",
};

const ACTIVATION_LABEL: Readonly<Record<string, string>> = {
  "unverified-candidate": "unverified candidate",
  conditional: "conditional",
  "on-demand": "on-demand",
  "import-only": "import-only",
  unknown: "unknown",
};

/**
 * Inventory-level observation: the limitation applies to EVERY inventoried item, so it is taken from the
 * inventory counts. CFG-ACT-001 findings exist only for non-candidate items and are cited as support.
 */
function activation(input: EngineInput): Evaluation {
  const decl = RECOMMENDATION_RULES["REC-CFG-ACTIVATION"];
  if (!input.config) return none("insufficient-evidence", "no-completed-scan");
  const counts = Object.keys(ACTIVATION_METRICS).map((status) => ({ status, items: input.config?.activation[status] ?? 0 }));
  const total = counts.reduce((n, c) => n + c.items, 0);
  if (total === 0) return none("not-triggered", "no-inventoried-items");

  const { ok } = usable(decl, input.config.findings, "CFG-ACT-001");
  const breakdown = counts.filter((c) => c.items > 0).map((c) => `${c.items} ${ACTIVATION_LABEL[c.status] ?? c.status}`).join(", ");
  return generated({
    ...base("REC-CFG-ACTIVATION", null),
    priority: "info",
    status: "informational",
    title: decl.title,
    explanation: "A file found on disk is not proof that Claude Code loads it. This scan reads files only and cannot observe what is active in a session, for any inventoried item.",
    facts: [`${plural(total, "item was", "items were")} inventoried on disk (${breakdown}).`, "A file scan cannot establish whether any of them is active or loaded, whatever its status label."],
    inferences: [],
    evidence: {
      findingIds: idsOf(ok),
      metrics: [
        metric("inventoriedItems", total),
        ...counts.filter((c) => c.items > 0).map((c) => metric(ACTIVATION_METRICS[c.status] ?? c.status, c.items)),
        ...(ok.length > 0 ? [metric("findingCount", ok.length)] : []),
      ],
    },
    confidence: { level: ok.length > 0 ? weakestConfidence(ok) : "high", rationale: decl.confidenceRationale },
    impact: { level: "unknown", statement: "None claimed. Do not infer cost or behavior from the existence or size of an item." },
    nextStep: "Treat inventoried items as present, not as loaded. If you need to know what is active, check it in Claude Code itself; this tool does not verify it. Do not delete or rewrite an item only because its activation is unknown.",
  });
}

function accounting(input: EngineInput): Evaluation {
  const decl = RECOMMENDATION_RULES["REC-DQ-ACCOUNTING"];
  const u = input.usage;
  if (!u) return none("insufficient-evidence", "no-completed-scan");
  if (u.conflictingGroups === 0 && u.conflictingRecords === 0 && u.ambiguousRecords === 0 && u.identityUncertainSources === 0) return none("not-triggered", "no-unresolved-usage");

  const facts = [
    "Scope: all events, with sidechain (sub-agent) events included.",
    `Sidechain records by state: ${u.settledSidechainRecords} settled, ${u.conflictingSidechainRecords} in conflicting groups, ${u.ambiguousSidechainRecords} ambiguous (records with an unknown sidechain flag are not counted as sidechain).`,
    `${u.settledRecords} settled records are counted in the settled totals.`,
  ];
  if (u.conflictingGroups > 0) facts.push(`${plural(u.conflictingGroups, "group", "groups")} (${plural(u.conflictingRecords, "record", "records")}) share an identity but report different counters; they are shown as ranges, not totals.`);
  if (u.ambiguousRecords > 0) facts.push(`${plural(u.ambiguousRecords, "record has", "records have")} no reliable identity, so repeats cannot be told from distinct calls.`);
  if (u.identityUncertainSources > 0) facts.push(`${plural(u.identityUncertainSources, "source has", "sources have")} uncertain anonymous identity: a rewrite could not link its anonymous records to the previous version, and those records are still stored.`);
  if (u.duplicates > 0) facts.push(`${plural(u.duplicates, "identical repeat was", "identical repeats were")} excluded as duplicates.`);
  const priority: RecommendationPriority = u.conflictingGroups > 0 ? "medium" : "low";
  return generated({
    ...base("REC-DQ-ACCOUNTING", null),
    priority,
    status: "needs-review",
    title: decl.title,
    explanation: "Some usage events cannot be reduced to one number without an assumption, so they are kept out of the settled totals. Relying on the totals alone for a decision may understate or misstate usage.",
    facts,
    inferences: ["The settled totals may be incomplete by an unknown amount."],
    evidence: {
      findingIds: [],
      metrics: [metric("settledRecords", u.settledRecords), metric("settledSidechainRecords", u.settledSidechainRecords), metric("conflictingSidechainRecords", u.conflictingSidechainRecords), metric("ambiguousSidechainRecords", u.ambiguousSidechainRecords), metric("conflictingGroups", u.conflictingGroups), metric("conflictingRecords", u.conflictingRecords), metric("ambiguousRecords", u.ambiguousRecords), metric("duplicatesExcluded", u.duplicates), metric("identityUncertainSources", u.identityUncertainSources), metric("invalidCounterValues", u.invalidCounterValues), metric("missingCounterValues", u.missingCounterValues)],
    },
    confidence: { level: "high", rationale: decl.confidenceRationale },
    impact: { level: "limited", statement: "Affects how far the settled totals can be trusted. It does not by itself indicate cost or waste." },
    nextStep: "Before relying on the totals, look at Data quality: check whether the same transcripts were ingested from more than one source, and re-ingest an explicit file list if that is the cause. Treat ranges and alternatives as ranges until resolved.",
  });
}

/** Settled records per recognized model (case-insensitive); everything else is one unattributed total. */
function attribute(u: EngineUsage): { byModel: { name: string; records: number; outputTokens: number }[]; attributed: number; unattributed: number } {
  const byName = new Map<string, { records: number; outputTokens: number }>();
  let unattributed = 0;
  for (const m of u.models) {
    const name = recognizeModelName(m.name);
    if (name === null) {
      unattributed += m.records;
      continue;
    }
    const prior = byName.get(name) ?? { records: 0, outputTokens: 0 };
    byName.set(name, { records: prior.records + m.records, outputTokens: prior.outputTokens + m.outputTokens });
  }
  const byModel = [...byName].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.records - a.records || compareCodeUnits(a.name, b.name));
  return { byModel, attributed: byModel.reduce((n, m) => n + m.records, 0), unattributed };
}

function models(input: EngineInput): Evaluation {
  const decl = RECOMMENDATION_RULES["REC-USE-MODELS"];
  const t = MODEL_RULE_THRESHOLDS;
  const u: EngineUsage | null = input.usage;
  if (!u) return none("insufficient-evidence", "no-completed-scan");
  if (u.settledRecords < t.minSettledRecords) return none("insufficient-evidence", "sample-too-small");

  // Unresolved share, all in records: records inside conflicting groups plus ambiguous records, against
  // settled plus those. Every conflicting group holds at least two records, so fewer is a contradiction.
  if ((u.conflictingGroups > 0 && u.conflictingRecords < 2 * u.conflictingGroups) || (u.conflictingGroups === 0 && u.conflictingRecords > 0)) {
    return none("insufficient-evidence", "unresolved-count-inconsistent");
  }
  const unresolved = u.conflictingRecords + u.ambiguousRecords;
  if (unresolved * 100 > t.maxUnresolvedPercent * (u.settledRecords + unresolved)) return none("insufficient-evidence", "unresolved-share-too-high");

  const { byModel, attributed, unattributed } = attribute(u);
  if (attributed * 100 < t.minModelAttributedPercent * u.settledRecords) return none("insufficient-evidence", "model-attribution-too-low");
  if (byModel.length < t.minDistinctModels) return none("not-triggered", "single-model");

  const pct = (part: number, whole: number) => Math.round((part / whole) * 100);
  const outputTotal = byModel.reduce((n, m) => n + m.outputTokens, 0);
  const top = byModel[0];
  return generated({
    ...base("REC-USE-MODELS", null),
    priority: "info",
    status: "informational",
    title: decl.title,
    explanation: "A description of how settled usage events are spread across models in the ingested transcripts. It is an observation, not advice to change anything.",
    facts: [
      `Scope: all settled events, sidechain (sub-agent) events included: ${plural(u.settledSidechainRecords, "settled sidechain record is", "settled sidechain records are")} counted here, and ${plural(u.conflictingSidechainRecords + u.ambiguousSidechainRecords, "unresolved sidechain record is", "unresolved sidechain records are")} excluded with all other unresolved events. The Usage page's sidechain filter does not apply.`,
      `Settled usage covers ${plural(byModel.length, "recognized model", "recognized models")} across ${attributed} attributed settled records.`,
      ...byModel.slice(0, t.maxModelsListed).map((m) => `${m.name}: ${plural(m.records, "record", "records")} (${pct(m.records, attributed)}% of attributed settled records).`),
      ...(unattributed > 0 ? [`${plural(unattributed, "settled record has", "settled records have")} no recognized model identifier and ${unattributed === 1 ? "is" : "are"} not attributed to any model.`] : []),
      "Conflicting and ambiguous events are excluded from these counts.",
    ],
    inferences: [],
    evidence: {
      findingIds: [],
      metrics: [
        metric("settledRecords", u.settledRecords),
        metric("settledSidechainRecords", u.settledSidechainRecords),
        metric("unresolvedSidechainRecords", u.conflictingSidechainRecords + u.ambiguousSidechainRecords),
        metric("distinctModels", byModel.length),
        metric("modelAttributedRecords", attributed),
        metric("unattributedRecords", unattributed),
        metric("topModelRecordSharePct", top ? pct(top.records, attributed) : 0),
        metric("topModelOutputTokenSharePct", top && outputTotal > 0 ? pct(top.outputTokens, outputTotal) : 0),
      ],
    },
    confidence: { level: "medium", rationale: decl.confidenceRationale },
    impact: { level: "unknown", statement: "None claimed. This does not show whether a different model would suit the work, and no task-quality evidence is available." },
    nextStep: "No action is expected. If you are curious about model choice, compare outcomes on your own tasks; this tool cannot judge quality.",
  });
}

export const EVALUATORS: Readonly<Record<RecommendationRuleId, (input: EngineInput) => Evaluation>> = {
  "REC-CFG-DUP": duplicates,
  "REC-CFG-CONFLICT": conflicts,
  "REC-CTX-SIZE": size,
  "REC-CFG-ACTIVATION": activation,
  "REC-DQ-ACCOUNTING": accounting,
  "REC-USE-MODELS": models,
};
