import { plainHash } from "../fingerprint";
import { isAnalyzedText, type Entry } from "./entry";
import { makeFinding } from "./rules";
import type { Finding, ImportRecord, Limits } from "./types";

const bySourceId = (a: Entry, b: Entry) => (a.record.sourceId < b.record.sourceId ? -1 : a.record.sourceId > b.record.sourceId ? 1 : 0);

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/** Findings derived from one file alone. */
export function fileFindings(entry: Entry, limits: Limits): Finding[] {
  const { record } = entry;
  const id = record.sourceId;
  const findings: Finding[] = [];

  if (record.status === "skipped") {
    const code = record.errorCode ?? "unknown";
    if (code === "TOO_LARGE") {
      findings.push(makeFinding("CFG-SIZE-003", { sourceId: id, confidence: "high", evidence: { sizeBytes: record.sizeBytes, limitBytes: limits.maxFileBytes } }));
    } else {
      findings.push(makeFinding("CFG-FS-001", { sourceId: id, confidence: "high", evidence: { reason: code.toLowerCase().replace(/_/g, "-") } }));
    }
    return findings;
  }

  if (isAnalyzedText(entry)) {
    const tokens = record.estimatedTokens;
    const bigTokens = tokens >= limits.largeTokens;
    const bigLines = record.lineCount >= limits.largeLines;
    if (tokens >= limits.veryLargeTokens) {
      findings.push(makeFinding("CFG-SIZE-002", { sourceId: id, confidence: "medium", evidence: { estimatedTokens: tokens, lines: record.lineCount, thresholdTokens: limits.veryLargeTokens } }));
    } else if (bigTokens || bigLines) {
      const trigger = bigTokens && bigLines ? "both" : bigTokens ? "tokens" : "lines";
      findings.push(makeFinding("CFG-SIZE-001", { sourceId: id, confidence: "medium", evidence: { estimatedTokens: tokens, lines: record.lineCount, thresholdTokens: limits.largeTokens, thresholdLines: limits.largeLines, trigger } }));
    }
  }

  for (const issue of entry.metaIssues) {
    findings.push(makeFinding(issue.ruleId, { sourceId: id, confidence: "high", evidence: { field: issue.field, reason: issue.reason }, discriminator: `${issue.field}:${issue.reason}` }));
  }

  if (entry.settings && !entry.settings.valid) {
    findings.push(makeFinding("CFG-SET-001", { sourceId: id, confidence: "high", evidence: { reason: entry.settings.reason } }));
  }

  if (record.activation !== "unverified-candidate") {
    findings.push(makeFinding("CFG-ACT-001", { sourceId: id, confidence: "high", evidence: { basis: record.activationBasis, activation: record.activation } }));
  }
  return findings;
}

function duplicateFindings(entries: readonly Entry[], limits: Limits): Finding[] {
  const texts = entries.filter(isAnalyzedText);
  const findings: Finding[] = [];

  const exact = groupBy(texts.filter((e) => e.record.sizeBytes >= limits.exactDupMinBytes), (e) => e.record.contentHash);
  const exactPairs = new Set<string>();
  for (const group of exact.values()) {
    if (group.length < 2) continue;
    const ids = group.map((e) => e.record.sourceId).sort();
    ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => exactPairs.add(`${a}|${b}`)));
    const [first, second] = [...group].sort(bySourceId);
    findings.push(makeFinding("CFG-DUP-001", {
      sourceId: first?.record.sourceId, relatedSourceId: second?.record.sourceId, confidence: "high",
      evidence: { fileCount: group.length, sizeBytes: first?.record.sizeBytes ?? 0, crossScope: new Set(group.map((e) => e.record.scope)).size > 1 },
      discriminator: ids.join(","),
    }));
  }

  const candidates = texts
    .map((entry) => ({ entry, hashes: new Set(entry.body.filter((l) => l.normalized.length >= limits.nearDupMinLineChars).map((l) => plainHash(l.normalized))) }))
    .filter((c) => c.hashes.size >= limits.nearDupMinLines)
    .sort((a, b) => bySourceId(a.entry, b.entry))
    .slice(0, limits.maxNearDupFiles);

  const index = new Map<string, number[]>();
  candidates.forEach((c, i) => c.hashes.forEach((h) => index.set(h, [...(index.get(h) ?? []), i])));
  const shared = new Map<string, number>();
  for (const members of index.values()) {
    if (members.length < 2 || members.length > limits.maxSharedLineFanout) continue;
    members.forEach((a, i) => members.slice(i + 1).forEach((b) => shared.set(`${a}:${b}`, (shared.get(`${a}:${b}`) ?? 0) + 1)));
  }
  for (const [pair, count] of [...shared.entries()].sort()) {
    const [ai, bi] = pair.split(":").map(Number);
    const a = candidates[ai ?? -1];
    const b = candidates[bi ?? -1];
    if (!a || !b) continue;
    const similarity = count / (a.hashes.size + b.hashes.size - count);
    if (similarity < limits.nearDupThreshold) continue;
    if (exactPairs.has(`${a.entry.record.sourceId}|${b.entry.record.sourceId}`)) continue;
    const strong = similarity >= 0.9 && Math.min(a.hashes.size, b.hashes.size) >= 15;
    findings.push(makeFinding("CFG-DUP-002", {
      sourceId: a.entry.record.sourceId, relatedSourceId: b.entry.record.sourceId, confidence: strong ? "medium" : "low",
      evidence: { sharedLines: count, linesA: a.hashes.size, linesB: b.hashes.size, similarityPct: Math.round(similarity * 100) },
    }));
  }
  return findings;
}

function scopeFindings(entries: readonly Entry[]): Finding[] {
  const findings: Finding[] = [];
  const named = entries.filter((e) => e.record.status === "ok" && ["rule", "agent", "skill"].includes(e.record.category));
  for (const group of groupBy(named, (e) => `${e.record.category}|${e.layoutRel}`).values()) {
    const user = group.find((e) => e.record.scope === "user");
    const project = group.find((e) => e.record.scope === "project");
    if (!user || !project) continue;
    findings.push(makeFinding("CFG-SCOPE-001", {
      sourceId: user.record.sourceId, relatedSourceId: project.record.sourceId, confidence: "medium",
      evidence: { sameContent: user.record.contentHash === project.record.contentHash },
    }));
  }
  const globbed = entries.filter((e) => e.record.category === "rule" && e.pathGlobs.length > 0);
  for (const group of groupBy(globbed, (e) => e.pathGlobs.join("\n")).values()) {
    if (group.length < 2) continue;
    const [first, second] = [...group].sort(bySourceId);
    findings.push(makeFinding("CFG-SCOPE-002", {
      sourceId: first?.record.sourceId, relatedSourceId: second?.record.sourceId, confidence: "medium",
      evidence: { fileCount: group.length, globCount: first?.pathGlobs.length ?? 0 },
      discriminator: group.map((e) => e.record.sourceId).sort().join(","),
    }));
  }
  return findings;
}

function conflictFindings(entries: readonly Entry[]): Finding[] {
  const findings: Finding[] = [];
  const directives = [...entries].sort(bySourceId).flatMap((entry) => entry.directives.map((d) => ({ entry, d })));
  for (const [key, group] of [...groupBy(directives, (x) => x.d.remainderKey)].sort()) {
    const always = group.filter((x) => x.d.polarity === "always");
    const never = group.filter((x) => x.d.polarity === "never");
    const a = always[0];
    const b = never[0];
    if (!a || !b) continue;
    const sameFile = a.entry === b.entry;
    findings.push(makeFinding("CFG-CONF-001", {
      sourceId: a.entry.record.sourceId, relatedSourceId: sameFile ? null : b.entry.record.sourceId, confidence: sameFile ? "medium" : "low",
      evidence: { alwaysLine: a.d.line, neverLine: b.d.line, alwaysCount: always.length, neverCount: never.length, remainderWords: a.d.remainderWords, sameFile },
      discriminator: key,
    }));
  }

  const settings = entries.flatMap((e) => (e.settings?.valid ? [{ e, s: e.settings }] : []));
  for (const { e, s } of settings) {
    const overlap = [...s.allowHashes].filter((h) => s.denyHashes.has(h)).length;
    if (overlap > 0) findings.push(makeFinding("CFG-CONF-002", { sourceId: e.record.sourceId, confidence: "high", evidence: { overlappingRules: overlap, sameFile: true } }));
  }
  for (const a of settings) {
    for (const b of settings) {
      if (a.e === b.e) continue;
      const overlap = [...a.s.allowHashes].filter((h) => b.s.denyHashes.has(h)).length;
      if (overlap > 0) findings.push(makeFinding("CFG-CONF-002", { sourceId: a.e.record.sourceId, relatedSourceId: b.e.record.sourceId, confidence: "medium", evidence: { overlappingRules: overlap, sameFile: false } }));
    }
  }

  const hooks = groupBy(settings.flatMap(({ e, s }) => s.hookKeys.map((k) => ({ e, k }))), (x) => x.k);
  for (const [key, group] of [...hooks].sort()) {
    if (group.length < 2) continue;
    const files = [...new Set(group.map((x) => x.e))].sort(bySourceId);
    findings.push(makeFinding("CFG-HOOK-001", {
      sourceId: files[0]?.record.sourceId, relatedSourceId: files[1]?.record.sourceId, confidence: files.length === 1 ? "high" : "medium",
      evidence: { occurrences: group.length, files: files.length },
      discriminator: key,
    }));
  }
  return findings;
}

const IMPORT_RULE: Record<string, "CFG-IMP-001" | "CFG-IMP-002" | "CFG-IMP-003" | "CFG-IMP-004" | undefined> = {
  broken: "CFG-IMP-001",
  "outside-roots": "CFG-IMP-002",
  cycle: "CFG-IMP-003",
  "too-deep": "CFG-IMP-004",
};

export function importFindings(imports: readonly ImportRecord[], limits: Limits): Finding[] {
  return imports.flatMap((edge) => {
    const ruleId = IMPORT_RULE[edge.status];
    if (!ruleId) return [];
    return [makeFinding(ruleId, {
      sourceId: edge.sourceId, relatedSourceId: edge.targetSourceId, confidence: edge.status === "broken" || edge.status === "outside-roots" ? "medium" : "high",
      evidence: { line: edge.line, depth: edge.depth, maxDepth: limits.maxImportDepth },
      discriminator: `${edge.line}:${edge.status}`,
    })];
  });
}

export function crossFileFindings(entries: readonly Entry[], limits: Limits): Finding[] {
  return [...duplicateFindings(entries, limits), ...scopeFindings(entries), ...conflictFindings(entries)];
}
