import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalysis, type RecommendationsQuery } from "@/core/analysis";
import { accountingSummary, openStore } from "@/core/store";
import { ALL_CANARIES, databaseAtVersion, footprint, populatedDatabase } from "./analysis-helpers";
import { richDatabase } from "./recommend-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const ALL: RecommendationsQuery = { category: null, priority: null, limit: 200, offset: 0 };
const FINDINGS_ALL = { severity: null, ruleId: null, limit: 200, offset: 0 } as const;

describe("recommendations from a populated synthetic database", () => {
  it("generates every rule's recommendation when its evidence exists, with traceable evidence", async () => {
    const { dbPath } = await richDatabase();
    const analysis = createAnalysis(dbPath);
    const page = analysis.recommendations(ALL).data;
    const ids = (page?.items ?? []).map((r) => r.id);

    expect(analysis.recommendations(ALL).state).toBe("ok");
    expect(ids).toEqual(expect.arrayContaining(["REC-CFG-DUP", "REC-CTX-SIZE", "REC-CFG-ACTIVATION", "REC-CFG-CONFLICT:instructions", "REC-CFG-CONFLICT:permissions", "REC-USE-MODELS"]));
    expect(page?.availability).toEqual({ usage: true, config: true });
    expect(page?.rules.map((r) => r.ruleId)).toHaveLength(6);

    const findingIds = new Set((analysis.configFindings(FINDINGS_ALL).data?.items ?? []).map((f) => f.id));
    for (const r of page?.items ?? []) for (const id of r.evidence.findingIds) expect(findingIds.has(id)).toBe(true);
    const dup = page?.items.find((r) => r.id === "REC-CFG-DUP");
    const dupFindings = (analysis.configFindings({ ...FINDINGS_ALL, ruleId: "CFG-DUP-001" }).data?.items ?? []).map((f) => f.id).sort();
    expect(dup?.evidence.findingIds).toEqual(dupFindings);
  });

  it("reproduces the settled/unresolved figures from the core accounting functions", async () => {
    const { dbPath } = await populatedDatabase();
    const store = openStore(dbPath);
    const oracle = accountingSummary(store.db);
    store.close();

    const rec = createAnalysis(dbPath).recommendations(ALL).data?.items.find((r) => r.id === "REC-DQ-ACCOUNTING");
    const metric = (name: string) => rec?.evidence.metrics.find((m) => m.name === name)?.value;
    expect(metric("settledRecords")).toBe(oracle.settled.records);
    expect(metric("conflictingGroups")).toBe(oracle.conflicting.groups);
    expect(metric("ambiguousRecords")).toBe(oracle.ambiguous.records);
    expect(metric("duplicatesExcluded")).toBe(oracle.duplicates);
    expect(rec?.priority).toBe("medium");
  });

  it("does not describe model usage when conflicting or ambiguous events are present and the sample is small", async () => {
    const { dbPath } = await populatedDatabase();
    const page = createAnalysis(dbPath).recommendations(ALL).data;
    expect(page?.items.some((r) => r.ruleId === "REC-USE-MODELS")).toBe(false);
    expect(page?.rules.find((r) => r.ruleId === "REC-USE-MODELS")).toMatchObject({ outcome: "insufficient-evidence", reason: "sample-too-small" });
  });

  it("is deterministic for the same database, and does not change it", async () => {
    const { dbPath } = await richDatabase();
    const before = footprint(dbPath);
    const analysis = createAnalysis(dbPath);
    const first = analysis.recommendations(ALL);
    const second = createAnalysis(dbPath).recommendations(ALL);

    expect(second).toEqual(first);
    expect(footprint(dbPath)).toEqual(before);
  });

  it("filters by category and priority, pages the result, and keeps whole-set counts", async () => {
    const { dbPath } = await richDatabase();
    const analysis = createAnalysis(dbPath);
    const all = analysis.recommendations(ALL).data;
    const hygiene = analysis.recommendations({ ...ALL, category: "configuration-hygiene" }).data;
    const info = analysis.recommendations({ ...ALL, priority: "info" }).data;

    expect(hygiene?.items.every((r) => r.category === "configuration-hygiene")).toBe(true);
    expect(hygiene?.total).toBe(all?.byCategory["configuration-hygiene"]);
    expect(info?.items.every((r) => r.priority === "info")).toBe(true);
    expect(hygiene?.byCategory).toEqual(all?.byCategory);
    expect(analysis.recommendations({ ...ALL, category: "data-quality", priority: "info" }).data?.items).toEqual([]);
    const paged = analysis.recommendations({ ...ALL, limit: 2, offset: 1 }).data;
    expect(paged?.items).toEqual(all?.items.slice(1, 3));
    expect(paged?.total).toBe(all?.total);
  });

  it("contains no canary, absolute path, salt or raw session id", async () => {
    const { dbPath, base } = await richDatabase();
    const store = openStore(dbPath);
    const salt = store.salt.toString("hex");
    store.close();
    const text = JSON.stringify(createAnalysis(dbPath).recommendations(ALL));

    for (const canary of ALL_CANARIES) expect(text).not.toContain(canary);
    for (const secret of [base, dbPath, salt, "workspace-secret-name", "--flag"]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\/Users\/|\/private\/var|\/var\/folders|sess-\d/);
  });
});

describe("states", () => {
  it("reports no-database without creating anything", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    expect(createAnalysis(dbPath).recommendations(ALL)).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
  });

  it("reports no-completed-scan for an initialized database with no scans", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    openStore(dbPath).close();
    expect(createAnalysis(dbPath).recommendations(ALL)).toEqual({ state: "no-completed-scan", data: null, errorCode: null });
  });

  it("works with usage only, marking configuration rules as lacking evidence rather than inventing output", async () => {
    const { dbPath } = await richDatabase({ config: false });
    const page = createAnalysis(dbPath).recommendations(ALL).data;
    expect(page?.availability).toEqual({ usage: true, config: false });
    expect(page?.items.map((r) => r.id)).toEqual(["REC-USE-MODELS"]);
    for (const id of ["REC-CFG-DUP", "REC-CFG-CONFLICT", "REC-CTX-SIZE", "REC-CFG-ACTIVATION"]) {
      expect(page?.rules.find((r) => r.ruleId === id)).toMatchObject({ outcome: "insufficient-evidence", reason: "no-completed-scan" });
    }
  });

  it("works with configuration only", async () => {
    const { dbPath } = await richDatabase({ usage: false });
    const page = createAnalysis(dbPath).recommendations(ALL).data;
    expect(page?.availability).toEqual({ usage: false, config: true });
    expect(page?.items.some((r) => r.category === "usage-insight" || r.category === "data-quality")).toBe(false);
    expect(page?.rules.find((r) => r.ruleId === "REC-DQ-ACCOUNTING")?.outcome).toBe("insufficient-evidence");
  });

  it("returns an empty list, not a generic suggestion, when scans exist but nothing is supported", async () => {
    const { dbPath } = await richDatabase({ events: 10, config: false });
    const page = createAnalysis(dbPath).recommendations(ALL).data;
    expect(page?.items).toEqual([]);
    expect(page?.total).toBe(0);
    expect(page?.rules.every((r) => r.outcome !== "generated")).toBe(true);
  });

  it("reports an unusable database with a fixed code", () => {
    expect(createAnalysis(databaseAtVersion(2)).recommendations(ALL)).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
  });

  it("fails closed on an unknown accounting state instead of echoing it", async () => {
    const { dbPath } = await richDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.exec("UPDATE usage_records SET accounting = 'CANARY_UNKNOWN_44b2' WHERE id = 1");
    raw.close();
    const result = createAnalysis(dbPath).recommendations(ALL);
    expect(result).toEqual({ state: "unavailable", data: null, errorCode: "QUERY_FAILED" });
  });

  it("ignores findings of an audit rule version it does not understand", async () => {
    const { dbPath } = await richDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE config_findings SET rule_version = 2 WHERE rule_id = 'CFG-DUP-001'");
    raw.close();
    const page = createAnalysis(dbPath).recommendations(ALL).data;
    expect(page?.items.some((r) => r.id === "REC-CFG-DUP")).toBe(false);
    expect(page?.rules.find((r) => r.ruleId === "REC-CFG-DUP")).toMatchObject({ outcome: "insufficient-evidence", reason: "unsupported-finding-version" });
  });

  it("withholds tampered finding evidence from the engine", async () => {
    const { dbPath } = await richDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE config_findings SET evidence_json = '{"fileCount":"CANARY_CFG_BODY_41af leaked"}' WHERE rule_id = 'CFG-DUP-001'`);
    raw.close();
    const text = JSON.stringify(createAnalysis(dbPath).recommendations(ALL));
    expect(text).not.toContain("CANARY_CFG_BODY_41af");
  });
});
