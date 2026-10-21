import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { fingerprint, keyedHash } from "../fingerprint";
import { crossFileFindings, fileFindings, importFindings } from "./analyze";
import { enumerateRoot, type Candidate } from "./discover";
import type { Entry } from "./entry";
import { parseFrontmatter, validateMetadata } from "./frontmatter";
import { makeFinding } from "./rules";
import { canonicalRoot, readConfigFile, withinAny, type SafeRead } from "./safe-fs";
import { analyzeSettings } from "./settings";
import { bodyLines, extractDirectives, extractImports, splitLines } from "./text";
import {
  LIMITS,
  type ActivationStatus,
  type ConfigCategory,
  type ConfigFileRecord,
  type ConfigInventory,
  type ConfigRoot,
  type ConfigScope,
  type Finding,
  type ImportRecord,
  type ImportStatus,
  type Limits,
  type RootResult,
  type ScanOptions,
} from "./types";

interface Source {
  readonly scope: ConfigScope;
  readonly category: ConfigCategory;
  readonly layoutRel: string;
  readonly lexicalPath: string;
  readonly importDepth: number;
}

interface Context {
  readonly salt: Buffer;
  readonly limits: Limits;
  readonly includeLabels: boolean;
}

const hasText = (category: ConfigCategory) => category !== "settings";
const hasFrontmatter = (category: ConfigCategory) => category === "rule" || category === "agent" || category === "skill";
const hasImports = (category: ConfigCategory) => category === "claude_md" || category === "rule" || category === "imported";

function activationFor(category: ConfigCategory, hasGlobs: boolean): { status: ActivationStatus; basis: string } {
  if (category === "agent") return { status: "on-demand", basis: "on-demand-agent" };
  if (category === "skill") return { status: "on-demand", basis: "on-demand-skill" };
  if (category === "imported") return { status: "import-only", basis: "import-target-only" };
  if (category === "rule" && hasGlobs) return { status: "conditional", basis: "conditional-path-rule" };
  return { status: "unverified-candidate", basis: category === "settings" ? "settings-precedence-unverified" : "launch-context-unverified" };
}

const lineCountOf = (text: string): number => splitLines(text).length;

function buildEntry(source: Source, read: SafeRead, ctx: Context): Entry {
  const canonicalPath = read.canonicalPath;
  const fp = fingerprint(ctx.salt, "config-path", canonicalPath ?? source.lexicalPath);
  const base = {
    sourceId: `cfg_${fp.slice(0, 12)}`,
    fingerprint: fp,
    scope: source.scope,
    category: source.category,
    importDepth: source.importDepth,
    label: ctx.includeLabels ? basename(source.lexicalPath) : null,
  };
  const empty = { layoutRel: source.layoutRel, canonicalPath, body: [], pathGlobs: [], directives: [], settings: null, metaIssues: [], rawImports: [] };

  if (read.kind === "skipped") {
    const activation = activationFor(source.category, false);
    return {
      ...empty,
      record: {
        ...base, status: "skipped", errorCode: read.code, sizeBytes: read.sizeBytes, lineCount: 0, contentHash: null, estimatedTokens: 0,
        activation: activation.status, activationBasis: activation.basis, frontmatterState: "none", metadata: {}, detail: null,
      },
    };
  }

  const lines = splitLines(read.text);
  const fm = hasFrontmatter(source.category) ? parseFrontmatter(lines, ctx.limits) : null;
  const validated = fm ? validateMetadata(source.category, fm) : null;
  const bodyStart = fm?.bodyStart ?? 0;
  const body = hasText(source.category) ? bodyLines(lines, bodyStart) : [];
  const settings = source.category === "settings" ? analyzeSettings(read.text, ctx.limits) : null;
  const activation = activationFor(source.category, (validated?.pathGlobs.length ?? 0) > 0);
  const record: ConfigFileRecord = {
    ...base,
    status: "ok",
    errorCode: null,
    sizeBytes: read.sizeBytes,
    lineCount: lineCountOf(read.text),
    contentHash: keyedHash(ctx.salt).update(read.text).digest("hex"),
    estimatedTokens: Math.ceil(read.sizeBytes / 4),
    activation: activation.status,
    activationBasis: activation.basis,
    frontmatterState: fm?.state ?? "none",
    metadata: validated?.metadata ?? {},
    detail: settings?.valid ? settings.detail : null,
  };
  return {
    record,
    layoutRel: source.layoutRel,
    canonicalPath,
    body,
    pathGlobs: validated?.pathGlobs ?? [],
    directives: hasText(source.category) ? extractDirectives(body) : [],
    settings,
    metaIssues: validated?.issues ?? [],
    rawImports: hasImports(source.category) ? extractImports(lines, bodyStart, ctx.limits.maxImportsPerFile) : [],
  };
}

interface Edge {
  readonly from: Entry;
  readonly line: number;
  readonly status: ImportStatus;
  readonly target: Entry | null;
  readonly depth: number;
}

/**
 * `allowed` holds canonical roots (enforced by the reader before any open). `prefilter` additionally
 * accepts the roots as the caller spelled them, so an absolute import written through a symlinked
 * prefix (for example /var -> /private/var) is not misjudged as outside before the canonical check.
 */
async function resolveImports(entries: Entry[], allowed: readonly string[], prefilter: readonly string[], ctx: Context): Promise<Edge[]> {
  const known = new Map(entries.flatMap((e) => (e.canonicalPath ? [[e.canonicalPath, e] as const] : [])));
  const queue = entries.filter((e) => e.rawImports.length > 0);
  const edges: Edge[] = [];
  let importedCount = 0;

  for (let next = queue.shift(); next; next = queue.shift()) {
    const from = next;
    const depth = from.record.importDepth + 1;
    for (const imp of from.rawImports) {
      const edge = (status: ImportStatus, target: Entry | null = null): void => {
        edges.push({ from, line: imp.line, status, target, depth });
      };
      if (imp.target.startsWith("~") || from.canonicalPath === null) {
        edge("unresolvable");
        continue;
      }
      const lexical = isAbsolute(imp.target) ? normalize(imp.target) : resolve(dirname(from.canonicalPath), imp.target);
      if (!withinAny(lexical, prefilter)) {
        edge("outside-roots");
        continue;
      }
      if (depth > ctx.limits.maxImportDepth) {
        edge("too-deep");
        continue;
      }
      const read = await readConfigFile(lexical, allowed, ctx.limits.maxFileBytes);
      if (read.kind === "skipped") {
        edge(read.code === "ENOENT" ? "broken" : read.code === "OUTSIDE_ROOTS" ? "outside-roots" : "skipped");
        continue;
      }
      const existing = known.get(read.canonicalPath);
      if (existing) {
        edge("resolved", existing);
        continue;
      }
      if (importedCount >= ctx.limits.maxImportedFiles) {
        edge("skipped");
        continue;
      }
      importedCount += 1;
      const imported = buildEntry(
        { scope: from.record.scope, category: "imported", layoutRel: "imported", lexicalPath: lexical, importDepth: depth },
        read,
        ctx,
      );
      entries.push(imported);
      known.set(read.canonicalPath, imported);
      queue.push(imported);
      edge("resolved", imported);
    }
  }
  return edges;
}

/** Marks edges that close a cycle (a resolved edge pointing at a file still on the DFS stack). */
function cycleEdges(edges: readonly Edge[]): Set<Edge> {
  const outgoing = new Map<Entry, Edge[]>();
  for (const edge of edges) if (edge.status === "resolved" && edge.target) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  const state = new Map<Entry, "active" | "done">();
  const back = new Set<Edge>();
  // Start from files in structural order (depth, scope, category, layout path), never salted ids, so the
  // edge reported as closing a cycle depends only on the configuration's shape.
  const structural = (e: Entry): string => `${e.record.importDepth}|${e.record.scope}|${e.record.category}|${e.layoutRel}`;
  const roots = [...outgoing.keys()].sort((a, b) => (structural(a) < structural(b) ? -1 : structural(a) > structural(b) ? 1 : a.record.sourceId < b.record.sourceId ? -1 : 1));

  for (const root of roots) {
    if (state.has(root)) continue;
    const stack: Array<{ node: Entry; edges: Edge[]; index: number }> = [{ node: root, edges: outgoing.get(root) ?? [], index: 0 }];
    state.set(root, "active");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const edge = frame.edges[frame.index];
      frame.index += 1;
      if (!edge) {
        state.set(frame.node, "done");
        stack.pop();
        continue;
      }
      const target = edge.target;
      if (!target) continue;
      const seen = state.get(target);
      if (seen === "active") back.add(edge);
      else if (seen === undefined) {
        state.set(target, "active");
        stack.push({ node: target, edges: outgoing.get(target) ?? [], index: 0 });
      }
    }
  }
  return back;
}

const compareFinding = (a: Finding, b: Finding): number =>
  a.ruleId !== b.ruleId ? (a.ruleId < b.ruleId ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * Read-only inventory and static audit of explicitly supplied roots. Nothing outside the canonical
 * roots is opened, nothing is written, and no file content leaves this function except as structural
 * facts: counts, line numbers, hashes keyed by the local salt, and fixed code words.
 */
export async function scanConfig(roots: readonly ConfigRoot[], options: ScanOptions): Promise<ConfigInventory> {
  const limits: Limits = { ...LIMITS, ...options.limits };
  const ctx: Context = { salt: options.salt, limits, includeLabels: options.includeLabels ?? false };

  const rootResults: RootResult[] = [];
  const available: Array<{ kind: ConfigRoot["kind"]; real: string }> = [];
  for (const root of roots) {
    const canonical = await canonicalRoot(root.dir);
    rootResults.push({ kind: root.kind, status: canonical.ok ? "ok" : "unavailable", errorCode: canonical.ok ? null : canonical.code });
    if (canonical.ok && !available.some((a) => a.kind === root.kind && a.real === canonical.real)) available.push({ kind: root.kind, real: canonical.real });
  }
  available.sort((a, b) => (a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.real < b.real ? -1 : 1));
  const allowed = available.map((a) => a.real);

  const candidates: Candidate[] = [];
  let truncated = false;
  for (const root of available) {
    const found = await enumerateRoot(root.kind, root.real, allowed, limits);
    candidates.push(...found.candidates);
    truncated = truncated || found.truncated;
  }

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const read = await readConfigFile(candidate.path, allowed, limits.maxFileBytes);
    if (read.canonicalPath !== null) {
      if (seen.has(read.canonicalPath)) continue;
      seen.add(read.canonicalPath);
    }
    entries.push(buildEntry({ ...candidate, lexicalPath: candidate.path, importDepth: 0 }, read, ctx));
  }

  const prefilter = [...allowed, ...roots.filter((r) => isAbsolute(r.dir)).map((r) => resolve(r.dir))];
  const edges = await resolveImports(entries, allowed, prefilter, ctx);
  const cycles = cycleEdges(edges);
  const imports: ImportRecord[] = edges.map((edge) => ({
    sourceId: edge.from.record.sourceId,
    line: edge.line,
    status: cycles.has(edge) ? "cycle" : edge.status,
    targetSourceId: edge.target?.record.sourceId ?? null,
    depth: edge.depth,
  }));

  const findings = [
    ...entries.flatMap((entry) => fileFindings(entry, limits)),
    ...crossFileFindings(entries, limits),
    ...importFindings(imports, limits),
    ...(truncated ? [makeFinding("CFG-SCAN-001", { confidence: "high", evidence: { limit: limits.maxFiles } })] : []),
  ].sort(compareFinding);

  const failed = rootResults.length > 0 && rootResults.every((r) => r.status === "unavailable");
  const partial = rootResults.some((r) => r.status === "unavailable");
  return {
    status: failed ? "failed" : partial ? "partial" : "complete",
    roots: rootResults,
    files: entries.map((e) => e.record).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
    imports: imports.sort((a, b) => (a.sourceId !== b.sourceId ? (a.sourceId < b.sourceId ? -1 : 1) : a.line - b.line || (a.status < b.status ? -1 : 1))),
    findings,
  };
}

