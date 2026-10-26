import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES } from "@/core/config";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, listConfigFindings, migrate, openStore, saveConfigInventory } from "@/core/store";
import { currentSchemaVersion } from "@/core/store/migrations";
import { findingsOf, fileOf, projectRoot, scan, writeTree } from "./config-helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) db.exec(m.sql);
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

describe("rule versions", () => {
  it("gives every rule a positive integer version and stamps it on each finding", async () => {
    for (const rule of Object.values(RULES)) expect(Number.isInteger(rule.version) && rule.version >= 1).toBe(true);

    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "@missing.md\n", ".claude/agents/bad.md": "no frontmatter\n" });
    const inv = await scan([projectRoot(dir)]);

    expect(inv.findings.length).toBeGreaterThan(1);
    for (const f of inv.findings) expect(f.ruleVersion).toBe(RULES[f.ruleId as keyof typeof RULES].version);
  });

  it("persists the rule version and reads it back", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "@missing.md\n" });
    const { store } = freshStore();
    saveConfigInventory(store, await scan([projectRoot(dir)]));

    const stored = listConfigFindings(store.db);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((f) => f.ruleVersion === RULES[f.ruleId as keyof typeof RULES].version)).toBe(true);
    expect(() => store.db.prepare("UPDATE config_findings SET rule_version = 0").run()).toThrow();
  });
});

describe("migration v3 (rule version column)", () => {
  it("adds only the rule_version column and keeps existing findings at version 1", () => {
    const v3 = MIGRATIONS.find((m) => m.version === 3)?.sql ?? "";
    expect(v3).toMatch(/ALTER TABLE config_findings ADD COLUMN rule_version/);
    expect(v3).not.toMatch(/DROP |CREATE TABLE/);

    const db = databaseAt(2);
    db.exec("INSERT INTO config_scans (started_at, status, is_current) VALUES ('2026-01-01T00:00:00.000Z', 'complete', 1)");
    db.exec(`INSERT INTO config_findings (scan_id, finding_key, rule_id, severity, confidence, evidence_json, limitations, recommendation)
             VALUES (1, 'k1', 'CFG-SIZE-001', 'low', 'high', '{}', 'l', 'r')`);

    expect(migrate(db)).toEqual({ from: 2, to: LATEST_SCHEMA_VERSION });
    expect(db.prepare("SELECT rule_id, rule_version FROM config_findings").all()).toEqual([{ rule_id: "CFG-SIZE-001", rule_version: 1 }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrate(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    db.close();
  });

  it("rolls back a failing migration and leaves the version unchanged", () => {
    const db = databaseAt(2);
    db.exec("ALTER TABLE config_findings ADD COLUMN rule_version INTEGER");
    db.exec("INSERT INTO config_scans (started_at, status) VALUES ('2026-01-01T00:00:00.000Z', 'failed')");

    expect(() => migrate(db)).toThrow();
    expect(currentSchemaVersion(db)).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM config_scans").get()).toEqual({ n: 1 });
    db.close();
  });

  it("creates a fresh database at the latest version and reopens it unchanged", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    openStore(dbPath).close();
    const reopened = openStore(dbPath);
    try {
      expect(currentSchemaVersion(reopened.db)).toBe(LATEST_SCHEMA_VERSION);
      const columns = reopened.db.prepare("PRAGMA table_info(config_findings)").all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain("rule_version");
    } finally {
      reopened.close();
    }
  });
});

describe("invalid encoding", () => {
  it("skips a file that is not valid UTF-8 with a fixed code and no content", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "ok\n" });
    writeFileSync(join(dir, "CLAUDE.md"), Buffer.from([0x43, 0x41, 0x4e, 0x41, 0x52, 0x59, 0xff, 0xfe, 0xc3, 0x28, 0x0a]));
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ status: "skipped", errorCode: "INVALID_ENCODING", contentHash: null, lineCount: 0 });
    expect(findingsOf(inv, "CFG-FS-001")[0]?.evidence).toEqual({ reason: "invalid-encoding" });
    expect(JSON.stringify(inv)).not.toContain("CANARY");
  });

  it("still accepts valid multi-byte UTF-8 and a leading BOM", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "﻿Xin chào — mã hóa hợp lệ ✓\n" });
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ status: "ok", errorCode: null, lineCount: 1 });
  });
});
