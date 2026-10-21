import { describe, expect, it } from "vitest";
import {
  accountingSummary,
  fingerprint,
  scanAndIngest,
  scanDiagnostics,
  settledByDate,
  settledByModel,
  settledBySession,
  tokenFieldStateCounts,
} from "@/core/store";
import { CANARIES, fixturePath } from "./helpers";
import { findDatabaseFiles, freshStore, registerTempStoreCleanup, writeText } from "./store-helpers";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

registerTempStoreCleanup();

const BASIC = fixturePath("usage-basic.jsonl");
const tokens = (i: number, o: number, r: number, c: number) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheCreationTokens: c });

async function loaded(paths = [BASIC]) {
  const ctx = freshStore();
  await scanAndIngest(ctx.store, paths);
  return ctx;
}

describe("settled aggregates", () => {
  it("groups settled totals by model, with null as its own bucket", async () => {
    const { store } = await loaded();

    expect(settledByModel(store.db)).toEqual([
      { key: "model-alpha", records: 5, tokens: tokens(118, 78, 1000, 204) },
      { key: "model-beta", records: 1, tokens: tokens(0, 0, 0, 0) },
      { key: null, records: 1, tokens: tokens(2, 2, 0, 0) },
    ]);
  });

  it("groups settled totals by UTC date", async () => {
    const { store } = await loaded();

    expect(settledByDate(store.db)).toEqual([
      { key: "2026-01-10", records: 6, tokens: tokens(117, 77, 1000, 204) },
      { key: null, records: 1, tokens: tokens(3, 3, 0, 0) },
    ]);
  });

  it("groups settled totals by session fingerprint with first and last timestamps", async () => {
    const { store } = await loaded();
    const byKey = new Map(settledBySession(store.db).map((g) => [g.key, g]));

    expect(byKey.get(fingerprint(store.salt, "session", "sess-A"))).toEqual({
      key: fingerprint(store.salt, "session", "sess-A"),
      records: 5,
      tokens: tokens(115, 75, 1000, 204),
      firstTimestamp: "2026-01-10T10:00:01.000Z",
      lastTimestamp: "2026-01-10T10:08:00.000Z",
    });
    expect(byKey.get(fingerprint(store.salt, "session", "sess-B"))).toMatchObject({ records: 1, tokens: tokens(3, 3, 0, 0), firstTimestamp: null });
    expect(byKey.get(null)).toMatchObject({ records: 1, tokens: tokens(2, 2, 0, 0) });
  });

  it("can exclude sidechain records", async () => {
    const { store } = await loaded();

    expect(settledByModel(store.db, { includeSidechain: false })[0]).toEqual({ key: "model-alpha", records: 4, tokens: tokens(113, 73, 1000, 204) });
  });

  it("never folds conflicting or ambiguous usage into any settled breakdown", async () => {
    const { store } = await loaded();
    const summary = accountingSummary(store.db);

    for (const groups of [settledByModel(store.db), settledByDate(store.db), settledBySession(store.db)]) {
      expect(groups.reduce((n, g) => n + g.records, 0)).toBe(7);
      expect(groups.reduce((n, g) => n + g.tokens.inputTokens, 0)).toBe(summary.settled.inputTokens);
      expect(groups.reduce((n, g) => n + g.tokens.outputTokens, 0)).toBe(summary.settled.outputTokens);
    }
    expect(summary.conflicting).toEqual({ groups: 1, lower: tokens(7, 1, 0, 0), upper: tokens(7, 9, 0, 0) });
    expect(summary.ambiguous).toEqual({ records: 2, ifRepeats: tokens(1, 1, 0, 0), ifDistinct: tokens(2, 2, 0, 0) });
  });

  it("keeps missing, null, invalid and zero distinct in stored metadata", async () => {
    const { store } = await loaded();

    expect(tokenFieldStateCounts(store.db)).toEqual({
      inputTokens: { missing: 0, null: 0, invalid: 1, value: 11 },
      outputTokens: { missing: 0, null: 0, invalid: 1, value: 11 },
      cacheReadTokens: { missing: 1, null: 1, invalid: 1, value: 9 },
      cacheCreationTokens: { missing: 1, null: 0, invalid: 0, value: 11 },
    });
    expect(store.db.prepare("SELECT in_state, in_value FROM usage_records WHERE in_value = 0 LIMIT 1").get()).toEqual({ in_state: "value", in_value: 0 });
  });

  it("is deterministic across independent databases", async () => {
    const one = await loaded();
    const two = await loaded();

    expect(accountingSummary(one.store.db)).toEqual(accountingSummary(two.store.db));
    expect(settledByModel(one.store.db)).toEqual(settledByModel(two.store.db));
    expect(settledByDate(one.store.db)).toEqual(settledByDate(two.store.db));
  });
});

describe("scan diagnostics", () => {
  it("reports skipped-record and drift counts per source", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC, fixturePath("malformed-lines.jsonl")]);
    const diagnostics = scanDiagnostics(store.db);

    expect(diagnostics?.status).toBe("complete");
    expect(diagnostics?.sources[0]).toMatchObject({ outcome: "new", eventsWithoutUsage: 4, unusableTimestamps: 1, unrecognizedUsageKeyCount: 1, usageRecordsParsed: 12 });
    expect(diagnostics?.sources[0]?.skipped).toEqual({ blank: 0, malformed: 0, oversized: 0, nonObject: 0, usageObjectsMalformed: 1 });
    expect(diagnostics?.sources[1]?.skipped).toEqual({ blank: 1, malformed: 1, oversized: 0, nonObject: 2, usageObjectsMalformed: 0 });
  });

  it("counts oversized lines using the configured limit", async () => {
    const { store, dir } = freshStore();
    const file = join(dir, "big.jsonl");
    writeText(file, `${JSON.stringify({ type: "assistant", pad: "x".repeat(4000) })}\n`);
    await scanAndIngest(store, [file], { maxLineBytes: 1024 });

    expect(scanDiagnostics(store.db)?.sources[0]?.skipped.oversized).toBe(1);
  });

  it("returns null when no scan has run, and stores only counts in detail_json", async () => {
    const { store } = freshStore();
    expect(scanDiagnostics(store.db)).toBeNull();

    await scanAndIngest(store, [BASIC]);
    const detail = JSON.parse((store.db.prepare("SELECT detail_json FROM source_scan_results").get() as { detail_json: string }).detail_json) as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail).sort()).toEqual(["eventsByType", "tokenFieldIssues"]);
    expect(Object.values(detail.eventsByType ?? {}).every((v) => typeof v === "number")).toBe(true);
  });

  it("records the injected clock", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC], { now: () => new Date("2026-05-05T05:05:05.000Z") });

    expect(store.db.prepare("SELECT started_at, finished_at FROM scan_runs").get()).toEqual({ started_at: "2026-05-05T05:05:05.000Z", finished_at: "2026-05-05T05:05:05.000Z" });
  });
});

describe("privacy of stored data and logs", () => {
  it("never writes canaries, raw ids, tool names or paths into the database file or directory", async () => {
    const replayA = fixturePath("replay-a.jsonl");
    const { store, dbPath } = freshStore();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    await scanAndIngest(store, [BASIC, replayA, fixturePath("replay-b.jsonl"), fixturePath("malformed-lines.jsonl")]);
    store.close();

    const dir = join(dbPath, "..");
    const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
    const forbidden = [...CANARIES, "sess-A", "sess-R1", "msg_1", "msg_r1", "a-001", "toolu_", "Grep", "Bash", "weirdField", "mystery_counter", "usage-basic", "fixtures", process.cwd()];

    for (const needle of forbidden) expect(bytes, needle).not.toContain(needle);
    expect(bytes).toContain("model-alpha");
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("stores no label unless the caller supplies one, and never a path", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC]);
    await scanAndIngest(store, [fixturePath("replay-a.jsonl")], { label: "replay-a" });

    expect(store.db.prepare("SELECT label FROM source_files ORDER BY id").all()).toEqual([{ label: null }, { label: "replay-a" }]);
  });

  it("leaves no database files in the repository after ingesting fixtures", async () => {
    const { dbPath } = await loaded([BASIC, fixturePath("replay-a.jsonl")]);

    expect(findDatabaseFiles(process.cwd())).toEqual([]);
    expect(dbPath.startsWith(process.cwd())).toBe(false);
  });
});
