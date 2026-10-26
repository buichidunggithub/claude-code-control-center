import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  MAX_EVIDENCE_FINDING_IDS,
  MODEL_RULE_THRESHOLDS,
  compareRecommendations,
  dedupeById,
  PRIORITIES,
  RECOMMENDATION_RULES,
  compareCodeUnits,
  recognizeModelName,
  recommend,
  type EngineFinding,
  type EngineInput,
  type EngineUsage,
  type Recommendation,
} from "@/core/recommend";

const NEGATION = /\b(no|not|never|none|nor|nothing|unmeasured|neither|without|unknown)\b/i;

/** Sentences that use one of the words without a negation or qualification in the same sentence. */
function unqualified(text: string, words: RegExp): string[] {
  return text.split(/(?<=[.;])\s+|","|"\]/).filter((sentence) => words.test(sentence) && !NEGATION.test(sentence));
}

let counter = 0;
function finding(ruleId: string, evidence: EngineFinding["evidence"] = {}, over: Partial<EngineFinding> = {}): EngineFinding {
  counter += 1;
  return { id: `f${String(counter).padStart(4, "0")}`, sourceId: `cfg_${counter}`, ruleId, ruleVersion: 1, severity: "low", confidence: "high", evidence, ...over };
}

const config = (findings: EngineFinding[], activation: Record<string, number> = {}): EngineInput => ({ config: { findings, activation }, usage: null });
const quietUsage: EngineUsage = { settledRecords: 50, settledSidechainRecords: 0, conflictingSidechainRecords: 0, ambiguousSidechainRecords: 0, conflictingGroups: 0, conflictingRecords: 0, ambiguousRecords: 0, duplicates: 0, identityUncertainSources: 0, invalidCounterValues: 0, missingCounterValues: 0, models: [] };
const usage = (over: Partial<EngineUsage>): EngineInput => ({ config: null, usage: { ...quietUsage, ...over } });
const both = (cfg: EngineFinding[], u: Partial<EngineUsage> = {}): EngineInput => ({ config: { findings: cfg, activation: {} }, usage: { ...quietUsage, ...u } });

const byRule = (input: EngineInput, ruleId: string) => recommend(input).recommendations.filter((r) => r.ruleId === ruleId);
const outcomeOf = (input: EngineInput, ruleId: string) => recommend(input).rules.find((r) => r.ruleId === ruleId);

describe("rule catalog", () => {
  it("declares id, version, evidence requirement, confidence rationale and limitations for every rule", () => {
    for (const [key, rule] of Object.entries(RECOMMENDATION_RULES)) {
      expect(rule.id).toBe(key);
      expect(Number.isInteger(rule.version) && rule.version >= 1).toBe(true);
      expect(CATEGORIES).toContain(rule.category);
      expect(rule.evidenceRequirement.length).toBeGreaterThan(30);
      expect(rule.confidenceRationale.length).toBeGreaterThan(30);
      expect(rule.limitations.length).toBeGreaterThan(0);
    }
  });

  it("reports one outcome per rule in catalog order, even for empty input", () => {
    const result = recommend({ config: null, usage: null });
    expect(result.recommendations).toEqual([]);
    expect(result.rules.map((r) => r.ruleId)).toEqual(Object.keys(RECOMMENDATION_RULES));
    expect(result.rules.every((r) => r.outcome === "insufficient-evidence" && r.reason === "no-completed-scan")).toBe(true);
  });
});

describe("REC-CFG-DUP", () => {
  it("recommends review of identical content, citing the findings, without claiming redundancy", () => {
    const a = finding("CFG-DUP-001", { fileCount: 2, sizeBytes: 300, crossScope: true });
    const b = finding("CFG-DUP-001", { fileCount: 3, sizeBytes: 200, crossScope: false }, { confidence: "medium" });
    const [rec] = byRule(config([b, a]), "REC-CFG-DUP");

    expect(rec).toMatchObject({ id: "REC-CFG-DUP", ruleVersion: 1, category: "configuration-hygiene", priority: "low", status: "needs-review" });
    expect(rec?.evidence.findingIds).toEqual([a.id, b.id].sort());
    expect(rec?.evidence.metrics).toEqual([{ name: "findingCount", value: 2 }, { name: "itemsInGroups", value: 5 }, { name: "crossScopeGroups", value: 1 }]);
    expect(rec?.confidence.level).toBe("medium");
    expect(rec?.impact.level).toBe("unknown");
    expect(rec?.inferences.join(" ")).toContain("may be unnecessary");
  });

  it("does not fire on near-duplicates alone, on one-item groups or on a scan with no findings", () => {
    expect(byRule(config([finding("CFG-DUP-002", { sharedLines: 9, similarityPct: 95 })]), "REC-CFG-DUP")).toEqual([]);
    expect(byRule(config([finding("CFG-DUP-001", { fileCount: 1 })]), "REC-CFG-DUP")).toEqual([]);
    expect(outcomeOf(config([]), "REC-CFG-DUP")).toMatchObject({ outcome: "not-triggered", reason: "no-matching-findings" });
  });

  it("has insufficient evidence without a completed configuration scan, or with an unsupported finding version", () => {
    expect(outcomeOf({ config: null, usage: null }, "REC-CFG-DUP")).toMatchObject({ outcome: "insufficient-evidence", reason: "no-completed-scan" });
    const future = finding("CFG-DUP-001", { fileCount: 2 }, { ruleVersion: 2 });
    expect(byRule(config([future]), "REC-CFG-DUP")).toEqual([]);
    expect(outcomeOf(config([future]), "REC-CFG-DUP")).toMatchObject({ outcome: "insufficient-evidence", reason: "unsupported-finding-version" });
  });
});

describe("REC-CFG-CONFLICT", () => {
  it("surfaces instruction and permission overlaps as separate recommendations with the weakest confidence", () => {
    const i1 = finding("CFG-CONF-001", { sameFile: true }, { confidence: "medium" });
    const i2 = finding("CFG-CONF-001", { sameFile: false }, { confidence: "low" });
    const p1 = finding("CFG-CONF-002", { overlappingRules: 2, sameFile: true });
    const recs = byRule(config([i1, i2, p1]), "REC-CFG-CONFLICT");

    expect(recs.map((r) => r.id)).toEqual(["REC-CFG-CONFLICT:instructions", "REC-CFG-CONFLICT:permissions"]);
    const [instructions, permissions] = recs;
    expect(instructions).toMatchObject({ priority: "medium", status: "needs-review" });
    expect(instructions?.confidence.level).toBe("low");
    expect(instructions?.evidence.metrics).toEqual([{ name: "findingCount", value: 2 }, { name: "sameItemPairs", value: 1 }]);
    expect(permissions?.confidence.level).toBe("high");
    // These findings predate the distinct count, so the rule reports a lower bound, never a sum.
    expect(permissions?.evidence.metrics).toEqual([{ name: "findingCount", value: 1 }, { name: "distinctOverlappingRulesAtLeast", value: 2 }]);
    expect(permissions?.facts[0]).toMatch(/^At least 2 distinct permission rules appear/);
    for (const r of recs) {
      expect(r.limitations.join(" ")).toMatch(/not understood or evaluated|Precedence|conflict/i);
      expect(r.inferences.every((t) => /might|may/.test(t))).toBe(true);
    }
  });

  it("emits only the variant that has evidence, and nothing otherwise", () => {
    expect(byRule(config([finding("CFG-CONF-002", { overlappingRules: 1 })]), "REC-CFG-CONFLICT").map((r) => r.id)).toEqual(["REC-CFG-CONFLICT:permissions"]);
    expect(byRule(config([finding("CFG-HOOK-001", { occurrences: 2 })]), "REC-CFG-CONFLICT")).toEqual([]);
    expect(outcomeOf(config([]), "REC-CFG-CONFLICT")?.outcome).toBe("not-triggered");
  });
});

describe("REC-CTX-SIZE", () => {
  it("recommends reviewing large files, claiming no token reduction", () => {
    const large = finding("CFG-SIZE-001", { estimatedTokens: 5000, lines: 400 }, { confidence: "medium" });
    const [rec] = byRule(config([large]), "REC-CTX-SIZE");

    expect(rec).toMatchObject({ id: "REC-CTX-SIZE", category: "context-efficiency", priority: "low", status: "needs-review" });
    expect(rec?.confidence.level).toBe("medium");
    expect(rec?.impact).toMatchObject({ level: "unknown" });
    expect(rec?.evidence.metrics).toContainEqual({ name: "maxEstimatedTokens", value: 5000 });
    expect(unqualified(JSON.stringify(rec), /\b(reduce|reduces|save|saves|saving|savings|cheaper|faster)\b/i)).toEqual([]);
  });

  it("counts an item flagged at both thresholds once, as very large, and raises priority", () => {
    const shared = "cfg_same";
    const both1 = finding("CFG-SIZE-001", { estimatedTokens: 13000, lines: 900 }, { sourceId: shared });
    const both2 = finding("CFG-SIZE-002", { estimatedTokens: 13000, lines: 900 }, { sourceId: shared });
    const other = finding("CFG-SIZE-001", { estimatedTokens: 4500, lines: 310 });
    const [rec] = byRule(config([both1, both2, other]), "REC-CTX-SIZE");

    expect(rec?.priority).toBe("medium");
    expect(rec?.evidence.findingIds).toEqual([both2.id, other.id].sort());
    expect(rec?.evidence.metrics).toEqual([{ name: "findingCount", value: 2 }, { name: "veryLargeItems", value: 1 }, { name: "maxEstimatedTokens", value: 13000 }, { name: "maxLines", value: 900 }]);
  });

  it("does not fire on a file that was too large to analyze, or without findings", () => {
    expect(byRule(config([finding("CFG-SIZE-003", { sizeBytes: 9e6, limitBytes: 1e6 })]), "REC-CTX-SIZE")).toEqual([]);
    expect(byRule(config([]), "REC-CTX-SIZE")).toEqual([]);
  });
});

describe("REC-CFG-ACTIVATION", () => {
  it("covers every inventoried item, not only those with a CFG-ACT-001 finding, and never suggests deletion", () => {
    const a = finding("CFG-ACT-001", { basis: "on-demand-agent", activation: "on-demand" });
    const [rec] = byRule(config([a], { "on-demand": 1, "unverified-candidate": 4, loaded: 9 }), "REC-CFG-ACTIVATION");

    expect(rec).toMatchObject({ ruleVersion: 2, priority: "info", status: "informational", category: "configuration-hygiene" });
    expect(rec?.facts[0]).toBe("5 items were inventoried on disk (4 unverified candidate, 1 on-demand).");
    expect(rec?.facts[1]).toMatch(/cannot establish whether any of them is active or loaded/);
    expect(rec?.evidence.findingIds).toEqual([a.id]);
    expect(rec?.evidence.metrics).toEqual([{ name: "inventoriedItems", value: 5 }, { name: "itemsUnverifiedCandidate", value: 4 }, { name: "itemsOnDemand", value: 1 }, { name: "findingCount", value: 1 }]);
    expect(rec?.nextStep).toMatch(/Do not delete or rewrite an item only because its activation is unknown/);
    expect(rec?.nextStep).toMatch(/present, not as loaded/);
    expect(rec?.inferences).toEqual([]);
    expect(rec?.confidence.level).toBe("high");
  });

  it("fires from the inventory alone when every item is an unverified candidate (no findings exist)", () => {
    const [rec] = byRule(config([], { "unverified-candidate": 3 }), "REC-CFG-ACTIVATION");
    expect(rec?.facts[0]).toBe("3 items were inventoried on disk (3 unverified candidate).");
    expect(rec?.evidence.findingIds).toEqual([]);
    expect(rec?.evidence.metrics).toEqual([{ name: "inventoriedItems", value: 3 }, { name: "itemsUnverifiedCandidate", value: 3 }]);
  });

  it("describes a mixed inventory with every status that is present", () => {
    const [rec] = byRule(config([], { "unverified-candidate": 2, conditional: 1, "on-demand": 4, "import-only": 1, unknown: 2 }), "REC-CFG-ACTIVATION");
    expect(rec?.facts[0]).toBe("10 items were inventoried on disk (2 unverified candidate, 1 conditional, 4 on-demand, 1 import-only, 2 unknown).");
    expect(rec?.evidence.metrics.map((m) => m.name)).toEqual(["inventoriedItems", "itemsUnverifiedCandidate", "itemsConditional", "itemsOnDemand", "itemsImportOnly", "itemsUnknown"]);
  });

  it("does not fire for an empty inventory or without a completed configuration scan", () => {
    expect(byRule(config([], {}), "REC-CFG-ACTIVATION")).toEqual([]);
    expect(outcomeOf(config([], {}), "REC-CFG-ACTIVATION")).toMatchObject({ outcome: "not-triggered", reason: "no-inventoried-items" });
    expect(outcomeOf(config([], { loaded: 5 }), "REC-CFG-ACTIVATION")?.outcome).toBe("not-triggered");
    expect(outcomeOf({ config: null, usage: null }, "REC-CFG-ACTIVATION")).toMatchObject({ outcome: "insufficient-evidence", reason: "no-completed-scan" });
  });

  it("ignores CFG-ACT-001 findings of an unsupported version as citations, but still reports the inventory", () => {
    const future = finding("CFG-ACT-001", {}, { ruleVersion: 2 });
    const [rec] = byRule(config([future], { "on-demand": 1 }), "REC-CFG-ACTIVATION");
    expect(rec?.evidence.findingIds).toEqual([]);
  });
});

describe("REC-DQ-ACCOUNTING", () => {
  it("recommends resolving conflicts before relying on totals, at medium priority", () => {
    const [rec] = byRule(usage({ conflictingGroups: 2, conflictingRecords: 5, ambiguousRecords: 3, duplicates: 4, invalidCounterValues: 1, settledSidechainRecords: 7, conflictingSidechainRecords: 2, ambiguousSidechainRecords: 1 }), "REC-DQ-ACCOUNTING");

    expect(rec).toMatchObject({ category: "data-quality", priority: "medium", status: "needs-review" });
    expect(rec?.confidence.level).toBe("high");
    expect(rec?.impact.level).toBe("limited");
    expect(rec?.evidence.findingIds).toEqual([]);
    expect(rec?.evidence.metrics).toContainEqual({ name: "conflictingGroups", value: 2 });
    expect(rec?.evidence.metrics).toContainEqual({ name: "conflictingRecords", value: 5 });
    expect(rec?.ruleVersion).toBe(3);
    expect(rec?.evidence.metrics).toContainEqual({ name: "settledSidechainRecords", value: 7 });
    expect(rec?.evidence.metrics).toContainEqual({ name: "conflictingSidechainRecords", value: 2 });
    expect(rec?.evidence.metrics).toContainEqual({ name: "ambiguousSidechainRecords", value: 1 });
    expect(rec?.facts[0]).toBe("Scope: all events, with sidechain (sub-agent) events included.");
    expect(rec?.facts[1]).toBe("Sidechain records by state: 7 settled, 2 in conflicting groups, 1 ambiguous (records with an unknown sidechain flag are not counted as sidechain).");
    expect(rec?.facts.join(" ")).not.toMatch(/all events, including/);
    expect(rec?.facts.join(" ")).toMatch(/2 groups \(5 records\) share an identity/);
    expect(rec?.facts.join(" ")).toMatch(/shown as ranges, not totals/);
  });

  it("is low priority when only ambiguity exists, and triggers on uncertain identity alone", () => {
    expect(byRule(usage({ ambiguousRecords: 1 }), "REC-DQ-ACCOUNTING")[0]?.priority).toBe("low");
    expect(byRule(usage({ identityUncertainSources: 1 }), "REC-DQ-ACCOUNTING")).toHaveLength(1);
  });

  it("does not fire on clean usage or without a completed usage scan", () => {
    expect(outcomeOf(usage({}), "REC-DQ-ACCOUNTING")).toMatchObject({ outcome: "not-triggered", reason: "no-unresolved-usage" });
    expect(outcomeOf({ config: null, usage: null }, "REC-DQ-ACCOUNTING")?.outcome).toBe("insufficient-evidence");
  });
});

describe("REC-USE-MODELS", () => {
  const t = MODEL_RULE_THRESHOLDS;
  const two = [{ name: "model-alpha", records: 70, outputTokens: 700 }, { name: "model-beta", records: 30, outputTokens: 300 }];
  const adequate = (over: Partial<EngineUsage> = {}) => usage({ settledRecords: 100, models: two, ...over });
  const outcome = (over: Partial<EngineUsage>) => outcomeOf(adequate(over), "REC-USE-MODELS");

  it("describes the distribution, states its scope, and gives no advice", () => {
    const [rec] = byRule(adequate({ settledSidechainRecords: 12, conflictingSidechainRecords: 2, ambiguousSidechainRecords: 1 }), "REC-USE-MODELS");

    expect(rec).toMatchObject({ ruleVersion: 3, category: "usage-insight", priority: "info", status: "informational" });
    expect(rec?.facts[0]).toBe("Scope: all settled events, sidechain (sub-agent) events included: 12 settled sidechain records are counted here, and 3 unresolved sidechain records are excluded with all other unresolved events. The Usage page's sidechain filter does not apply.");
    expect(rec?.evidence.metrics).toContainEqual({ name: "unresolvedSidechainRecords", value: 3 });
    expect(rec?.facts).toContain("model-alpha: 70 records (70% of attributed settled records).");
    expect(rec?.facts).toContain("model-beta: 30 records (30% of attributed settled records).");
    expect(rec?.evidence.metrics).toContainEqual({ name: "settledSidechainRecords", value: 12 });
    expect(rec?.evidence.metrics).toContainEqual({ name: "topModelRecordSharePct", value: 70 });
    expect(rec?.confidence.level).toBe("medium");
    expect(rec?.impact.level).toBe("unknown");
    expect(rec?.inferences).toEqual([]);
    expect(rec?.limitations.join(" ")).toMatch(/never suggests changing models/);
    expect(JSON.stringify(rec)).not.toMatch(/switch to|use a cheaper|downgrade|upgrade/i);
  });

  describe("sample size", () => {
    it("is exact at the threshold: 29 insufficient, 30 and 31 accepted", () => {
      const at = (n: number) => usage({ settledRecords: n, models: [{ name: "a", records: Math.ceil(n / 2), outputTokens: 1 }, { name: "b", records: Math.floor(n / 2), outputTokens: 1 }] });
      expect(outcomeOf(at(t.minSettledRecords - 1), "REC-USE-MODELS")).toMatchObject({ outcome: "insufficient-evidence", reason: "sample-too-small" });
      expect(outcomeOf(at(t.minSettledRecords), "REC-USE-MODELS")?.outcome).toBe("generated");
      expect(outcomeOf(at(t.minSettledRecords + 1), "REC-USE-MODELS")?.outcome).toBe("generated");
    });
  });

  describe("unresolved share, in records", () => {
    // settled 90 + unresolved 10 = 100; unresolved is exactly 10% of all records.
    const withUnresolved = (conflictingGroups: number, conflictingRecords: number, ambiguousRecords: number, settledRecords: number) =>
      outcome({ settledRecords, conflictingGroups, conflictingRecords, ambiguousRecords, models: [{ name: "a", records: settledRecords / 2, outputTokens: 1 }, { name: "b", records: settledRecords / 2, outputTokens: 1 }] });

    it("accepts exactly 10% and rejects anything above it", () => {
      expect(withUnresolved(0, 0, 10, 90)?.outcome).toBe("generated");
      expect(withUnresolved(0, 0, 9, 91)?.outcome).toBe("generated");
      expect(withUnresolved(0, 0, 11, 89)).toMatchObject({ outcome: "insufficient-evidence", reason: "unresolved-share-too-high" });
    });

    it("counts the RECORDS in conflicting groups, not the groups", () => {
      // 5 groups of 2 records = 10 records: exactly 10% of 100 records -> accepted.
      expect(withUnresolved(5, 10, 0, 90)?.outcome).toBe("generated");
      // 10 groups would pass a groups-vs-records comparison (10/100), but they hold 20 records: 18.2% -> rejected.
      expect(withUnresolved(10, 20, 0, 90)).toMatchObject({ outcome: "insufficient-evidence", reason: "unresolved-share-too-high" });
      // 6 groups of 2 = 12 records: 11.8% -> rejected, although 6 groups alone would be 6%.
      expect(withUnresolved(6, 12, 0, 90)?.reason).toBe("unresolved-share-too-high");
    });

    it("adds ambiguous records to conflicting records in the same unit", () => {
      expect(withUnresolved(2, 4, 6, 90)?.outcome).toBe("generated");
      expect(withUnresolved(2, 4, 7, 90)?.reason).toBe("unresolved-share-too-high");
    });

    it("reports insufficient evidence when group and record counts contradict each other", () => {
      expect(withUnresolved(3, 5, 0, 90)).toMatchObject({ outcome: "insufficient-evidence", reason: "unresolved-count-inconsistent" });
      expect(withUnresolved(0, 4, 0, 90)?.reason).toBe("unresolved-count-inconsistent");
      expect(withUnresolved(3, 0, 0, 90)?.reason).toBe("unresolved-count-inconsistent");
    });
  });

  describe("model attribution, in records", () => {
    const attributed = (named: number) => outcome({ models: [{ name: "a", records: Math.ceil(named / 2), outputTokens: 1 }, { name: "b", records: Math.floor(named / 2), outputTokens: 1 }, { name: null, records: 100 - named, outputTokens: 1 }] });

    it("is exact at 90%: 89 insufficient, 90 and 91 accepted", () => {
      expect(attributed(89)).toMatchObject({ outcome: "insufficient-evidence", reason: "model-attribution-too-low" });
      expect(attributed(90)?.outcome).toBe("generated");
      expect(attributed(91)?.outcome).toBe("generated");
    });

    it("counts only recognized identifiers, so odd names are unattributed rather than recognized", () => {
      const odd = (name: string) => outcome({ models: [{ name: "a", records: 40, outputTokens: 1 }, { name: "b", records: 40, outputTokens: 1 }, { name, records: 20, outputTokens: 1 }] });
      expect(odd("has spaces")).toMatchObject({ outcome: "insufficient-evidence", reason: "model-attribution-too-low" });
      expect(odd("home/someone/project")?.reason).toBe("model-attribution-too-low");
    });
  });

  describe("distinct models", () => {
    it("needs two RECOGNIZED models; any number of unrecognized names does not count", () => {
      const one = outcome({ models: [{ name: "model-alpha", records: 92, outputTokens: 1 }, { name: "odd name 1", records: 4, outputTokens: 1 }, { name: "odd/name/2", records: 4, outputTokens: 1 }] });
      expect(one).toMatchObject({ outcome: "not-triggered", reason: "single-model" });
      const onlyOdd = outcome({ models: [{ name: "a b", records: 50, outputTokens: 1 }, { name: "c d", records: 50, outputTokens: 1 }] });
      expect(onlyOdd).toMatchObject({ outcome: "insufficient-evidence", reason: "model-attribution-too-low" });
    });

    it("merges names that differ only by case into one model", () => {
      const merged = outcome({ models: [{ name: "Model-A", records: 50, outputTokens: 1 }, { name: "model-a", records: 50, outputTokens: 1 }] });
      expect(merged).toMatchObject({ outcome: "not-triggered", reason: "single-model" });
      const [rec] = byRule(adequate({ models: [{ name: "Model-A", records: 40, outputTokens: 1 }, { name: "model-a", records: 30, outputTokens: 1 }, { name: "model-b", records: 30, outputTokens: 1 }] }), "REC-USE-MODELS");
      expect(rec?.facts).toContain("model-a: 70 records (70% of attributed settled records).");
      expect(rec?.evidence.metrics).toContainEqual({ name: "distinctModels", value: 2 });
    });
  });

  describe("display of unattributed records", () => {
    it("shows unrecognized names once, as an unattributed total, never as separate or raw rows", () => {
      const hostile = ["/Users/someone/secret key=abc", "line\nbreak", "tab\there", "<script>x</script>", "x".repeat(65), "..", "a..b", "~root", "C:\\Windows\\x", "CANARY_PATH_9c1d /x"];
      const models = [{ name: "model-alpha", records: 50, outputTokens: 1 }, { name: "model-beta", records: 40, outputTokens: 1 }, ...hostile.map((name) => ({ name, records: 1, outputTokens: 1 })), { name: null, records: 0, outputTokens: 0 }];
      const [rec] = byRule(adequate({ models }), "REC-USE-MODELS");
      const text = JSON.stringify(rec);

      expect(rec?.facts.filter((f) => /unattributed|not attributed/.test(f))).toEqual(["10 settled records have no recognized model identifier and are not attributed to any model."]);
      expect(rec?.evidence.metrics).toContainEqual({ name: "unattributedRecords", value: 10 });
      expect(rec?.facts.filter((f) => /% of attributed settled records/.test(f))).toHaveLength(2);
      for (const bad of ["/Users", "CANARY", "<script", "key=abc", "Windows", "~root", "a..b", "xxxxxxxxxx"]) expect(text).not.toContain(bad);
      expect(text).not.toMatch(/[\u0000-\u001f]/);
    });
  });

  describe("ordering", () => {
    it("breaks ties by code-unit order, independent of locale and of input order", () => {
      const tied = (order: string[]) => usage({ settledRecords: 100, models: order.map((name) => ({ name, records: 25, outputTokens: 1 })) });
      const a = byRule(tied(["zeta", "alpha", "Beta", "gamma"]), "REC-USE-MODELS")[0];
      const b = byRule(tied(["gamma", "Beta", "alpha", "zeta"]), "REC-USE-MODELS")[0];
      expect(a).toEqual(b);
      // Names are lower-cased first, so ties follow plain code-unit order of the normalized names.
      expect(a?.facts.filter((f) => /: 25 records/.test(f)).map((f) => f.split(":")[0])).toEqual(["alpha", "beta", "gamma", "zeta"]);
      expect(compareCodeUnits("B", "a")).toBe(-1);
      expect(compareCodeUnits("model-1", "model_1")).toBe(-1);
      expect(compareCodeUnits("a", "a")).toBe(0);
      expect(compareCodeUnits("b", "a")).toBe(1);
    });
  });
});

describe("tie ordering distinguishes code-unit order from locale order", () => {
  it("lists model-1 before model_1 (locale order would reverse them)", () => {
    // Guard: the two orders really differ for this pair on this runtime, so the test can detect a regression.
    expect(["model_1", "model-1"].sort((a, b) => a.localeCompare(b))).toEqual(["model_1", "model-1"]);
    const tied = (order: string[]) => usage({ settledRecords: 100, models: order.map((name) => ({ name, records: 50, outputTokens: 1 })) });
    for (const order of [["model_1", "model-1"], ["model-1", "model_1"]]) {
      const [rec] = byRule(tied(order), "REC-USE-MODELS");
      expect(rec?.facts.filter((f) => /: 50 records/.test(f)).map((f) => f.split(":")[0])).toEqual(["model-1", "model_1"]);
    }
  });
});

describe("recognizeModelName", () => {
  it.each(["model-alpha", "claude-opus-4-5", "us.anthropic.claude-sonnet-4-v1:0", "m", "A1", "gpt_4.1", "x".repeat(64)])("accepts %s", (name) => {
    expect(recognizeModelName(name)).toBe(name.toLowerCase());
  });

  it.each([
    "", " ", " model", "model ", "a b", "a/b", "/abs/path", "../x", "a..b", "~/x", ".hidden", "-lead", "a\\b", "a@b", "http://x", "a;b", "a'b", 'a"b', "a<b>", "a(b)", "a\nb", "a\tb", "a\u0000b", "a\u200bb", "モデル", "é", "x".repeat(65),
  ])("rejects %j", (name) => {
    expect(recognizeModelName(name)).toBeNull();
  });

  describe("representative legitimate identifiers", () => {
    it.each([
      ["claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet-v2@20241022"],
      ["anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.5"],
      ["claude-sonnet-4-5[1m]", "claude-sonnet-4-5[1m]"],
      ["claude-sonnet-4-5[200k]", "claude-sonnet-4-5[200k]"],
      ["claude-3-5-sonnet@latest", "claude-3-5-sonnet@latest"],
      ["bedrock/anthropic.claude-3-sonnet-20240229-v1:0", "bedrock/anthropic.claude-3-sonnet-20240229-v1:0"],
      ["Anthropic/Claude-Sonnet-4.5[1M]", "anthropic/claude-sonnet-4.5[1m]"],
      ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
    ])("accepts %s as %s", (name, canonical) => {
      expect(recognizeModelName(name)).toBe(canonical);
    });
  });

  describe("unsafe variants of the newly allowed characters stay rejected", () => {
    it.each([
      "home/someone/project",
      "etc/passwd",
      "someone/model",
      "anthropic/claude/extra",
      "/anthropic/claude",
      "anthropic//claude",
      "anthropic/",
      "anthropic/../claude",
      "anthropic/./claude",
      "anthropic/.hidden",
      "http://anthropic/claude",
      "anthropic:/claude",
      "user@example.com",
      "user@host",
      "claude@2024",
      "claude@20241022@20241023",
      "claude@20241022x",
      "claude@",
      "claude[1m][2m]",
      "claude[x]",
      "claude[1m]suffix",
      "claude[<b>]",
      "claude[1m",
      "claude[]",
      "claude[1g]",
      "[1m]",
      "claude\\anthropic",
      "claude;rm",
      "claude?x=1",
      "claude#frag",
      "claude%2e%2e",
      "claude$HOME",
      "<synthetic>",
      `anthropic/${"x".repeat(60)}`,
    ])("rejects %j", (name) => {
      expect(recognizeModelName(name)).toBeNull();
    });
  });

  it("rejects only the provider-allowlist boundary, not valid shapes", () => {
    expect(recognizeModelName("anthropic/x")).toBe("anthropic/x");
    expect(recognizeModelName("notaprovider/x")).toBeNull();
    expect(recognizeModelName("ANTHROPIC/x")).toBe("anthropic/x");
  });

  it("rejects non-strings", () => {
    expect(recognizeModelName(null)).toBeNull();
    expect(recognizeModelName(undefined)).toBeNull();
    expect(recognizeModelName(42 as unknown as string)).toBeNull();
  });

  it("normalizes case so duplicates collapse", () => {
    expect(recognizeModelName("Model-A")).toBe(recognizeModelName("MODEL-a"));
  });
});

describe("determinism, ordering and traceability", () => {
  const build = (): EngineInput => {
    counter = 1000;
    return both(
      [finding("CFG-DUP-001", { fileCount: 2, crossScope: false }), finding("CFG-CONF-002", { overlappingRules: 1 }), finding("CFG-SIZE-002", { estimatedTokens: 13000, lines: 900 }), finding("CFG-ACT-001", { activation: "on-demand" })],
      { conflictingGroups: 1 },
    );
  };

  it("gives identical output for identical input, and for any finding order", () => {
    const input = build();
    const reversed: EngineInput = { ...input, config: { ...input.config!, findings: [...input.config!.findings].reverse() } };
    expect(recommend(build())).toEqual(recommend(input));
    expect(recommend(reversed)).toEqual(recommend(input));
  });

  it("orders by priority, then category, then id, with unique ids", () => {
    const { recommendations } = recommend(build());
    const keys = recommendations.map((r) => `${PRIORITIES.indexOf(r.priority)}|${CATEGORIES.indexOf(r.category)}|${r.id}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
    expect(new Set(recommendations.map((r) => r.id)).size).toBe(recommendations.length);
    expect(recommendations.map((r) => r.priority)[0]).toBe("medium");
  });

  it("cites only finding ids that exist in the input, caps them, and keeps the true count in metrics", () => {
    const many = Array.from({ length: MAX_EVIDENCE_FINDING_IDS + 10 }, () => finding("CFG-DUP-001", { fileCount: 2, crossScope: false }));
    const input = config(many);
    const [rec] = recommend(input).recommendations;
    const known = new Set(many.map((f) => f.id));
    expect(rec?.evidence.findingIds).toHaveLength(MAX_EVIDENCE_FINDING_IDS);
    expect(rec?.evidence.findingIds.every((id) => known.has(id))).toBe(true);
    expect(rec?.evidence.metrics[0]).toEqual({ name: "findingCount", value: many.length });
  });

  it("gives every recommendation a trace: finding ids or documented aggregate metrics, never neither", () => {
    for (const r of recommend(build()).recommendations) expect(r.evidence.findingIds.length + r.evidence.metrics.length).toBeGreaterThan(0);
  });

  it("keeps ids stable when only evidence counts change, and carries the rule version", () => {
    counter = 2000;
    const one = recommend(config([finding("CFG-DUP-001", { fileCount: 2 })])).recommendations[0];
    const two = recommend(config([finding("CFG-DUP-001", { fileCount: 2 }), finding("CFG-DUP-001", { fileCount: 4 })])).recommendations[0];
    expect(one?.id).toBe(two?.id);
    expect(one?.ruleVersion).toBe(RECOMMENDATION_RULES["REC-CFG-DUP"].version);
  });

  it("does not mutate its input", () => {
    const input = build();
    const snapshot = JSON.stringify(input);
    recommend(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("deduplication", () => {
  it("keeps the first of equivalent recommendations and is independent of later duplicates", () => {
    counter = 4000;
    const [dup] = recommend(config([finding("CFG-DUP-001", { fileCount: 2, crossScope: false })])).recommendations as Recommendation[];
    const [size] = recommend(config([finding("CFG-SIZE-001", { estimatedTokens: 5000, lines: 400 })])).recommendations as Recommendation[];
    if (!dup || !size) throw new Error("expected two recommendations");
    const changedCopy: Recommendation = { ...dup, title: "A later equivalent" };

    expect(dedupeById([dup, size, changedCopy, dup])).toEqual([dup, size]);
    expect(dedupeById([size, dup, changedCopy]).map((r) => r.id)).toEqual([size.id, dup.id]);
    // Same priority; configuration-hygiene sorts before context-efficiency.
    expect([size, dup].sort(compareRecommendations).map((r) => r.id)).toEqual(["REC-CFG-DUP", "REC-CTX-SIZE"]);
  });
});

describe("privacy and wording of every recommendation", () => {
  it("contains no path, secret-looking text or savings claim, and keeps severity, confidence and impact distinct", () => {
    counter = 3000;
    const input = both(
      [finding("CFG-DUP-001", { fileCount: 2, crossScope: true }), finding("CFG-CONF-001", { sameFile: false }, { confidence: "low" }), finding("CFG-CONF-002", { overlappingRules: 1 }), finding("CFG-SIZE-001", { estimatedTokens: 5000, lines: 400 }), finding("CFG-ACT-001", {})],
      { settledRecords: 100, conflictingGroups: 1, models: [{ name: "model-alpha", records: 60, outputTokens: 1 }, { name: "model-beta", records: 40, outputTokens: 1 }] },
    );
    const recs: readonly Recommendation[] = recommend(input).recommendations;
    expect(recs.length).toBeGreaterThanOrEqual(5);
    for (const r of recs) {
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/\/Users\/|\/home\/|\/var\/|[A-Za-z]:\\|CANARY|password|token=|secret/i);
      expect(["high", "medium", "low", "unknown"]).toContain(r.confidence.level);
      expect(["unknown", "limited"]).toContain(r.impact.level);
      expect(r.limitations.length).toBeGreaterThan(0);
      expect(unqualified(r.nextStep, /\b(applied|executed|fixed|removed|deleted)\b/i)).toEqual([]);
      expect(unqualified(text, /\bsav(e|es|ed|ing|ings)\b|\bcheaper\b|\bfaster\b|\bcost less\b/i)).toEqual([]);
      expect(text).not.toMatch(/"(save|savings|score|estimatedSaving)/i);
    }
  });
});
