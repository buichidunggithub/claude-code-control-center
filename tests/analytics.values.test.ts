import { describe, expect, it } from "vitest";
import { createAnalysis, type Analysis } from "@/core/analysis";
import { parseJsonlFiles, summarizeAccounting, TEXT_LENGTH_STATES, TOOL_BUCKETS } from "@/core/parse";
import { BASIC_FIXTURE, factsDatabase, jsonLines, sessionRef, withRawDatabase } from "./analytics-helpers";
import { footprint } from "./analysis-helpers";
import { registerTempStoreCleanup } from "./store-helpers";

registerTempStoreCleanup();

const ALL = { limit: 200, offset: 0 } as const;
const RANGE = { ...ALL, from: null, to: null } as const;

const data = <T,>(envelope: { state: string; data: T | null }): T => {
  expect(envelope.state).toBe("ok");
  if (envelope.data === null) throw new Error("expected data");
  return envelope.data;
};

const sizes = (overrides: Partial<Record<(typeof TEXT_LENGTH_STATES)[number], number>>) => ({
  ...Object.fromEntries(TEXT_LENGTH_STATES.map((s) => [s, 0])),
  ...overrides,
});

describe("summary", () => {
  it("counts source-typed user events, keeping every size state distinct", async () => {
    const { dbPath } = await factsDatabase({ basic: false });
    const summary = data(createAnalysis(dbPath).analyticsSummary());

    expect(summary.state).toBe("collected");
    expect(summary.userEvents).toEqual({
      total: 12,
      bySidechain: { sidechain: 1, main: 0, unknown: 11 },
      sizeStates: sizes({ empty: 1, xs: 4, s: 1, unsupported: 6 }),
      undated: 0,
    });
  });

  it("keeps `not-read` apart from `empty` and `unsupported` when the opt-in was off", async () => {
    const { dbPath } = await factsDatabase({ optIn: false, basic: false });
    const summary = data(createAnalysis(dbPath).analyticsSummary());
    expect(summary.userEvents?.sizeStates).toEqual(sizes({ "not-read": 12 }));
  });

  it("counts every tool occurrence and, separately, the deduplicated kept calls", async () => {
    const { dbPath } = await factsDatabase({ basic: false });
    const { toolCalls } = data(createAnalysis(dbPath).analyticsSummary());

    expect(toolCalls).toEqual({
      occurrences: 11,
      kept: 9,
      duplicates: 2,
      anonymous: 1,
      groupSizes: { "1": 6, "2": 2, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0, "10+": 0 },
    });
    // The persisted rows are the ground truth.
    const truth = withRawDatabase(dbPath, (db) => db.prepare("SELECT COUNT(*) AS n, SUM(dedup = 'kept') AS k FROM tool_calls").get());
    expect(truth).toEqual({ n: 11, k: 9 });
  });

  it("reports coverage and carries the unverified label", async () => {
    const { dbPath } = await factsDatabase();
    const summary = data(createAnalysis(dbPath).analyticsSummary());
    expect(summary.validation).toBe("unverified-source-structure");
    expect(summary.note).toMatch(/not yet validated against real Claude Code transcripts/);
    expect(summary.note).toMatch(/not a verified prompt or turn/);
    expect(summary.coverage).toEqual({ currentFactsVersion: 1, sources: 3, collected: 3, outdated: 0, notCollected: 0, complete: true });
  });
});

describe("coverage and empty states", () => {
  it("reports no figures, not zeros, when no source has facts collected", async () => {
    const { dbPath } = await factsDatabase();
    withRawDatabase(dbPath, (db) => db.exec("UPDATE source_files SET facts_version = 0; DELETE FROM tool_calls; DELETE FROM source_user_events;"));
    const analysis = createAnalysis(dbPath);

    const summary = data(analysis.analyticsSummary());
    expect(summary).toMatchObject({ state: "none-collected", userEvents: null, toolCalls: null });
    expect(summary.coverage).toEqual({ currentFactsVersion: 1, sources: 3, collected: 0, outdated: 0, notCollected: 3, complete: false });
    expect(data(analysis.analyticsTools())).toMatchObject({ state: "none-collected", toolCalls: null });
    expect(data(analysis.analyticsTrends(RANGE))).toMatchObject({ state: "none-collected", total: 0, items: [], undated: null });
    expect(data(analysis.analyticsSessions(ALL))).toMatchObject({ state: "none-collected", total: 0, items: [] });
    expect(data(analysis.analyticsSessionDetail({ id: "0".repeat(16), ...ALL }))).toMatchObject({ state: "none-collected", session: null, sizeStates: null, toolBuckets: null, days: [] });
  });

  it("covers only collected sources and says so when coverage is partial", async () => {
    const { dbPath } = await factsDatabase({ basic: false });
    withRawDatabase(dbPath, (db) => {
      db.exec("UPDATE source_files SET facts_version = 0 WHERE id = (SELECT MAX(id) FROM source_files)");
      db.exec("DELETE FROM tool_calls WHERE source_file_id = (SELECT MAX(id) FROM source_files)");
      db.exec("DELETE FROM source_user_events WHERE source_file_id = (SELECT MAX(id) FROM source_files)");
    });
    const summary = data(createAnalysis(dbPath).analyticsSummary());

    expect(summary.state).toBe("collected");
    expect(summary.coverage).toMatchObject({ sources: 2, collected: 1, notCollected: 1, complete: false });
    expect(summary.userEvents?.total).toBe(11);
  });

  it("counts a collected source with no events as a real zero", async () => {
    const quiet = jsonLines({ type: "assistant", message: { id: "m", usage: { input_tokens: 1 } } });
    const { dbPath } = await factsDatabase({ extra: [["quiet.jsonl", quiet]] });
    withRawDatabase(dbPath, (db) => db.exec("DELETE FROM source_files WHERE id <> (SELECT MAX(id) FROM source_files)"));
    const summary = data(createAnalysis(dbPath).analyticsSummary());

    expect(summary.state).toBe("collected");
    expect(summary.userEvents).toEqual({ total: 0, bySidechain: { sidechain: 0, main: 0, unknown: 0 }, sizeStates: sizes({}), undated: 0 });
    expect(summary.toolCalls).toMatchObject({ occurrences: 0, kept: 0, duplicates: 0, anonymous: 0 });
    expect(summary.coverage).toMatchObject({ sources: 1, collected: 1, complete: true });
  });

  it("reports an empty database with a completed scan as having no sources and no completeness claim", async () => {
    const { dbPath } = await factsDatabase({ basic: false });
    withRawDatabase(dbPath, (db) => db.exec("DELETE FROM source_files"));
    const summary = data(createAnalysis(dbPath).analyticsSummary());
    expect(summary).toMatchObject({ state: "none-collected", userEvents: null });
    expect(summary.coverage).toMatchObject({ sources: 0, collected: 0, complete: null });
  });
});

describe("trends by UTC day", () => {
  it("lists days newest first with per-day figures and a size state per event", async () => {
    const { dbPath } = await factsDatabase();
    const trends = data(createAnalysis(dbPath).analyticsTrends(RANGE));

    expect(trends.total).toBe(2);
    expect(trends.items.map((d) => d.day)).toEqual(["2026-04-01", "2026-01-10"]);
    expect(trends.items[1]).toEqual({
      day: "2026-01-10",
      userEvents: 2,
      userEventsBySidechain: { sidechain: 0, main: 0, unknown: 2 },
      sizeStates: sizes({ xs: 1, unsupported: 1 }),
      toolOccurrences: 3,
      toolKept: 2,
      toolDuplicates: 1,
    });
    expect(trends.items[0]).toMatchObject({ userEvents: 12, toolOccurrences: 11, toolKept: 9, toolDuplicates: 2 });
    expect(trends.undated).toBeNull();
  });

  it("filters by inclusive range, pages deterministically and keeps undated facts out of the range", async () => {
    const undated = jsonLines({ type: "user", sessionId: "s-undated", message: { content: "x" } });
    const { dbPath } = await factsDatabase({ extra: [["undated.jsonl", undated]] });
    const analysis = createAnalysis(dbPath);

    expect(data(analysis.analyticsTrends({ ...RANGE, from: "2026-02-01" })).items.map((d) => d.day)).toEqual(["2026-04-01"]);
    expect(data(analysis.analyticsTrends({ ...RANGE, to: "2026-01-10" })).items.map((d) => d.day)).toEqual(["2026-01-10"]);
    const second = data(analysis.analyticsTrends({ ...RANGE, limit: 1, offset: 1 }));
    expect(second).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(second.items.map((d) => d.day)).toEqual(["2026-01-10"]);
    expect(data(analysis.analyticsTrends({ ...RANGE, limit: 1, offset: 5 })).items).toEqual([]);

    const narrowed = data(analysis.analyticsTrends({ ...RANGE, from: "2030-01-01" }));
    expect(narrowed.items).toEqual([]);
    expect(narrowed.undated).toMatchObject({ userEvents: 1, sizeStates: sizes({ xs: 1 }) });
  });
});

describe("tools", () => {
  it("has one row per bucket in a fixed order, matching the persisted rows", async () => {
    const { dbPath } = await factsDatabase({ basic: false });
    const tools = data(createAnalysis(dbPath).analyticsTools()).toolCalls;
    expect(tools?.byBucket.map((r) => r.bucket)).toEqual([...TOOL_BUCKETS]);

    const byBucket = Object.fromEntries((tools?.byBucket ?? []).map((r) => [r.bucket, r]));
    expect(byBucket["Read"]).toEqual({ bucket: "Read", occurrences: 1, kept: 1, duplicates: 0 });
    expect(byBucket["Grep"]).toEqual({ bucket: "Grep", occurrences: 1, kept: 0, duplicates: 1 });
    expect(byBucket["Edit"]).toEqual({ bucket: "Edit", occurrences: 1, kept: 1, duplicates: 0 });
    expect(byBucket["other"]).toEqual({ bucket: "other", occurrences: 3, kept: 3, duplicates: 0 });
    expect(byBucket["unknown"]).toEqual({ bucket: "unknown", occurrences: 2, kept: 2, duplicates: 0 });
    expect(byBucket["WebFetch"]).toEqual({ bucket: "WebFetch", occurrences: 0, kept: 0, duplicates: 0 });
    // `toolu_f7` is shared by a Bash and a Glob occurrence; which one is kept depends on the database, not the total.
    expect((byBucket["Bash"]?.kept ?? 0) + (byBucket["Glob"]?.kept ?? 0)).toBe(1);

    const rows = withRawDatabase(dbPath, (db) => db.prepare("SELECT tool_bucket AS b, COUNT(*) AS n, SUM(dedup = 'kept') AS k FROM tool_calls GROUP BY tool_bucket").all());
    for (const row of rows) expect(byBucket[row["b"] as string]).toMatchObject({ occurrences: row["n"], kept: row["k"] });
    expect(tools?.occurrences).toBe((tools?.byBucket ?? []).reduce((n, r) => n + r.occurrences, 0));
    expect(tools?.kept).toBe((tools?.byBucket ?? []).reduce((n, r) => n + r.kept, 0));
  });
});

describe("sessions", () => {
  it("lists opaque references, most recent activity first, with a bounded deterministic page", async () => {
    const { dbPath, salt } = await factsDatabase();
    const analysis = createAnalysis(dbPath);
    const all = data(analysis.analyticsSessions(ALL));

    expect(all.total).toBe(2);
    expect(all.items.map((s) => s.id)).toEqual([sessionRef(salt, "sess-F"), sessionRef(salt, "sess-A")]);
    expect(all.items[0]).toEqual({
      id: sessionRef(salt, "sess-F"), userEvents: 12, toolOccurrences: 11, toolKept: 9,
      firstTimestamp: "2026-04-01T00:00:01.000Z", lastTimestamp: "2026-04-01T00:00:13.000Z",
    });
    for (const item of all.items) expect(item.id).toMatch(/^[0-9a-f]{16}$/);

    const pages = [0, 1, 2].map((offset) => data(analysis.analyticsSessions({ limit: 1, offset })).items.map((s) => s.id));
    expect(pages).toEqual([[all.items[0]?.id], [all.items[1]?.id], []]);
    expect(data(analysis.analyticsSessions({ limit: 1, offset: 0 })).items).toEqual(data(analysis.analyticsSessions({ limit: 1, offset: 0 })).items);
  });

  it("pages through many sessions without gaps or repeats, never beyond the limit", async () => {
    const many = jsonLines(...Array.from({ length: 30 }, (_, i) => ({ type: "user", sessionId: `many-${i}`, timestamp: `2026-06-01T00:00:${String(i).padStart(2, "0")}.000Z`, message: { content: "x" } })));
    const { dbPath } = await factsDatabase({ basic: false, extra: [["many.jsonl", many]] });
    const analysis = createAnalysis(dbPath);
    const ids: (string | null)[] = [];
    for (let offset = 0; offset < 40; offset += 7) {
      const page = data(analysis.analyticsSessions({ limit: 7, offset }));
      expect(page.items.length).toBeLessThanOrEqual(7);
      ids.push(...page.items.map((s) => s.id));
    }
    expect(ids).toHaveLength(31);
    expect(new Set(ids).size).toBe(31);
    expect(ids).toEqual(data(analysis.analyticsSessions(ALL)).items.map((s) => s.id));
  });

  it("shows facts with no session id as one null-reference row", async () => {
    const anonymous = jsonLines({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "x" } });
    const { dbPath, salt } = await factsDatabase({ basic: false, extra: [["anon.jsonl", anonymous]] });
    const items = data(createAnalysis(dbPath).analyticsSessions(ALL)).items;
    // Ordered by recency like any other row: its facts are older than the other session's.
    expect(items.map((s) => s.id)).toEqual([sessionRef(salt, "sess-F"), null]);
    expect(items[1]).toMatchObject({ userEvents: 1, toolOccurrences: 0 });
  });

  it("describes one session by its reference, and treats unknown or ambiguous references as absent", async () => {
    const { dbPath, salt } = await factsDatabase();
    const analysis = createAnalysis(dbPath);
    const detail = data(analysis.analyticsSessionDetail({ id: sessionRef(salt, "sess-F"), ...ALL }));

    expect(detail.session).toMatchObject({ userEvents: 12, toolOccurrences: 11, toolKept: 9 });
    expect(detail.sizeStates).toEqual(sizes({ empty: 1, xs: 4, s: 1, unsupported: 6 }));
    expect(detail.toolBuckets?.map((r) => r.bucket)).toEqual([...TOOL_BUCKETS]);
    expect(detail.daysPage).toEqual({ limit: 200, offset: 0, total: 1 });
    expect(detail.days).toHaveLength(1);
    expect(detail.days[0]?.day).toBe("2026-04-01");

    const unknown = data(analysis.analyticsSessionDetail({ id: "f".repeat(16), ...ALL }));
    expect(unknown).toMatchObject({ session: null, sizeStates: null, toolBuckets: null, days: [] });

    const prefix = "abcdefabcdefabcd";
    withRawDatabase(dbPath, (db) => {
      const insert = db.prepare("INSERT INTO source_user_events (source_file_id, line_number, session_fp, size_state) VALUES (1, ?, ?, 'xs')");
      insert.run(900, `${prefix}${"1".repeat(48)}`);
      insert.run(901, `${prefix}${"2".repeat(48)}`);
    });
    expect(data(analysis.analyticsSessionDetail({ id: prefix, ...ALL })).session).toBeNull();
  });

  it("pages the days of a session", async () => {
    const days = jsonLines(...[1, 2, 3].map((d) => ({ type: "user", sessionId: "multi-day", timestamp: `2026-07-0${d}T00:00:00.000Z`, message: { content: "x" } })));
    const { dbPath, salt } = await factsDatabase({ basic: false, extra: [["days.jsonl", days]] });
    const analysis = createAnalysis(dbPath);
    const ref = sessionRef(salt, "multi-day");

    const first = data(analysis.analyticsSessionDetail({ id: ref, limit: 2, offset: 0 }));
    const second = data(analysis.analyticsSessionDetail({ id: ref, limit: 2, offset: 2 }));
    expect(first.daysPage.total).toBe(3);
    expect([...first.days, ...second.days].map((d) => d.day)).toEqual(["2026-07-03", "2026-07-02", "2026-07-01"]);
  });
});

describe("independence from usage accounting", () => {
  const usageViews = (analysis: Analysis) => ({
    summary: analysis.usageSummary({ sidechain: "include" }),
    excluded: analysis.usageSummary({ sidechain: "exclude" }),
    models: analysis.usageByModel({ sidechain: "include", ...ALL }),
    days: analysis.usageByDay({ sidechain: "include", ...RANGE }),
    sessions: analysis.usageSessions({ sidechain: "include", ...ALL }),
    quality: analysis.usageQuality(),
  });

  it("leaves every existing usage view unchanged by the presence, absence or content of facts", async () => {
    const { dbPath } = await factsDatabase();
    const withFacts = usageViews(createAnalysis(dbPath));
    withRawDatabase(dbPath, (db) => db.exec("UPDATE source_files SET facts_version = 0; DELETE FROM tool_calls; DELETE FROM source_user_events;"));
    expect(usageViews(createAnalysis(dbPath))).toEqual(withFacts);
  });

  it("keeps settled totals equal to the in-memory accounting", async () => {
    const { dbPath, a, b } = await factsDatabase();
    const expected = summarizeAccounting((await parseJsonlFiles([a, b, BASIC_FIXTURE])).usageRecords);
    expect(data(createAnalysis(dbPath).usageSummary({ sidechain: "include" })).settled).toEqual(expected.settled);
  });

  it("does not let facts-only sessions change the usage session count", async () => {
    const userOnly = jsonLines({ type: "user", sessionId: "only-user-session", timestamp: "2026-08-01T00:00:00.000Z", message: { content: "x" } });
    const base = await factsDatabase({ basic: false });
    const before = createAnalysis(base.dbPath);
    const usageTotal = data(before.usageSessions({ sidechain: "include", ...ALL })).total;
    const factTotal = data(before.analyticsSessions(ALL)).total;

    const extended = await factsDatabase({ basic: false, extra: [["user-only.jsonl", userOnly]] });
    const after = createAnalysis(extended.dbPath);
    expect(data(after.usageSessions({ sidechain: "include", ...ALL })).total).toBe(usageTotal);
    expect(data(after.analyticsSessions(ALL)).total).toBe(factTotal + 1);
  });

  it("never carries a token field", async () => {
    const { dbPath, salt } = await factsDatabase();
    const analysis = createAnalysis(dbPath);
    const text = JSON.stringify([
      analysis.analyticsSummary(), analysis.analyticsTools(), analysis.analyticsTrends(RANGE), analysis.analyticsSessions(ALL),
      analysis.analyticsSessionDetail({ id: sessionRef(salt, "sess-F"), ...ALL }),
    ]);
    expect(text).not.toMatch(/inputTokens|outputTokens|cacheReadTokens|cacheCreationTokens|"tokens"|settled/i);
  });
});

describe("failing closed and read-only access", () => {
  it("reports QUERY_FAILED, echoing nothing, if a stored value is outside the vocabulary", async () => {
    const { dbPath } = await factsDatabase();
    withRawDatabase(dbPath, (db) => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.exec("UPDATE source_user_events SET size_state = 'CANARY_BAD_STATE' WHERE id = 1");
    });
    const result = createAnalysis(dbPath).analyticsSummary();
    expect(result).toEqual({ state: "unavailable", data: null, errorCode: "QUERY_FAILED" });
    expect(JSON.stringify(result)).not.toContain("CANARY_BAD_STATE");
  });

  it("leaves the database file and its directory byte-for-byte unchanged", async () => {
    const { dbPath, salt } = await factsDatabase();
    const before = footprint(dbPath);
    const analysis = createAnalysis(dbPath);
    analysis.analyticsSummary();
    analysis.analyticsTools();
    analysis.analyticsTrends(RANGE);
    analysis.analyticsSessions(ALL);
    analysis.analyticsSessionDetail({ id: sessionRef(salt, "sess-F"), ...ALL });
    expect(footprint(dbPath)).toEqual(before);
  });

  it("reports an old schema as unavailable and a missing file as no-database", async () => {
    expect(createAnalysis("/nonexistent-dir-for-test/usage.db").analyticsSummary()).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    expect(createAnalysis("relative.db").analyticsSummary()).toEqual({ state: "unavailable", data: null, errorCode: "INVALID_DATABASE_PATH" });
  });
});
