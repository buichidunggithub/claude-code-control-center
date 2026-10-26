import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAnalysis } from "@/core/analysis";
import { ALL_CANARIES, populatedDatabase } from "./analysis-helpers";
import { openStore } from "@/core/store";
import { registerTempStoreCleanup } from "./store-helpers";

registerTempStoreCleanup();

const ALL = { sidechain: "include", limit: 200, offset: 0 } as const;

function everyResponse(dbPath: string): string {
  const a = createAnalysis(dbPath);
  return JSON.stringify([
    a.status(),
    a.usageSummary({ sidechain: "include" }),
    a.usageSummary({ sidechain: "exclude" }),
    a.usageByModel(ALL),
    a.usageByDay({ ...ALL, from: null, to: null }),
    a.usageSessions(ALL),
    a.usageQuality(),
    a.configSummary(),
    a.configFindings({ severity: null, ruleId: null, limit: 200, offset: 0 }),
  ]);
}

describe("privacy of API responses", () => {
  it("contains no canary, absolute path, salt, command or environment value", async () => {
    const { dbPath, base } = await populatedDatabase();
    const text = everyResponse(dbPath);
    const store = openStore(dbPath);
    const salt = store.salt.toString("hex");
    store.close();

    for (const canary of ALL_CANARIES) expect(text).not.toContain(canary);
    expect(text).not.toContain(base);
    expect(text).not.toContain(dbPath);
    expect(text).not.toContain(salt);
    expect(text).not.toContain("workspace-secret-name");
    expect(text).not.toMatch(/\/Users\/|\/private\/var|\/tmp\//);
    expect(text).not.toContain("--flag");
  });

  it("exposes no raw session id or file fingerprint, only short opaque ids", async () => {
    const { dbPath } = await populatedDatabase();
    const text = everyResponse(dbPath);
    expect(text).not.toMatch(/sess-[A-Za-z0-9]/);
    expect(text).not.toMatch(/[0-9a-f]{40,}/);
  });

  it("withholds finding evidence that fails the safety check, even if the database was tampered with", async () => {
    const { dbPath } = await populatedDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE config_findings SET evidence_json = '{"note":"CANARY_CFG_BODY_41af leaked text"}' WHERE id = (SELECT MIN(id) FROM config_findings)`);
    raw.close();

    const page = createAnalysis(dbPath).configFindings({ severity: null, ruleId: null, limit: 200, offset: 0 }).data;
    expect(page?.items.some((f) => f.evidenceRedacted && Object.keys(f.evidence).length === 0)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("CANARY_CFG_BODY_41af leaked");
  });

  it("fails closed on an unknown accounting state instead of echoing it", async () => {
    const { dbPath } = await populatedDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.exec("UPDATE usage_records SET accounting = 'CANARY_UNKNOWN_44b2' WHERE id = 1");
    raw.close();

    const result = createAnalysis(dbPath).usageSummary({ sidechain: "include" });
    expect(result).toEqual({ state: "unavailable", data: null, errorCode: "QUERY_FAILED" });
  });
});
