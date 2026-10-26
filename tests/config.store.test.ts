import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConfigInventory } from "@/core/config";
import {
  ConfigStoreError,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  accountingSummary,
  configInventorySummary,
  currentConfigScanId,
  listConfigFindings,
  openStore,
  saveConfigInventory,
  scanAndIngest,
} from "@/core/store";
import { CONFIG_CANARIES, VALID_AGENT, agentFile, projectRoot, scan, userRoot, writeTree } from "./config-helpers";
import { fixturePath } from "./helpers";
import { count, freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const NAMED_CANARY = "CANARY_NAMED_RULE_a1f0";

function plantedTree() {
  const base = tempDir();
  const user = join(base, "home", ".claude");
  const proj = join(base, "workspace-secret-name");
  writeTree(base, { "outside.md": "CANARY_OUTSIDE_FILE_7710\n" });
  writeTree(user, {
    "CLAUDE.md": "CANARY_CFG_BODY_41af personal notes\n- Always use tabs for indentation.\n",
    "settings.json": JSON.stringify({
      env: { API_TOKEN: "CANARY_SECRET_TOKEN_7b13", MODE: "CANARY_ENV_VALUE_c0de" },
      permissions: { allow: ["Bash(CANARY_PERM_RULE_88b1:*)"], deny: ["Bash(CANARY_PERM_RULE_88b1:*)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "CANARY_HOOK_CMD_5d2e --flag" }] }] },
    }),
    "agents/reviewer.md": agentFile("name: reviewer\ndescription: |\n  CANARY_DESC_TEXT_2e90 long text\n  more text", "CANARY_CFG_BODY_41af agent body\n"),
    [`rules/${NAMED_CANARY}.md`]: "Never use tabs for indentation.\n",
  });
  writeTree(proj, { "CLAUDE.md": "Project text CANARY_CFG_BODY_41af\nSee @docs/missing.md and @../outside.md\n", ".claude/agents/a.md": VALID_AGENT });
  return { base, user, proj };
}

const dump = (store: { db: DatabaseSync }, table: string): string => JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
const dbBytes = (dbPath: string): string => readdirSync(join(dbPath, "..")).map((f) => readFileSync(join(dbPath, "..", f)).toString("latin1")).join("\n");

describe("saving and querying the inventory", () => {
  it("persists files, imports and findings and reads them back unchanged", async () => {
    const { user, proj } = plantedTree();
    const { store } = freshStore();
    const inv = await scan([userRoot(user), projectRoot(proj)]);
    const { scanId } = saveConfigInventory(store, inv);

    expect(currentConfigScanId(store.db)).toBe(scanId);
    expect(count(store, "usage_records")).toBe(0);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM config_files").get() as { n: number }).n).toBe(inv.files.length);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM config_imports").get() as { n: number }).n).toBe(inv.imports.length);
    expect(listConfigFindings(store.db)).toEqual(
      inv.findings.map((f) => ({ key: f.key, ruleId: f.ruleId, ruleVersion: f.ruleVersion, severity: f.severity, confidence: f.confidence, sourceId: f.sourceId, relatedSourceId: f.relatedSourceId, evidence: f.evidence, limitations: f.limitations, recommendation: f.recommendation })),
    );
    expect(configInventorySummary(store.db).reduce((n, r) => n + r.files, 0)).toBe(inv.files.length);
  });

  it("summarizes estimated tokens as present on disk, per scope and category", async () => {
    const { user, proj } = plantedTree();
    const { store } = freshStore();
    const inv = await scan([userRoot(user), projectRoot(proj)]);
    saveConfigInventory(store, inv);
    const rows = configInventorySummary(store.db);

    expect(rows.find((r) => r.scope === "project" && r.category === "agent")).toMatchObject({ files: 1 });
    expect(rows.reduce((n, r) => n + r.estimatedTokensOnDisk, 0)).toBe(inv.files.reduce((n, f) => n + f.estimatedTokens, 0));
  });

  it("replaces the snapshot on rescan without growing, and keeps scan history", async () => {
    const { user, proj } = plantedTree();
    const { store } = freshStore();
    const roots = [userRoot(user), projectRoot(proj)];
    saveConfigInventory(store, await scan(roots));
    const before = { files: dump(store, "config_files").length, findings: listConfigFindings(store.db) };
    const second = saveConfigInventory(store, await scan(roots));

    expect((store.db.prepare("SELECT COUNT(*) AS n FROM config_scans").get() as { n: number }).n).toBe(2);
    expect(currentConfigScanId(store.db)).toBe(second.scanId);
    expect(listConfigFindings(store.db)).toEqual(before.findings);
    expect((store.db.prepare("SELECT COUNT(DISTINCT scan_id) AS n FROM config_files").get() as { n: number }).n).toBe(1);
  });

  it("reflects removed files and fixed problems in the next snapshot", async () => {
    const { user, proj } = plantedTree();
    const { store } = freshStore();
    const roots = [userRoot(user), projectRoot(proj)];
    saveConfigInventory(store, await scan(roots));
    const withProblems = listConfigFindings(store.db).length;
    writeTree(proj, { "CLAUDE.md": "Clean project file.\n" });
    saveConfigInventory(store, await scan(roots));

    expect(listConfigFindings(store.db).filter((f) => f.ruleId === "CFG-IMP-001")).toEqual([]);
    expect(listConfigFindings(store.db).length).toBeLessThan(withProblems);
  });

  it("does not replace the snapshot after a partial or failed scan", async () => {
    const { user, proj, base } = plantedTree();
    const { store } = freshStore();
    const first = saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)]));
    const filesBefore = dump(store, "config_files");

    const partial = saveConfigInventory(store, await scan([userRoot(join(base, "missing")), projectRoot(proj)]));
    const failed = saveConfigInventory(store, await scan([userRoot(join(base, "missing"))]));

    expect(currentConfigScanId(store.db)).toBe(first.scanId);
    expect(dump(store, "config_files")).toBe(filesBefore);
    expect(store.db.prepare("SELECT id, status, is_current FROM config_scans ORDER BY id").all()).toEqual([
      { id: first.scanId, status: "complete", is_current: 1 },
      { id: partial.scanId, status: "partial", is_current: 0 },
      { id: failed.scanId, status: "failed", is_current: 0 },
    ]);
  });
});

describe("transactional safety", () => {
  async function seeded() {
    const { user, proj } = plantedTree();
    const ctx = freshStore();
    const inv = await scan([userRoot(user), projectRoot(proj)]);
    saveConfigInventory(ctx.store, inv);
    return { ...ctx, inv, snapshot: () => [dump(ctx.store, "config_files"), dump(ctx.store, "config_findings"), dump(ctx.store, "config_imports")] };
  }

  const poison = (inv: ConfigInventory, change: (f: ConfigInventory["findings"][number]) => ConfigInventory["findings"][number]): ConfigInventory => ({
    ...inv,
    findings: inv.findings.map((f, i) => (i === 0 ? change(f) : f)),
  });

  it("rolls back and keeps the previous snapshot when a database constraint fails", async () => {
    const { store, inv, snapshot } = await seeded();
    const before = snapshot();
    let caught: unknown;
    try {
      saveConfigInventory(store, poison(inv, (f) => ({ ...f, severity: "bogus" as never })));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigStoreError);
    expect((caught as ConfigStoreError).code).toMatch(/^SQLITE_\d+$/);
    expect(snapshot()).toEqual(before);
    expect(store.db.prepare("SELECT status, error_code FROM config_scans ORDER BY id DESC LIMIT 1").get()).toEqual({ status: "failed", error_code: (caught as ConfigStoreError).code });
  });

  it("refuses free-text evidence, rolls back, and reports a code only", async () => {
    const { store, inv, snapshot } = await seeded();
    const before = snapshot();
    const bad = poison(inv, (f) => ({ ...f, evidence: { note: "CANARY_CFG_BODY_41af leaked text" } }));

    expect(() => saveConfigInventory(store, bad)).toThrow(ConfigStoreError);
    expect(() => saveConfigInventory(store, bad)).toThrow(/UNSAFE_EVIDENCE/);
    expect(snapshot()).toEqual(before);
    expect(dbBytesOf(store)).not.toContain("CANARY_CFG_BODY_41af leaked");
  });

  it("rolls back when an import references an unknown file", async () => {
    const { store, inv, snapshot } = await seeded();
    const before = snapshot();
    const bad: ConfigInventory = { ...inv, imports: [...inv.imports, { sourceId: "cfg_unknown00000", line: 1, status: "broken", targetSourceId: null, depth: 1 }] };

    expect(() => saveConfigInventory(store, bad)).toThrow(/UNKNOWN_FILE/);
    expect(snapshot()).toEqual(before);
  });

  it("keeps referential integrity, cascades on scan deletion and nulls dangling targets", async () => {
    const { store } = await seeded();

    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.db.exec("DELETE FROM config_files WHERE source_id = (SELECT source_id FROM config_files WHERE category = 'imported' LIMIT 1)");
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.db.exec("DELETE FROM config_scans");
    expect((store.db.prepare("SELECT (SELECT COUNT(*) FROM config_files) + (SELECT COUNT(*) FROM config_findings) + (SELECT COUNT(*) FROM config_imports) AS n").get() as { n: number }).n).toBe(0);
  });
});

function dbBytesOf(store: { db: DatabaseSync }): string {
  const file = (store.db.prepare("PRAGMA database_list").get() as { file: string }).file;
  return dbBytes(file);
}

describe("privacy of stored rows and logs", () => {
  it("never stores configuration text, commands, env or permission values, names or paths", async () => {
    const { user, proj, base } = plantedTree();
    const { store, dbPath } = freshStore();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)], { includeLabels: false }));
    store.close();
    const bytes = dbBytes(dbPath);

    for (const needle of [...CONFIG_CANARIES, NAMED_CANARY, "workspace-secret-name", base, "outside.md", "tabs for indentation"]) {
      expect(bytes, needle).not.toContain(needle);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("stores a validated frontmatter name only inside metadata_json, nowhere else", async () => {
    const { user, proj } = plantedTree();
    const { store, dbPath } = freshStore();
    saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)], { includeLabels: false }));

    const holders = ["config_files", "config_findings", "config_imports", "config_scans"].flatMap((table) =>
      (store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).flatMap((row) =>
        Object.entries(row).filter(([, v]) => typeof v === "string" && v.includes("reviewer")).map(([column]) => `${table}.${column}`),
      ),
    );
    expect([...new Set(holders)]).toEqual(["config_files.metadata_json"]);
    expect(dbBytes(dbPath)).not.toContain("CANARY_DESC_TEXT_2e90");
  });

  it("stores labels only when the caller opts in, and then only basenames", async () => {
    const { proj } = plantedTree();
    const off = freshStore();
    const on = freshStore();
    saveConfigInventory(off.store, await scan([projectRoot(proj)], { includeLabels: false }));
    saveConfigInventory(on.store, await scan([projectRoot(proj)], { includeLabels: true }));

    expect(off.store.db.prepare("SELECT COUNT(*) AS n FROM config_files WHERE label IS NOT NULL").get()).toEqual({ n: 0 });
    const labels = (on.store.db.prepare("SELECT label FROM config_files").all() as { label: string }[]).map((r) => r.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => !l.includes("/"))).toBe(true);
  });

  it("keeps stored JSON to counts, booleans, fixed code words and known key names", async () => {
    const { user, proj } = plantedTree();
    const { store } = freshStore();
    saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)]));

    for (const row of store.db.prepare("SELECT evidence_json FROM config_findings").all() as { evidence_json: string }[]) {
      for (const value of Object.values(JSON.parse(row.evidence_json) as Record<string, unknown>)) {
        expect(typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,39}$/.test(value))).toBe(true);
      }
    }
    const metadata = (store.db.prepare("SELECT metadata_json FROM config_files").all() as { metadata_json: string }[]).flatMap((r) => Object.keys(JSON.parse(r.metadata_json) as object));
    expect(new Set(metadata).size).toBeGreaterThan(0);
    expect(metadata.every((k) => ["name", "model", "descriptionLength", "toolCount", "pathGlobCount"].includes(k))).toBe(true);
    const detail = store.db.prepare("SELECT detail_json FROM config_files WHERE category = 'settings'").get() as { detail_json: string };
    expect(JSON.parse(detail.detail_json)).toMatchObject({ envKeyCount: 2, permissions: { allow: 1, deny: 1, ask: 0 }, hooks: { Stop: { commandHooks: 1 } } });
  });

  it("does not disturb usage accounting stored in the same database", async () => {
    const { user, proj } = plantedTree();
    const { store } = freshStore();
    await scanAndIngest(store, [fixturePath("usage-basic.jsonl")]);
    const before = accountingSummary(store.db);
    saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)]));

    expect(accountingSummary(store.db)).toEqual(before);
    expect(count(store, "usage_records")).toBe(12);
  });
});

describe("migration compatibility (v1 to v2)", () => {
  function makeV1Database() {
    const dir = tempDir();
    const dbPath = join(dir, "app-data", "usage.db");
    mkdirSync(join(dir, "app-data"), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(MIGRATIONS[0]?.sql ?? "");
    raw.exec("PRAGMA user_version = 1");
    raw.exec("INSERT INTO scan_runs (started_at, status) VALUES ('2026-01-01T00:00:00.000Z', 'complete')");
    raw.exec(`INSERT INTO source_files (fingerprint, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id) VALUES ('fp', 'h', 10, 1, 1, 1)`);
    raw.exec(`INSERT INTO usage_records (source_file_id, line_number, identity_kind, event_type, in_state, in_value, out_state, out_value, cr_state, cc_state, accounting, group_size, model)
              VALUES (1, 1, 'none', 'assistant', 'value', 7, 'value', 0, 'null', 'missing', 'ambiguous', 1, 'model-alpha')`);
    raw.close();
    return dbPath;
  }

  it("upgrades a v1 database in place, preserving every v1 row and its accounting meaning", async () => {
    const dbPath = makeV1Database();
    const store = openStore(dbPath);
    try {
      expect((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
      expect(store.db.prepare("SELECT in_state, in_value, out_state, out_value, cr_state, cc_state, accounting, model FROM usage_records").all()).toEqual([
        { in_state: "value", in_value: 7, out_state: "value", out_value: 0, cr_state: "null", cc_state: "missing", accounting: "ambiguous", model: "model-alpha" },
      ]);
      expect(accountingSummary(store.db).ambiguous).toMatchObject({ records: 1, ifDistinct: { inputTokens: 7 } });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect((store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'config_findings'").all()).length).toBe(1);
      expect(store.salt).toHaveLength(32);
    } finally {
      store.close();
    }
  });

  it("is idempotent on reopen and lets the new tables work next to old data", async () => {
    const dbPath = makeV1Database();
    openStore(dbPath).close();
    const store = openStore(dbPath);
    try {
      const { user, proj } = plantedTree();
      saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)]));

      expect((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST_SCHEMA_VERSION);
      expect(count(store, "usage_records")).toBe(1);
      expect(listConfigFindings(store.db).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("migrations stay contiguous and v2 only adds config tables", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    const v2 = MIGRATIONS.find((m) => m.version === 2)?.sql ?? "";
    expect([...v2.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1])).toEqual(["config_scans", "config_files", "config_imports", "config_findings"]);
    expect(v2).not.toMatch(/ALTER TABLE|DROP |usage_records|source_files/);
  });
});
