import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { saveConfigInventory, scanAndIngest } from "@/core/store";
import { MIGRATIONS } from "@/core/store";
import { CONFIG_CANARIES, VALID_AGENT, agentFile, projectRoot, scan, userRoot, writeTree } from "./config-helpers";
import { fixturePath } from "./helpers";
import { freshStore, tempDir } from "./store-helpers";

export const USAGE_FIXTURES = ["usage-basic.jsonl", "replay-a.jsonl", "replay-b.jsonl", "malformed-lines.jsonl"] as const;

/** Synthetic configuration with planted canaries; never read from a real location. */
export function plantConfig(base: string): { user: string; proj: string } {
  const user = join(base, "home", ".claude");
  const proj = join(base, "workspace-secret-name");
  writeTree(user, {
    "CLAUDE.md": "CANARY_CFG_BODY_41af personal notes\n- Always use tabs for indentation.\n",
    "settings.json": JSON.stringify({
      env: { API_TOKEN: "CANARY_SECRET_TOKEN_7b13", MODE: "CANARY_ENV_VALUE_c0de" },
      permissions: { allow: ["Bash(CANARY_PERM_RULE_88b1:*)"], deny: ["Bash(CANARY_PERM_RULE_88b1:*)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "CANARY_HOOK_CMD_5d2e --flag" }] }] },
    }),
    "agents/reviewer.md": agentFile("name: reviewer\ndescription: |\n  CANARY_DESC_TEXT_2e90 long text\n  more text", "CANARY_CFG_BODY_41af agent body\n"),
    "rules/style.md": "Never use tabs for indentation.\n",
  });
  writeTree(proj, { "CLAUDE.md": "Project CANARY_CFG_BODY_41af\nSee @docs/missing.md\n", ".claude/agents/a.md": VALID_AGENT });
  return { user, proj };
}

export interface Populated {
  readonly dbPath: string;
  readonly base: string;
}

/** A temporary, fully synthetic database with usage and a complete configuration scan. */
export async function populatedDatabase(options: { usage?: boolean; config?: boolean } = {}): Promise<Populated> {
  const { usage = true, config = true } = options;
  const base = tempDir();
  const { store, dbPath } = freshStore(base);
  if (usage) await scanAndIngest(store, USAGE_FIXTURES.map(fixturePath));
  if (config) {
    const { user, proj } = plantConfig(base);
    saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)]));
  }
  store.close();
  return { dbPath, base };
}

export const ALL_CANARIES: readonly string[] = [
  "CANARY_PROMPT_7f3a",
  "CANARY_RESPONSE_2d90",
  "CANARY_PATH_9c1d",
  "CANARY_CMD_a7e1",
  "CANARY_RESULT_61bb",
  "CANARY_UNKNOWN_44b2",
  "CANARY_BADUSAGE_0f12",
  "CANARY_MALFORMED_5e8d",
  "CANARY_GREP_3b77",
  ...CONFIG_CANARIES,
  "CANARY_NAMED_RULE_a1f0",
];

/** A database file at schema `version`, built from the real migrations. */
export function databaseAtVersion(version: number): string {
  const dir = tempDir();
  const dbPath = join(dir, "old.db");
  const raw = new DatabaseSync(dbPath);
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) raw.exec(m.sql);
  raw.exec(`PRAGMA user_version = ${version}`);
  raw.close();
  return dbPath;
}

export function fileWithBytes(bytes: Uint8Array): string {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "x.db");
  writeFileSync(target, bytes);
  return target;
}

/** Bytes and mtime of the file plus the names beside it: proves a read left no trace. */
export function footprint(dbPath: string): { bytes: string; mtimeMs: number; siblings: string[] } {
  const dir = join(dbPath, "..");
  return { bytes: readFileSync(dbPath).toString("hex"), mtimeMs: statSync(dbPath).mtimeMs, siblings: readdirSync(dir).sort() };
}
