import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG_CANARIES, VALID_AGENT, VALID_SKILL, agentFile, writeTree } from "./config-helpers";
import { realTemp } from "./cli-helpers";

export const ROOT = resolve(".");
export const CONFIG_CLI = join(ROOT, ".cli-build", "cli", "config-main.js");
export const SECRET_DIR = "SECRET_PROJECT_DIR_name";

export interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Box {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly user: string;
  readonly project: string;
  readonly db: string;
}

/** A synthetic user config dir and project dir, both in real form, with planted canaries. Never a real location. */
export function configBox(): Box {
  const root = realTemp();
  const user = join(root, "home-config");
  const project = join(root, SECRET_DIR);
  for (const dir of [join(root, "cwd"), join(root, "home"), join(root, "out")]) mkdirSync(dir);
  writeTree(user, {
    "CLAUDE.md": `${CONFIG_CANARIES[0]} personal notes\n- Always use tabs for indentation.\n`,
    "settings.json": JSON.stringify({
      env: { API_TOKEN: CONFIG_CANARIES[6], MODE: CONFIG_CANARIES[2] },
      permissions: { allow: [`Bash(${CONFIG_CANARIES[3]}:*)`], deny: [] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: `${CONFIG_CANARIES[1]} --flag` }] }] },
    }),
    "agents/reviewer.md": agentFile(`name: reviewer\ndescription: |\n  ${CONFIG_CANARIES[4]} long text\n  more text`, `${CONFIG_CANARIES[0]} agent body\n`),
    "rules/style.md": "Never use tabs for indentation.\n",
    "skills/pdf/SKILL.md": VALID_SKILL,
    "notes.md": "an unrecognised file that the scanner must ignore\n",
    "README.txt": "also ignored\n",
  });
  writeTree(project, { "CLAUDE.md": `Project ${CONFIG_CANARIES[0]}\nSee @docs/missing.md\n`, ".claude/agents/a.md": VALID_AGENT });
  return { root, cwd: join(root, "cwd"), home: join(root, "home"), user, project, db: join(root, "out", "data", "usage.db") };
}

/** Runs the compiled config CLI under plain Node with a scrubbed environment and an isolated cwd and HOME. */
export function configCli(args: string[], box: Pick<Box, "cwd" | "home">, extraEnv: Record<string, string> = {}): Result {
  const r = spawnSync(process.execPath, ["--no-warnings", CONFIG_CLI, ...args], {
    cwd: box.cwd,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: box.home, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const scanArgs = (box: Box, db: string = box.db): string[] => ["--user-root", box.user, "--project-root", box.project, "--db", db];

export function rows(dbPath: string, sql: string): Record<string, unknown>[] {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return raw.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

export const countOf = (dbPath: string, table: string): number => {
  const allowed = ["config_scans", "config_files", "config_findings", "config_imports", "usage_records", "scan_runs"];
  if (!allowed.includes(table)) throw new Error("unexpected table");
  return Number(rows(dbPath, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.["n"]);
};
