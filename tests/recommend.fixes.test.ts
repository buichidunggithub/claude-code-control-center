import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalysis, type RecommendationsQuery } from "@/core/analysis";
import { accountingStateCounts, accountingSummary, identityUncertainSourceCount, openStore, saveConfigInventory, scanAndIngest, settledByModel } from "@/core/store";
import { projectRoot, scan, userRoot, writeTree } from "./config-helpers";
import { registerTempStoreCleanup, freshStore, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const ALL: RecommendationsQuery = { category: null, priority: null, limit: 200, offset: 0 };
const PAGE = { sidechain: "include", limit: 200, offset: 0 } as const;

interface EventOptions {
  readonly id?: string | null;
  readonly model?: string | null;
  readonly input?: number;
  readonly side?: boolean;
  readonly day?: number;
}

/** One synthetic assistant event. `id: null` and no uuid makes an anonymous event (no reliable identity). */
function event(i: number, { id = `msg_${i}`, model = "model-alpha", input = 10, side = false, day = (i % 9) + 1 }: EventOptions = {}): string {
  return JSON.stringify({
    type: "assistant",
    ...(id === null ? {} : { uuid: `u-${i}` }),
    sessionId: `sess-${i % 4}`,
    timestamp: `2026-03-0${day}T10:00:00.000Z`,
    isSidechain: side,
    message: { ...(id === null ? {} : { id }), role: "assistant", model, content: [], usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;
const write = (path: string, text: string) => writeFileSync(path, text);

/** `settled` unique events over two models, plus `groups` conflicting groups of `perGroup` records each. */
function mixedUsage(settled: number, groups: number, perGroup: number): string {
  const rows = Array.from({ length: settled }, (_, i) => event(i, { model: i % 2 === 0 ? "model-alpha" : "model-beta" }));
  for (let g = 0; g < groups; g++) {
    for (let k = 0; k < perGroup; k++) rows.push(event(1000 + g * 10 + k, { id: `msg_conflict_${g}`, model: "model-alpha", input: 100 + k }));
  }
  return lines(...rows);
}

async function usageDb(text: string) {
  const base = tempDir();
  const { store, dbPath } = freshStore(base);
  const file = join(base, "events.jsonl");
  write(file, text);
  await scanAndIngest(store, [file]);
  store.close();
  return { dbPath, base, file };
}

const recOf = (dbPath: string, id: string) => createAnalysis(dbPath).recommendations(ALL).data?.items.find((r) => r.id === id);
const modelRule = (dbPath: string) => createAnalysis(dbPath).recommendations(ALL).data?.rules.find((r) => r.ruleId === "REC-USE-MODELS");

describe("Fix A: unresolved share is computed in records", () => {
  it("reads the number of records inside conflicting groups from the accounting data", async () => {
    const { dbPath } = await usageDb(mixedUsage(40, 2, 3));
    const store = openStore(dbPath);
    const oracle = accountingSummary(store.db);
    const states = accountingStateCounts(store.db);
    store.close();

    const rec = recOf(dbPath, "REC-DQ-ACCOUNTING");
    const metric = (name: string) => rec?.evidence.metrics.find((m) => m.name === name)?.value;
    expect(oracle.conflicting.groups).toBe(2);
    expect(states.conflicting).toBe(6);
    expect(metric("conflictingGroups")).toBe(2);
    expect(metric("conflictingRecords")).toBe(6);
    expect(rec?.facts.join(" ")).toContain("2 groups (6 records) share an identity");
  });

  it("accepts exactly 10% unresolved records and rejects more, even when the group count alone looks small", async () => {
    // 90 settled + 5 groups x 2 records = 10 unresolved records of 100: exactly 10%.
    const exact = await usageDb(mixedUsage(90, 5, 2));
    expect(modelRule(exact.dbPath)?.outcome).toBe("generated");
    // 6 groups x 2 = 12 records of 102 (11.8%). Six groups against 90 settled would be 6% under the old mixed units.
    const over = await usageDb(mixedUsage(90, 6, 2));
    expect(modelRule(over.dbPath)).toMatchObject({ outcome: "insufficient-evidence", reason: "unresolved-share-too-high" });
    // 4 groups x 3 = 12 records: same record count, fewer groups, same verdict.
    const bigGroups = await usageDb(mixedUsage(90, 4, 3));
    expect(modelRule(bigGroups.dbPath)?.reason).toBe("unresolved-share-too-high");
  });

  it("counts ambiguous (identity-less) records in the same unit", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => event(i, { model: i % 2 === 0 ? "model-alpha" : "model-beta" }));
    const anonymous = (n: number) => Array.from({ length: n }, (_, i) => event(2000 + i, { id: null, model: "model-alpha", input: 7 + i }));
    expect(modelRule((await usageDb(lines(...rows, ...anonymous(10)))).dbPath)?.outcome).toBe("generated");
    expect(modelRule((await usageDb(lines(...rows, ...anonymous(11)))).dbPath)?.reason).toBe("unresolved-share-too-high");
  });
});

describe("Fix B/H: model recognition through the real pipeline", () => {
  it("does not let unrecognized names satisfy the two-model or attribution conditions, and never echoes them", async () => {
    const hostile = ["has spaces", "home/someone/secret-project", "CANARY_PATH_9c1d/etc", "tab\tname"];
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => event(i, { model: "model-alpha" })),
      ...hostile.flatMap((name, h) => Array.from({ length: 5 }, (_, i) => event(100 + h * 10 + i, { model: name }))),
    ];
    const { dbPath } = await usageDb(lines(...rows));
    const page = createAnalysis(dbPath).recommendations(ALL).data;

    expect(page?.rules.find((r) => r.ruleId === "REC-USE-MODELS")).toMatchObject({ outcome: "insufficient-evidence", reason: "model-attribution-too-low" });
    expect(JSON.stringify(page)).not.toMatch(/CANARY|secret-project|has spaces/);
  });

  it("reports unrecognized records once, as an unattributed total, next to a valid observation", async () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => event(i, { model: i % 2 ? "Model-Beta" : "model-alpha" })),
      ...["a/b", "c d"].flatMap((name, h) => Array.from({ length: 2 }, (_, i) => event(100 + h * 10 + i, { model: name }))),
    ];
    const { dbPath } = await usageDb(lines(...rows));
    const rec = recOf(dbPath, "REC-USE-MODELS");

    expect(rec?.facts.filter((f) => f.includes("not attributed"))).toEqual(["4 settled records have no recognized model identifier and are not attributed to any model."]);
    expect(rec?.facts).toContain("model-alpha: 20 records (50% of attributed settled records).");
    expect(rec?.facts).toContain("model-beta: 20 records (50% of attributed settled records).");
    expect(rec?.evidence.metrics).toContainEqual({ name: "unattributedRecords", value: 4 });
  });

  it("redacts unrecognized names in the models API by merging them into one row, preserving totals", async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => event(i, { model: "model-alpha", input: 3 })),
      event(20, { model: "home/x/CANARY_PATH_9c1d", input: 5 }),
      event(21, { model: "other bad name", input: 7 }),
      event(22, { model: null, input: 11 }),
    ];
    const { dbPath } = await usageDb(lines(...rows));
    const store = openStore(dbPath);
    const oracle = settledByModel(store.db);
    store.close();

    const result = createAnalysis(dbPath).usageByModel(PAGE);
    const items = result.data?.items ?? [];
    expect(items.map((i) => i.key)).toEqual(["model-alpha", "(unrecognized model name)", null]);
    expect(items[1]).toMatchObject({ records: 2, tokens: { inputTokens: 12 } });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|home\/x|other bad name/);
    expect(items.reduce((n, i) => n + i.records, 0)).toBe(oracle.reduce((n, g) => n + g.records, 0));
    expect(items.reduce((n, i) => n + i.tokens.inputTokens, 0)).toBe(oracle.reduce((n, g) => n + g.tokens.inputTokens, 0));
    expect(result.data?.total).toBe(3);
  });
});

describe("Fix B/H: both paths canonicalize recognized identifiers identically", () => {
  const rowsFor = (names: readonly (string | null)[], each = 4) => lines(...names.flatMap((model, n) => Array.from({ length: each }, (_, i) => event(n * 100 + i, { model: model as string, input: 3 }))));

  it("aggregates case variants into one canonical row in the models API, with totals unchanged", async () => {
    const { dbPath } = await usageDb(rowsFor(["Model-A", "model-a", "MODEL-A", "model-b"]));
    const store = openStore(dbPath);
    const oracle = settledByModel(store.db);
    store.close();

    const items = createAnalysis(dbPath).usageByModel(PAGE).data?.items ?? [];
    expect(items.map((i) => [i.key, i.records, i.tokens.inputTokens])).toEqual([["model-a", 12, 36], ["model-b", 4, 12]]);
    expect(oracle).toHaveLength(4); // the core keeps the raw case variants apart; canonicalization is a presentation step
    expect(items.reduce((n, i) => n + i.records, 0)).toBe(oracle.reduce((n, g) => n + g.records, 0));
    expect(items.reduce((n, i) => n + i.tokens.inputTokens, 0)).toBe(oracle.reduce((n, g) => n + g.tokens.inputTokens, 0));
  });

  it("agrees with the recommendation on the same data", async () => {
    const { dbPath } = await usageDb(rowsFor(["Model-A", "model-a", "MODEL-A", "model-b"], 10));
    const analysis = createAnalysis(dbPath);
    const api = analysis.usageByModel(PAGE).data?.items ?? [];
    const rec = analysis.recommendations(ALL).data?.items.find((r) => r.id === "REC-USE-MODELS");
    for (const row of api) expect(rec?.facts.some((f) => f.startsWith(`${row.key}: ${row.records} records`))).toBe(true);
    expect(rec?.evidence.metrics).toContainEqual({ name: "distinctModels", value: api.length });
  });

  it("keeps legitimate gateway, Vertex and context-suffix identifiers as models, not placeholders", async () => {
    const names = ["claude-3-5-sonnet-v2@20241022", "anthropic/claude-sonnet-4.5", "claude-sonnet-4-5[1m]"];
    const { dbPath } = await usageDb(rowsFor(names, 12));
    const analysis = createAnalysis(dbPath);

    expect(analysis.usageByModel(PAGE).data?.items.map((i) => i.key)).toEqual(["anthropic/claude-sonnet-4.5", "claude-3-5-sonnet-v2@20241022", "claude-sonnet-4-5[1m]"]);
    const rec = analysis.recommendations(ALL).data?.items.find((r) => r.id === "REC-USE-MODELS");
    expect(rec?.evidence.metrics).toContainEqual({ name: "distinctModels", value: 3 });
    expect(rec?.evidence.metrics).toContainEqual({ name: "unattributedRecords", value: 0 });
  });

  it("still merges hostile lookalikes into one placeholder and never echoes them", async () => {
    const hostile = ["home/someone/CANARY_PATH_9c1d", "user@example.com", "claude[<b>x</b>]", "anthropic/../etc", "tab\tname", "<synthetic>"];
    const { dbPath } = await usageDb(rowsFor(["model-a", ...hostile], 3));
    const result = createAnalysis(dbPath).usageByModel(PAGE);
    expect(result.data?.items.map((i) => [i.key, i.records])).toEqual([["model-a", 3], ["(unrecognized model name)", 18]]);
    expect(JSON.stringify(result)).not.toMatch(/CANARY|example\.com|<b>|etc|synthetic/);
  });

  it("orders ties and rows by code unit, so model-1 precedes model_1 in the API as well", async () => {
    const { dbPath } = await usageDb(rowsFor(["model_1", "model-1", "Model-2"], 5));
    expect(createAnalysis(dbPath).usageByModel(PAGE).data?.items.map((i) => i.key)).toEqual(["model-1", "model-2", "model_1"]);
  });
});

describe("Fix C: distinct permission rules are not summed across overlapping findings", () => {
  async function configDb(user: object, project: object) {
    const base = tempDir();
    const { store, dbPath } = freshStore(base);
    writeTree(join(base, "u"), { "settings.json": JSON.stringify(user) });
    writeTree(join(base, "p"), { ".claude/settings.json": JSON.stringify(project) });
    saveConfigInventory(store, await scan([userRoot(join(base, "u")), projectRoot(join(base, "p"))]));
    store.close();
    return dbPath;
  }
  const perms = (allow: string[], deny: string[]) => ({ permissions: { allow, deny } });
  const X = "Bash(CANARY_PERM_RULE_88b1:*)";
  const Y = "Bash(CANARY_PERM_RULE_other:*)";

  it("counts one distinct rule once when the same text is in both lists of two files", async () => {
    const dbPath = await configDb(perms([X], [X]), perms([X], [X]));
    const analysis = createAnalysis(dbPath);
    const findings = analysis.configFindings({ severity: null, ruleId: "CFG-CONF-002", limit: 50, offset: 0 }).data?.items ?? [];
    const rec = recOf(dbPath, "REC-CFG-CONFLICT:permissions");

    expect(findings).toHaveLength(4);
    expect(findings.map((f) => f.evidence.overlappingRules)).toEqual([1, 1, 1, 1]);
    expect(findings.every((f) => f.evidence.distinctRules === 1 && f.ruleVersion === 2)).toBe(true);
    expect(rec?.facts[0]).toContain("1 distinct permission rule appears in both an allow list and a deny list, reported by 4 findings");
    expect(rec?.evidence.metrics).toEqual([{ name: "findingCount", value: 4 }, { name: "distinctOverlappingRules", value: 1 }]);
    expect([...(rec?.evidence.findingIds ?? [])].sort()).toEqual(findings.map((f) => f.id).sort());
  });

  it("counts distinct rules across files without summing per-pair overlaps, and exposes no permission text", async () => {
    const dbPath = await configDb(perms([X, Y], [X]), perms([X], [X, Y]));
    const findings = createAnalysis(dbPath).configFindings({ severity: null, ruleId: "CFG-CONF-002", limit: 50, offset: 0 }).data?.items ?? [];
    const rec = recOf(dbPath, "REC-CFG-CONFLICT:permissions");

    expect(findings.reduce((n, f) => n + Number(f.evidence.overlappingRules), 0)).toBe(5);
    expect(rec?.evidence.metrics).toContainEqual({ name: "distinctOverlappingRules", value: 2 });
    expect(rec?.facts[0]).toContain("2 distinct permission rules appear");
    const everything = JSON.stringify([findings, createAnalysis(dbPath).recommendations(ALL)]);
    expect(everything).not.toMatch(/CANARY_PERM_RULE|Bash\(/);
  });

  it("takes the scan-wide union when distinct rules occur in disjoint file pairs (a per-finding maximum would give 1)", async () => {
    const base = tempDir();
    const { store, dbPath } = freshStore(base);
    // File A allows X; file B denies X and allows Y; file C denies Y. Overlaps: (A,B) -> X and (B,C) -> Y, one rule each.
    writeTree(join(base, "u"), { "settings.json": JSON.stringify({ permissions: { allow: [X] } }) });
    writeTree(join(base, "p"), {
      ".claude/settings.json": JSON.stringify({ permissions: { deny: [X], allow: [Y] } }),
      ".claude/settings.local.json": JSON.stringify({ permissions: { deny: [Y] } }),
    });
    saveConfigInventory(store, await scan([userRoot(join(base, "u")), projectRoot(join(base, "p"))]));
    store.close();

    const analysis = createAnalysis(dbPath);
    const findings = analysis.configFindings({ severity: null, ruleId: "CFG-CONF-002", limit: 50, offset: 0 }).data?.items ?? [];
    const rec = recOf(dbPath, "REC-CFG-CONFLICT:permissions");

    expect(findings.map((f) => f.evidence.overlappingRules)).toEqual([1, 1]);
    expect(findings.map((f) => f.evidence.distinctRules)).toEqual([2, 2]);
    expect(findings.every((f) => f.evidence.sameFile === false)).toBe(true);
    expect(rec?.evidence.metrics).toEqual([{ name: "findingCount", value: 2 }, { name: "distinctOverlappingRules", value: 2 }]);
    expect(rec?.facts[0]).toContain("2 distinct permission rules appear");
    const everything = JSON.stringify([findings, analysis.recommendations(ALL)]);
    expect(everything).not.toMatch(/CANARY_PERM_RULE|Bash\(/);
    expect(everything).not.toMatch(/[0-9a-f]{32,}/); // no rule hash or any long digest is returned
  });

  it("identifies a rule by its exact string: whitespace and case variants are different rules", async () => {
    const dbPath = await configDb(perms([X], [` ${X} `]), perms([X.toUpperCase()], [X]));
    const rec = recOf(dbPath, "REC-CFG-CONFLICT:permissions");
    // Only the exact-string match between user allow X and project deny X overlaps.
    expect(rec?.evidence.metrics).toContainEqual({ name: "distinctOverlappingRules", value: 1 });
    expect(rec?.limitations.join(" ")).toMatch(/exact string/);
  });

  it("reports a lower bound for findings that predate the distinct count", async () => {
    const dbPath = await configDb(perms([X], [X]), perms([X], [X]));
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE config_findings SET rule_version = 1, evidence_json = json_remove(evidence_json, '$.distinctRules') WHERE rule_id = 'CFG-CONF-002'`);
    raw.close();

    const rec = recOf(dbPath, "REC-CFG-CONFLICT:permissions");
    expect(rec?.facts[0]).toMatch(/^At least 1 distinct permission rule appears/);
    expect(rec?.evidence.metrics).toContainEqual({ name: "distinctOverlappingRulesAtLeast", value: 1 });
  });
});

describe("Fix E: identity uncertainty is settled by stored record-level evidence", () => {
  const ANON = event(900, { id: null, model: "model-alpha", input: 3 });
  const ANON_ABOVE = event(901, { id: null, input: 4 });
  const base = (n = 4) => Array.from({ length: n }, (_, i) => event(i, { model: "model-alpha" }));
  const anonymousRows = (store: { db: Parameters<typeof identityUncertainSourceCount>[0] }) =>
    (store.db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE identity_kind = 'none'").get() as { n: number }).n;

  async function sourcesDb() {
    const dir = tempDir();
    const { store, dbPath } = freshStore(dir);
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, lines(...base(), ANON));
    write(b, lines(...base(3).map((_, i) => event(500 + i, { model: "model-beta" }))));
    await scanAndIngest(store, [a, b]);
    return { store, dbPath, a, b, dir };
  }
  const uncertain = (store: { db: Parameters<typeof identityUncertainSourceCount>[0] }) => identityUncertainSourceCount(store.db);
  // The anonymous event is also an ambiguous record, so the recommendation stays; its identity metric tracks uncertainty.
  const identityMetric = (dbPath: string) => recOf(dbPath, "REC-DQ-ACCOUNTING")?.evidence.metrics.find((m) => m.name === "identityUncertainSources")?.value;
  /** Makes source `a` uncertain: a line is inserted above its anonymous record. */
  async function makeUncertain(ctx: Awaited<ReturnType<typeof sourcesDb>>) {
    write(ctx.a, lines(ANON_ABOVE, ...base(), ANON));
    const result = await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    expect(result.sources[0]).toMatchObject({ outcome: "modified", anonymousIdentityUncertain: true });
  }

  it("is not uncertain after first reads, even though anonymous records are stored", async () => {
    const ctx = await sourcesDb();
    expect(anonymousRows(ctx.store)).toBe(1);
    expect(uncertain(ctx.store)).toBe(0);
    ctx.store.close();
  });

  it("1. stays uncertain after an identity-bearing append while anonymous rows remain", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    expect(uncertain(ctx.store)).toBe(1);

    appendFileSync(ctx.a, `${event(950, { model: "model-alpha" })}\n`);
    const result = await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    expect(result.sources[0]?.outcome).toBe("appended");
    expect(anonymousRows(ctx.store)).toBe(2);
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.close();
  });

  it("2. stays uncertain after an append that adds no anonymous rows and reconciles none", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    const before = anonymousRows(ctx.store);

    appendFileSync(ctx.a, `${JSON.stringify({ type: "user", uuid: "u-extra", sessionId: "s", timestamp: "2026-03-01T10:00:00.000Z", message: { role: "user", content: "x" } })}\n`);
    const result = await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    expect(result.sources[0]?.outcome).toBe("appended");
    expect(anonymousRows(ctx.store)).toBe(before);
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.close();
  });

  it("3. stays uncertain after a rewrite in which anonymous records remain", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    write(ctx.a, lines(...base(2), ANON));
    const result = await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    expect(result.sources[0]).toMatchObject({ outcome: "modified", anonymousIdentityUncertain: true });
    expect(anonymousRows(ctx.store)).toBe(1);
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.close();
  });

  it("4. is resolved only when the stored records contain no anonymous record at all", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    write(ctx.a, lines(...base(3))); // every anonymous line is gone
    const result = await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    // The read is still flagged (the old version had anonymous records), so the flag proves nothing; the rows do.
    expect(result.sources[0]).toMatchObject({ outcome: "modified", anonymousIdentityUncertain: true });
    expect(anonymousRows(ctx.store)).toBe(0);
    expect(uncertain(ctx.store)).toBe(0);
    expect(identityMetric(ctx.dbPath)).toBeUndefined(); // no unresolved usage left, so the recommendation is gone too
    ctx.store.close();
  });

  it("does not treat an unflagged source that merely holds anonymous records as uncertain", async () => {
    const dir = tempDir();
    const { store } = freshStore(dir);
    const a = join(dir, "a.jsonl");
    write(a, lines(...base(), ANON));
    await scanAndIngest(store, [a]);
    appendFileSync(a, `${event(951, { id: null, input: 8 })}\n`);
    await scanAndIngest(store, [a]);
    expect(anonymousRows(store)).toBe(2);
    expect(uncertain(store)).toBe(0);
    store.close();
  });

  it("5. keeps the uncertainty through failed and unchanged reads", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    const missing = join(ctx.dir, "missing.jsonl");

    const unchanged = await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    expect(unchanged.sources.map((s) => s.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(uncertain(ctx.store)).toBe(1);
    await scanAndIngest(ctx.store, [missing]); // a source that cannot be read
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.db.exec("INSERT INTO scan_runs (started_at, status, error_code) VALUES ('2026-06-01T00:00:00.000Z', 'failed', 'SOURCE_FAILED')");
    expect(uncertain(ctx.store)).toBe(1);
    expect(anonymousRows(ctx.store)).toBe(2);
    expect(identityMetric(ctx.dbPath)).toBe(1);
    ctx.store.close();
  });

  it("6. counts a successful modified read in a partial scan, and ignores the failed source beside it", async () => {
    const ctx = await sourcesDb();
    write(ctx.a, lines(ANON_ABOVE, ...base(), ANON));
    const missing = join(ctx.dir, "gone.jsonl");
    const result = await scanAndIngest(ctx.store, [ctx.a, missing]);

    expect(result.sources.map((s) => s.outcome)).toEqual(["modified", "failed"]);
    expect((ctx.store.db.prepare("SELECT status FROM scan_runs ORDER BY id DESC LIMIT 1").get() as { status: string }).status).toBe("partial");
    expect(uncertain(ctx.store)).toBe(1);

    await scanAndIngest(ctx.store, [missing, ctx.b]); // another partial scan: a failed read and an unchanged one
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.close();
  });

  it("7. judges each source on its own: changes to an unrelated source neither create nor clear it", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);

    write(ctx.b, lines(event(702, { id: null, input: 9 }), event(501, { model: "model-beta" })));
    await scanAndIngest(ctx.store, [ctx.b]); // b alone gains anonymous records through a rewrite
    expect(uncertain(ctx.store)).toBe(2);

    write(ctx.b, lines(event(501, { model: "model-beta" })));
    await scanAndIngest(ctx.store, [ctx.b]); // b loses them: resolved by its own records
    expect(uncertain(ctx.store)).toBe(1); // a is untouched
    appendFileSync(ctx.b, `${event(502, { model: "model-beta" })}\n`);
    await scanAndIngest(ctx.store, [ctx.b]);
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.close();
  });

  it("requires the rewrite flag as well as stored anonymous rows (rows alone are not enough)", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    expect(uncertain(ctx.store)).toBe(1);
    // Ingest never writes this combination; it is built directly to show that the flag is part of the evidence.
    ctx.store.db.exec("UPDATE source_scan_results SET anonymous_identity_uncertain = 0");
    expect(anonymousRows(ctx.store)).toBe(2);
    expect(uncertain(ctx.store)).toBe(0);
    ctx.store.close();
  });

  it("ignores result rows that belong to a failed or unfinished scan run", async () => {
    const ctx = await sourcesDb();
    expect(anonymousRows(ctx.store)).toBe(1); // source a stores an anonymous record, unflagged
    const sourceId = (ctx.store.db.prepare("SELECT id FROM source_files ORDER BY id LIMIT 1").get() as { id: number }).id;
    for (const status of ["failed", "running"]) {
      ctx.store.db.exec(`INSERT INTO scan_runs (started_at, status) VALUES ('2026-06-01T00:00:00.000Z', '${status}')`);
      const runId = (ctx.store.db.prepare("SELECT MAX(id) AS id FROM scan_runs").get() as { id: number }).id;
      ctx.store.db.exec(`INSERT INTO source_scan_results (scan_run_id, source_file_id, outcome, anonymous_identity_uncertain) VALUES (${runId}, ${sourceId}, 'modified', 1)`);
    }
    expect(uncertain(ctx.store)).toBe(0);
    ctx.store.close();
  });

  it("documents the conservative limit: resolved, then new anonymous records via append, is reported uncertain again", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    write(ctx.a, lines(...base(3)));
    await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    expect(uncertain(ctx.store)).toBe(0);

    appendFileSync(ctx.a, `${event(960, { id: null, input: 6 })}\n`);
    await scanAndIngest(ctx.store, [ctx.a, ctx.b]);
    // Over-reporting by design: the schema keeps no per-read anonymous count, so a safe distinction is impossible.
    expect(uncertain(ctx.store)).toBe(1);
    ctx.store.close();
  });

  it("gives the Data Quality API and the recommendation the same figure, with the per-run figure separate", async () => {
    const ctx = await sourcesDb();
    await makeUncertain(ctx);
    await scanAndIngest(ctx.store, [join(ctx.dir, "missing.jsonl")]);
    ctx.store.close();

    const quality = createAnalysis(ctx.dbPath).usageQuality().data;
    expect(quality?.identityUncertainSources).toBe(1);
    expect(quality?.latestScan?.anonymousIdentityUncertainSources).toBe(0);
    expect(identityMetric(ctx.dbPath)).toBe(quality?.identityUncertainSources);
  });
});

describe("Fix F: sidechain scope", () => {
  async function sidechainDb() {
    const rows = Array.from({ length: 40 }, (_, i) => event(i, { model: i % 3 === 0 ? "model-beta" : "model-alpha", side: i % 3 === 0 }));
    return usageDb(lines(...rows));
  }

  it("includes sidechain events, states so, and cites the sidechain record count matching the Usage page's two modes", async () => {
    const { dbPath } = await sidechainDb();
    const analysis = createAnalysis(dbPath);
    const include = analysis.usageSummary({ sidechain: "include" }).data?.settled.records ?? 0;
    const exclude = analysis.usageSummary({ sidechain: "exclude" }).data?.settled.records ?? 0;
    const rec = recOf(dbPath, "REC-USE-MODELS");

    expect(include).toBe(40);
    expect(exclude).toBe(26);
    expect(rec?.facts[0]).toBe("Scope: all settled events, sidechain (sub-agent) events included: 14 settled sidechain records are counted here, and 0 unresolved sidechain records are excluded with all other unresolved events. The Usage page's sidechain filter does not apply.");
    expect(rec?.evidence.metrics).toContainEqual({ name: "unresolvedSidechainRecords", value: 0 });
    expect(rec?.evidence.metrics).toContainEqual({ name: "settledSidechainRecords", value: include - exclude });
    expect(rec?.evidence.metrics).toContainEqual({ name: "settledRecords", value: include });
    expect(rec?.facts).toContain("model-beta: 14 records (35% of attributed settled records).");
  });

  it("labels the scope on the accounting recommendation too", async () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => event(i, { side: i < 2 })), event(100, { id: "m", input: 1 }), event(101, { id: "m", input: 2 })];
    const { dbPath } = await usageDb(lines(...rows));
    const rec = recOf(dbPath, "REC-DQ-ACCOUNTING");
    expect(rec?.facts[0]).toBe("Scope: all events, with sidechain (sub-agent) events included.");
    expect(rec?.facts[1]).toBe("Sidechain records by state: 2 settled, 0 in conflicting groups, 0 ambiguous (records with an unknown sidechain flag are not counted as sidechain).");
    expect(rec?.evidence.metrics).toContainEqual({ name: "settledSidechainRecords", value: 2 });
  });

  it("never reports a settled-only count as the sidechain total when every sidechain event is unresolved", async () => {
    // Settled events: none are sidechain. Unresolved events: a conflicting group of 3 and 2 anonymous records, all sidechain.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => event(i, { side: false })),
      ...[1, 2, 3].map((n) => event(100 + n, { id: "msg_side_conflict", input: n, side: true })),
      event(200, { id: null, input: 5, side: true }),
      event(201, { id: null, input: 6, side: true }),
    ];
    const { dbPath } = await usageDb(lines(...rows));
    const analysis = createAnalysis(dbPath);
    const rec = recOf(dbPath, "REC-DQ-ACCOUNTING");
    const metric = (name: string) => rec?.evidence.metrics.find((m) => m.name === name)?.value;

    expect(analysis.usageSummary({ sidechain: "include" }).data?.settled.records).toBe(4);
    expect(analysis.usageSummary({ sidechain: "exclude" }).data?.settled.records).toBe(4); // settled sidechain: none
    expect(rec?.facts[1]).toBe("Sidechain records by state: 0 settled, 3 in conflicting groups, 2 ambiguous (records with an unknown sidechain flag are not counted as sidechain).");
    expect(rec?.facts.join(" ")).not.toMatch(/including 0 sidechain|all events, including/);
    expect([metric("settledSidechainRecords"), metric("conflictingSidechainRecords"), metric("ambiguousSidechainRecords")]).toEqual([0, 3, 2]);
  });

  it("counts sidechain records of every unresolved kind in the model observation's exclusion note", async () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => event(i, { model: i % 2 ? "model-beta" : "model-alpha", side: i % 5 === 0 })),
      event(300, { id: "x", input: 1, side: true }),
      event(301, { id: "x", input: 2, side: true }),
    ];
    const { dbPath } = await usageDb(lines(...rows));
    const rec = recOf(dbPath, "REC-USE-MODELS");
    expect(rec?.facts[0]).toBe("Scope: all settled events, sidechain (sub-agent) events included: 8 settled sidechain records are counted here, and 2 unresolved sidechain records are excluded with all other unresolved events. The Usage page's sidechain filter does not apply.");
    expect(rec?.evidence.metrics).toContainEqual({ name: "unresolvedSidechainRecords", value: 2 });
  });
});

describe("Fix D through the service", () => {
  async function tree(files: Record<string, string>) {
    const base = tempDir();
    const { store, dbPath } = freshStore(base);
    writeTree(join(base, "p"), files);
    saveConfigInventory(store, await scan([projectRoot(join(base, "p"))]));
    store.close();
    return dbPath;
  }

  it("describes an inventory of only unverified candidates, which has no CFG-ACT-001 findings", async () => {
    const dbPath = await tree({ "CLAUDE.md": "Notes.\n", ".claude/CLAUDE.md": "More notes.\n" });
    const rec = recOf(dbPath, "REC-CFG-ACTIVATION");
    expect(createAnalysis(dbPath).configFindings({ severity: null, ruleId: "CFG-ACT-001", limit: 5, offset: 0 }).data?.total).toBe(0);
    expect(rec?.facts[0]).toBe("2 items were inventoried on disk (2 unverified candidate).");
    expect(rec?.evidence.findingIds).toEqual([]);
  });

  it("covers mixed inventories, citing the findings that exist", async () => {
    const dbPath = await tree({ "CLAUDE.md": "Notes.\n", ".claude/agents/x.md": "---\nname: x\ndescription: d\n---\nbody\n" });
    const rec = recOf(dbPath, "REC-CFG-ACTIVATION");
    expect(rec?.facts[0]).toBe("2 items were inventoried on disk (1 unverified candidate, 1 on-demand).");
    expect(rec?.evidence.findingIds).toHaveLength(1);
  });

  it("stays silent for a completed scan with nothing inventoried", async () => {
    const dbPath = await tree({ "unrelated.txt": "x" });
    const page = createAnalysis(dbPath).recommendations(ALL).data;
    expect(page?.items.find((r) => r.id === "REC-CFG-ACTIVATION")).toBeUndefined();
    expect(page?.rules.find((r) => r.ruleId === "REC-CFG-ACTIVATION")).toMatchObject({ outcome: "not-triggered", reason: "no-inventoried-items" });
  });
});
