import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { lstatKind, withinAny } from "./safe-fs";
import type { ConfigCategory, ConfigScope, Limits, RootKind } from "./types";

export interface Candidate {
  /** Lexical absolute path; the reader canonicalizes and checks it before opening. */
  readonly path: string;
  readonly category: ConfigCategory;
  readonly scope: ConfigScope;
  /** Path relative to the Claude config directory equivalent (`.claude/` stripped for projects). Memory only. */
  readonly layoutRel: string;
}

type DirPattern = "markdown-tree" | "skill-dirs";

interface FileEntry {
  readonly rel: string;
  readonly category: ConfigCategory;
  readonly layoutRel: string;
}
interface DirEntry {
  readonly rel: string;
  readonly category: ConfigCategory;
  readonly layoutRel: string;
  readonly pattern: DirPattern;
}

// ASSUMED layout (documented Claude Code conventions; unverified against live installs).
const LAYOUT: Record<RootKind, { readonly files: readonly FileEntry[]; readonly dirs: readonly DirEntry[] }> = {
  "user-config": {
    files: [
      { rel: "CLAUDE.md", category: "claude_md", layoutRel: "CLAUDE.md" },
      { rel: "settings.json", category: "settings", layoutRel: "settings.json" },
      { rel: "settings.local.json", category: "settings", layoutRel: "settings.local.json" },
    ],
    dirs: [
      { rel: "rules", category: "rule", layoutRel: "rules", pattern: "markdown-tree" },
      { rel: "agents", category: "agent", layoutRel: "agents", pattern: "markdown-tree" },
      { rel: "skills", category: "skill", layoutRel: "skills", pattern: "skill-dirs" },
    ],
  },
  project: {
    files: [
      { rel: "CLAUDE.md", category: "claude_md", layoutRel: "CLAUDE.md" },
      { rel: "CLAUDE.local.md", category: "claude_md", layoutRel: "CLAUDE.local.md" },
      { rel: ".claude/CLAUDE.md", category: "claude_md", layoutRel: ".claude-CLAUDE.md" },
      { rel: ".claude/settings.json", category: "settings", layoutRel: "settings.json" },
      { rel: ".claude/settings.local.json", category: "settings", layoutRel: "settings.local.json" },
    ],
    dirs: [
      { rel: ".claude/rules", category: "rule", layoutRel: "rules", pattern: "markdown-tree" },
      { rel: ".claude/agents", category: "agent", layoutRel: "agents", pattern: "markdown-tree" },
      { rel: ".claude/skills", category: "skill", layoutRel: "skills", pattern: "skill-dirs" },
    ],
  },
};

export const SCOPE_OF: Record<RootKind, ConfigScope> = { "user-config": "user", project: "project" };

interface WalkContext {
  readonly limits: Limits;
  readonly allowed: readonly string[];
  readonly out: Candidate[];
  readonly scope: ConfigScope;
  readonly category: ConfigCategory;
  /** Canonical directories already walked, so a directory symlink loop is never expanded twice. */
  readonly visited: Set<string>;
  truncated: boolean;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function listDir(dir: string, limit: number): Promise<{ name: string; isDir: boolean; isFile: boolean; isLink: boolean }[]> {
  try {
    const entries = (await readdir(dir, { withFileTypes: true })).sort(byName).slice(0, limit);
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile(), isLink: e.isSymbolicLink() }));
  } catch {
    return [];
  }
}

/** For a symlink, report the target's type only if it stays inside the allowed roots. */
async function linkTarget(path: string, allowed: readonly string[]): Promise<"dir" | "file" | "outside" | "broken"> {
  try {
    const real = await realpath(path);
    if (!withinAny(real, allowed)) return "outside";
    return (await stat(real)).isDirectory() ? "dir" : "file";
  } catch {
    return "broken";
  }
}

function push(ctx: WalkContext, candidate: Candidate): boolean {
  if (ctx.out.length >= ctx.limits.maxFiles) {
    ctx.truncated = true;
    return false;
  }
  ctx.out.push(candidate);
  return true;
}

async function walkMarkdown(dir: string, layoutRel: string, depth: number, ctx: WalkContext): Promise<void> {
  if (depth > ctx.limits.maxEnumDepth) return;
  const real = await realpath(dir).catch(() => null);
  if (real === null || ctx.visited.has(real)) return;
  ctx.visited.add(real);
  for (const entry of await listDir(dir, ctx.limits.maxDirEntries)) {
    const full = join(dir, entry.name);
    const rel = `${layoutRel}/${entry.name}`;
    let isDir = entry.isDir;
    let isFile = entry.isFile;
    if (entry.isLink) {
      const target = await linkTarget(full, ctx.allowed);
      // Outside or broken links become candidates so the reader reports a code instead of hiding them.
      if (target === "outside" || target === "broken") isFile = /\.md$/i.test(entry.name);
      else {
        isDir = target === "dir";
        isFile = target === "file";
      }
    }
    if (isDir) await walkMarkdown(full, rel, depth + 1, ctx);
    else if (isFile && /\.md$/i.test(entry.name) && !push(ctx, { path: full, category: ctx.category, scope: ctx.scope, layoutRel: rel })) return;
  }
}

async function walkSkills(dir: string, layoutRel: string, ctx: WalkContext): Promise<void> {
  for (const entry of await listDir(dir, ctx.limits.maxDirEntries)) {
    const full = join(dir, entry.name);
    const looksLikeDir = entry.isDir || entry.isLink;
    if (!looksLikeDir) continue;
    const skillFile = join(full, "SKILL.md");
    if ((await lstatKind(skillFile)) === "missing" && !entry.isLink) continue;
    if (!push(ctx, { path: skillFile, category: "skill", scope: ctx.scope, layoutRel: `${layoutRel}/${entry.name}/SKILL.md` })) return;
  }
}

/** Lists candidate files for one canonical root. Nothing is read here. */
export async function enumerateRoot(
  kind: RootKind,
  realRoot: string,
  allowed: readonly string[],
  limits: Limits,
): Promise<{ readonly candidates: readonly Candidate[]; readonly truncated: boolean }> {
  const scope = SCOPE_OF[kind];
  const out: Candidate[] = [];
  let truncated = false;
  const layout = LAYOUT[kind];

  for (const file of layout.files) {
    const path = join(realRoot, file.rel);
    if ((await lstatKind(path)) === "missing") continue;
    if (out.length >= limits.maxFiles) {
      truncated = true;
      break;
    }
    out.push({ path, category: file.category, scope, layoutRel: file.layoutRel });
  }
  for (const dir of layout.dirs) {
    const path = join(realRoot, dir.rel);
    const ctx: WalkContext = { limits, allowed, out, scope, category: dir.category, visited: new Set(), truncated };
    const kind = await lstatKind(path);
    if (kind === "missing") continue;
    if (kind === "symlink") {
      // A symlinked layout directory is never listed unless it stays inside the allowed roots. An
      // outside one becomes a single candidate so the reader reports OUTSIDE_ROOTS instead of hiding it.
      const target = await linkTarget(path, allowed);
      if (target === "outside") push(ctx, { path, category: dir.category, scope, layoutRel: dir.layoutRel });
      truncated = ctx.truncated;
      if (target !== "dir") continue;
    }
    if (dir.pattern === "markdown-tree") await walkMarkdown(path, dir.layoutRel, 0, ctx);
    else await walkSkills(path, dir.layoutRel, ctx);
    truncated = ctx.truncated;
  }
  return { candidates: out, truncated };
}
