import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanConfig, type ConfigInventory, type ConfigRoot, type Finding, type ScanOptions } from "@/core/config";

export const SALT = Buffer.alloc(32, 7);

/** Strings planted in synthetic configuration. None may ever reach a database row, finding or log. */
export const CONFIG_CANARIES = [
  "CANARY_CFG_BODY_41af",
  "CANARY_HOOK_CMD_5d2e",
  "CANARY_ENV_VALUE_c0de",
  "CANARY_PERM_RULE_88b1",
  "CANARY_DESC_TEXT_2e90",
  "CANARY_OUTSIDE_FILE_7710",
  "CANARY_SECRET_TOKEN_7b13",
] as const;

export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export const userRoot = (dir: string): ConfigRoot => ({ kind: "user-config", dir });
export const projectRoot = (dir: string): ConfigRoot => ({ kind: "project", dir });

export function scan(roots: readonly ConfigRoot[], options: Partial<ScanOptions> = {}): Promise<ConfigInventory> {
  return scanConfig(roots, { salt: SALT, includeLabels: true, ...options });
}

export const findingsOf = (inv: ConfigInventory, ruleId: string): Finding[] => inv.findings.filter((f) => f.ruleId === ruleId);

export function fileOf(inv: ConfigInventory, label: string, scope?: "user" | "project") {
  const matches = inv.files.filter((f) => f.label === label && (scope === undefined || f.scope === scope));
  if (matches.length !== 1) throw new Error(`expected exactly one file labelled ${label}, found ${matches.length}`);
  return matches[0]!;
}

export const countBy = (inv: ConfigInventory): Record<string, number> =>
  inv.files.reduce<Record<string, number>>((acc, f) => ({ ...acc, [`${f.scope}:${f.category}`]: (acc[`${f.scope}:${f.category}`] ?? 0) + 1 }), {});

/** Content, size, mtime and link targets of every entry below `root`, for read-only assertions. */
export function treeDigest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = lstatSync(full);
      const rel = full.slice(root.length);
      if (info.isSymbolicLink()) out.push(`${rel}|link|${readlinkSync(full)}`);
      else if (info.isDirectory()) {
        out.push(`${rel}|dir|${info.mode & 0o777}`);
        walk(full);
      } else out.push(`${rel}|file|${info.size}|${info.mtimeMs}|${info.mode & 0o777}|${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

export const agentFile = (frontmatter: string, body = "Body text for the agent goes here.\n"): string => `---\n${frontmatter}\n---\n${body}`;
export const VALID_AGENT = agentFile("name: reviewer\ndescription: Reviews code\ntools: [Read, Grep]\nmodel: sonnet");
export const VALID_SKILL = agentFile("name: pdf\ndescription: Handles PDFs", "Skill body text.\n");
