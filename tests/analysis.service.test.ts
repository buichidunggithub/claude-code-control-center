import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAnalysis } from "@/core/analysis";
import {
  accountingStateCounts,
  accountingSummary,
  configInventorySummary,
  listConfigFindings,
  openStore,
  settledByDate,
  settledByModel,
  settledBySession,
  tokenFieldStateCounts,
  LATEST_SCHEMA_VERSION,
} from "@/core/store";
import { RULES } from "@/core/config";
import { databaseAtVersion, fileWithBytes, footprint, populatedDatabase } from "./analysis-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const INCLUDE = { sidechain: "include", limit: 200, offset: 0 } as const;
const EXCLUDE = { sidechain: "exclude", limit: 200, offset: 0 } as const;

async function withOracle() {
  const { dbPath } = await populatedDatabase();
  const store = openStore(dbPath);
  return { dbPath, store, analysis: createAnalysis(dbPath) };
}

describe("usage operations match the existing core functions", () => {
  it("returns exactly accountingSummary and the state counts, for both sidechain modes", async () => {
    const { store, analysis } = await withOracle();
    try {
      for (const mode of ["include", "exclude"] as const) {
        const result = analysis.usageSummary({ sidechain: mode });
        const oracle = accountingSummary(store.db, { includeSidechain: mode === "include" });
        expect(result.state).toBe("ok");
        expect(result.data).toEqual({ sidechain: mode, ...oracle, stateCounts: accountingStateCounts(store.db) });
      }
      const included = analysis.usageSummary({ sidechain: "include" }).data;
      const excluded = analysis.usageSummary({ sidechain: "exclude" }).data;
      expect(excluded?.settled.records).toBeLessThan(included?.settled.records ?? 0);
    } finally {
      store.close();
    }
  });

  it("keeps settled, conflicting and ambiguous separate", async () => {
    const { store, analysis } = await withOracle();
    try {
      const data = analysis.usageSummary({ sidechain: "include" }).data;
      expect(data?.conflicting.groups).toBeGreaterThan(0);
      expect(data?.ambiguous.records).toBeGreaterThan(0);
      expect(data?.stateCounts.conflicting).toBeGreaterThan(0);
      expect(data?.settled.records).toBe(data?.stateCounts.accepted);
    } finally {
      store.close();
    }
  });

  it("lists models, days and sessions as the core aggregates, honoring sidechain mode", async () => {
    const { store, analysis } = await withOracle();
    try {
      for (const [mode, q] of [["include", INCLUDE], ["exclude", EXCLUDE]] as const) {
        const opts = { includeSidechain: mode === "include" };
        expect(analysis.usageByModel(q).data?.items).toEqual(settledByModel(store.db, opts).map((g) => ({ key: g.key, records: g.records, tokens: g.tokens })));
        const days = analysis.usageByDay({ ...q, from: null, to: null }).data;
        const dated = settledByDate(store.db, opts).filter((g) => g.key !== null).reverse();
        expect(days?.items.map((i) => i.key)).toEqual(dated.map((g) => g.key));
        expect(days?.items.map((i) => i.tokens)).toEqual(dated.map((g) => g.tokens));
        const sessions = analysis.usageSessions(q).data;
        const oracle = settledBySession(store.db, opts);
        expect(sessions?.total).toBe(oracle.length);
        expect(sessions?.items.map((s) => s.records)).toEqual(oracle.map((g) => g.records));
      }
    } finally {
      store.close();
    }
  });

  it("bounds pages, filters days by UTC range and reports undated records separately", async () => {
    const { store, analysis } = await withOracle();
    try {
      const page = analysis.usageByModel({ sidechain: "include", limit: 1, offset: 1 }).data;
      expect(page?.items).toHaveLength(1);
      expect(page?.total).toBeGreaterThan(1);
      expect(page?.items[0]).toEqual(analysis.usageByModel(INCLUDE).data?.items[1]);

      const allDays = analysis.usageByDay({ ...INCLUDE, from: null, to: null }).data;
      const first = allDays?.items[0]?.key ?? "";
      const ranged = analysis.usageByDay({ ...INCLUDE, from: first, to: first }).data;
      expect(ranged?.items.map((i) => i.key)).toEqual([first]);
      expect(ranged?.undated).toEqual(allDays?.undated);
      const empty = analysis.usageByDay({ ...INCLUDE, from: "1999-01-01", to: "1999-01-02" }).data;
      expect(empty?.items).toEqual([]);
      expect(empty?.total).toBe(0);
    } finally {
      store.close();
    }
  });

  it("lists days newest first and keeps paging and inclusive range boundaries consistent", async () => {
    const { store, analysis } = await withOracle();
    try {
      const all = analysis.usageByDay({ ...INCLUDE, from: null, to: null }).data;
      const keys = (all?.items ?? []).map((i) => i.key ?? "");
      expect(keys.length).toBeGreaterThan(2);
      expect(keys).toEqual([...keys].sort().reverse());

      const pageOne = analysis.usageByDay({ sidechain: "include", limit: 2, offset: 0, from: null, to: null }).data;
      const pageTwo = analysis.usageByDay({ sidechain: "include", limit: 2, offset: 2, from: null, to: null }).data;
      expect([...(pageOne?.items ?? []), ...(pageTwo?.items ?? [])].map((i) => i.key)).toEqual(keys.slice(0, 2 + (pageTwo?.items.length ?? 0)));
      expect(pageOne?.total).toBe(keys.length);

      const newest = keys[0] ?? "";
      const oldest = keys[keys.length - 1] ?? "";
      expect(analysis.usageByDay({ ...INCLUDE, from: newest, to: null }).data?.items.map((i) => i.key)).toEqual([newest]);
      expect(analysis.usageByDay({ ...INCLUDE, from: null, to: oldest }).data?.items.map((i) => i.key)).toEqual([oldest]);
      expect(analysis.usageByDay({ ...INCLUDE, from: oldest, to: newest }).data?.items.map((i) => i.key)).toEqual(keys);
      const settled = analysis.usageSummary({ sidechain: "include" }).data?.settled.records ?? 0;
      const dayRecords = (all?.items ?? []).reduce((n, i) => n + i.records, 0) + (all?.undated?.records ?? 0);
      expect(dayRecords).toBe(settled);
    } finally {
      store.close();
    }
  });

  it("reports counter states, never turning missing or invalid into zero", async () => {
    const { store, analysis } = await withOracle();
    try {
      const quality = analysis.usageQuality().data;
      expect(quality?.tokenFieldStates).toEqual(tokenFieldStateCounts(store.db));
      expect(quality?.stateCounts).toEqual(accountingStateCounts(store.db));
      expect(quality?.latestScan?.sources).toBe(4);
      expect(quality?.latestScan?.skippedLines.malformed).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("shortens session ids to opaque prefixes", async () => {
    const { analysis } = await withOracle();
    for (const s of analysis.usageSessions(INCLUDE).data?.items ?? []) if (s.id !== null) expect(s.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("configuration operations", () => {
  it("summarizes the current snapshot with the core summary and no 'loaded' bucket", async () => {
    const { store, analysis } = await withOracle();
    try {
      const data = analysis.configSummary().data;
      expect(data?.rows).toEqual(configInventorySummary(store.db));
      expect(Object.keys(data?.activation ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(data?.activation ?? {})).not.toContain("loaded");
      expect(data?.scan).toMatchObject({ status: "complete", isCurrent: true });
      expect(data?.note).toMatch(/Inventoried means present on disk/);
    } finally {
      store.close();
    }
  });

  it("returns findings with rule id, version, severity, confidence, evidence and limitations", async () => {
    const { store, analysis } = await withOracle();
    try {
      const stored = listConfigFindings(store.db);
      const page = analysis.configFindings({ severity: null, ruleId: null, limit: 200, offset: 0 }).data;
      expect(page?.total).toBe(stored.length);
      for (const f of page?.items ?? []) {
        expect(f.ruleVersion).toBe(RULES[f.ruleId as keyof typeof RULES].version);
        expect(f.ruleTitle).toBe(RULES[f.ruleId as keyof typeof RULES].title);
        expect(f.evidenceRedacted).toBe(false);
        expect(f.limitations.length).toBeGreaterThan(10);
        expect(f.recommendation.length).toBeGreaterThan(5);
      }
      expect(page?.note).toMatch(/None of them shows that a file is loaded/);
    } finally {
      store.close();
    }
  });

  it("filters by severity and rule while keeping whole-snapshot counts for the filter UI", async () => {
    const { analysis } = await withOracle();
    const all = analysis.configFindings({ severity: null, ruleId: null, limit: 200, offset: 0 }).data;
    const medium = analysis.configFindings({ severity: "medium", ruleId: null, limit: 200, offset: 0 }).data;
    expect(medium?.items.every((f) => f.severity === "medium")).toBe(true);
    expect(medium?.total).toBe(all?.bySeverity.medium);
    expect(medium?.bySeverity).toEqual(all?.bySeverity);
    const ruleId = all?.items[0]?.ruleId ?? "";
    const one = analysis.configFindings({ severity: null, ruleId, limit: 200, offset: 0 }).data;
    expect(one?.items.every((f) => f.ruleId === ruleId)).toBe(true);
    expect(one?.total).toBe(all?.byRule[ruleId]);
    const paged = analysis.configFindings({ severity: null, ruleId: null, limit: 2, offset: 1 }).data;
    expect(paged?.items).toEqual(all?.items.slice(1, 3));
  });
});

describe("status and data states", () => {
  it("reports the latest scans and schema version", async () => {
    const { analysis } = await withOracle();
    const status = analysis.status().data;
    expect(status?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(status?.usage).toMatchObject({ state: "ok", latestScan: { status: "complete" } });
    expect(status?.config).toMatchObject({ state: "ok", latestScan: { status: "complete", isCurrent: true } });
  });

  it("says no-database when the file is missing, and creates neither file nor directory", () => {
    const base = tempDir();
    const dbPath = join(base, "app-data", "usage.db");
    const analysis = createAnalysis(dbPath);

    for (const result of [analysis.status(), analysis.usageSummary({ sidechain: "include" }), analysis.configSummary(), analysis.configFindings({ severity: null, ruleId: null, limit: 5, offset: 0 })]) {
      expect(result).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    }
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(base, "app-data"))).toBe(false);
  });

  it("distinguishes an initialized database with no completed scans from a missing or broken one", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    openStore(dbPath).close();
    const analysis = createAnalysis(dbPath);

    expect(analysis.status().data).toMatchObject({ usage: { state: "no-completed-scan", completedScans: 0, latestScan: null }, config: { state: "no-completed-scan", latestScan: null } });
    expect(analysis.usageSummary({ sidechain: "include" })).toEqual({ state: "no-completed-scan", data: null, errorCode: null });
    expect(analysis.usageQuality().state).toBe("no-completed-scan");
    expect(analysis.configSummary()).toEqual({ state: "no-completed-scan", data: null, errorCode: null });
  });

  it("gives each section its own state: usage present, configuration absent", async () => {
    const { dbPath } = await populatedDatabase({ config: false });
    const analysis = createAnalysis(dbPath);
    expect(analysis.usageSummary({ sidechain: "include" }).state).toBe("ok");
    expect(analysis.configFindings({ severity: null, ruleId: null, limit: 5, offset: 0 }).state).toBe("no-completed-scan");
  });

  it("does not report a partial-only usage history as completed", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    const store = openStore(dbPath);
    store.db.exec("INSERT INTO scan_runs (started_at, status, error_code) VALUES ('2026-01-01T00:00:00.000Z', 'failed', 'SOURCE_FAILED')");
    store.close();
    const analysis = createAnalysis(dbPath);
    expect(analysis.usageSummary({ sidechain: "include" }).state).toBe("no-completed-scan");
    expect(analysis.status().data?.usage.latestScan).toMatchObject({ status: "failed", errorCode: "SOURCE_FAILED" });
  });

  const UNUSABLE: { name: string; make: () => string; code: string }[] = [
    { name: "garbage bytes", make: () => fileWithBytes(Buffer.from("CANARY_PATH_9c1d this is not sqlite, not even close at all 0123456789".repeat(40))), code: "DB_CORRUPT" },
    { name: "an empty file", make: () => fileWithBytes(new Uint8Array()), code: "NOT_INITIALIZED" },
    { name: "an older schema", make: () => databaseAtVersion(2), code: "SCHEMA_OUTDATED" },
    { name: "a newer schema", make: () => databaseAtVersion(LATEST_SCHEMA_VERSION + 1), code: "SCHEMA_NEWER" },
    { name: "a directory", make: () => tempDir(), code: "NOT_A_FILE" },
    { name: "a relative path", make: () => "relative/usage.db", code: "INVALID_DATABASE_PATH" },
  ];

  it.each(UNUSABLE)("reports $name as unavailable with a fixed code", ({ make, code }) => {
    const target = make();
    const result = createAnalysis(target).usageSummary({ sidechain: "include" });
    expect(result).toEqual({ state: "unavailable", data: null, errorCode: code });
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(JSON.stringify(result)).not.toContain(target);
  });

  it("turns a failing query into QUERY_FAILED without leaking the database error", async () => {
    const { dbPath } = await populatedDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.exec("UPDATE usage_records SET accounting = 'CANARY_UNKNOWN_44b2' WHERE id = 1");
    raw.close();

    const result = createAnalysis(dbPath).usageQuality();
    expect(result).toEqual({ state: "unavailable", data: null, errorCode: "QUERY_FAILED" });
  });

  it("is strictly read-only: bytes, mtime and sibling files are unchanged by every operation", async () => {
    const { dbPath } = await populatedDatabase();
    const before = footprint(dbPath);
    const a = createAnalysis(dbPath);
    a.status();
    a.usageSummary({ sidechain: "include" });
    a.usageByModel(INCLUDE);
    a.usageByDay({ ...INCLUDE, from: null, to: null });
    a.usageSessions(INCLUDE);
    a.usageQuality();
    a.configSummary();
    a.configFindings({ severity: null, ruleId: null, limit: 10, offset: 0 });
    expect(footprint(dbPath)).toEqual(before);
  });

  it("works on a read-only file (0400) and does not write", async () => {
    const { dbPath } = await populatedDatabase();
    chmodSync(dbPath, 0o400);
    const before = footprint(dbPath);
    expect(createAnalysis(dbPath).usageSummary({ sidechain: "include" }).state).toBe("ok");
    expect(footprint(dbPath)).toEqual(before);
  });

  it("follows a symlink to a valid database, and reports a dangling symlink as no-database", async () => {
    const { dbPath } = await populatedDatabase();
    const dir = tempDir();
    const link = join(dir, "link.db");
    symlinkSync(dbPath, link);
    expect(createAnalysis(link).usageSummary({ sidechain: "include" }).state).toBe("ok");

    const dangling = join(dir, "dangling.db");
    symlinkSync(join(dir, "does-not-exist.db"), dangling);
    expect(createAnalysis(dangling).status()).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    expect(existsSync(join(dir, "does-not-exist.db"))).toBe(false);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("reports an unreadable database file as DB_UNREADABLE without leaking the path", async () => {
    const { dbPath } = await populatedDatabase();
    chmodSync(dbPath, 0o000);
    try {
      const result = createAnalysis(dbPath).usageSummary({ sidechain: "include" });
      expect(result).toEqual({ state: "unavailable", data: null, errorCode: "DB_UNREADABLE" });
      expect(JSON.stringify(result)).not.toContain(dbPath);
    } finally {
      chmodSync(dbPath, 0o600);
    }
  });

  it("never creates anything when pointed into a missing directory tree", () => {
    const base = tempDir();
    mkdirSync(join(base, "present"));
    writeFileSync(join(base, "present", "keep.txt"), "x");
    createAnalysis(join(base, "present", "nested", "usage.db")).status();
    expect(existsSync(join(base, "present", "nested"))).toBe(false);
  });
});
