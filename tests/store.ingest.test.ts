import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountingStateCounts, accountingSummary, ingestSources, IngestError, readSource, scanAndIngest } from "@/core/store";
import { fixturePath } from "./helpers";
import { copyFixtureTo, count, expectMatchesParser, freshStore, readText, registerTempStoreCleanup, writeText } from "./store-helpers";

registerTempStoreCleanup();

const BASIC = fixturePath("usage-basic.jsonl");
const A = fixturePath("replay-a.jsonl");
const B = fixturePath("replay-b.jsonl");
const MALFORMED = fixturePath("malformed-lines.jsonl");

const NEW_LINE = '{"type":"assistant","uuid":"ra-new","sessionId":"sess-R1","timestamp":"2026-02-02T09:00:00.000Z","message":{"id":"msg_new","model":"model-alpha","usage":{"input_tokens":100,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';
const ANON_LINE = '{"type":"assistant","sessionId":"sess-R1","timestamp":"2026-02-02T09:01:00.000Z","message":{"model":"model-alpha","usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';

describe("ingestion matches the in-memory accounting", () => {
  it.each([[[BASIC]], [[A, B]], [[BASIC, A, B, MALFORMED]]])("for %j files", async (paths) => {
    const { store } = freshStore();
    await scanAndIngest(store, paths);

    await expectMatchesParser(store, paths);
  });

  it("reports the known M1.1 fixture totals", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC]);
    const summary = accountingSummary(store.db);

    expect(summary.settled).toEqual({ inputTokens: 120, outputTokens: 80, cacheReadTokens: 1000, cacheCreationTokens: 204, records: 7 });
    expect(accountingStateCounts(store.db)).toEqual({ accepted: 7, duplicate: 1, conflicting: 2, ambiguous: 2 });
  });
});

describe("idempotent rescans", () => {
  it("does not change record counts, states or totals when unchanged sources are rescanned", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC, A, B]);
    const before = { rows: count(store, "usage_records"), summary: accountingSummary(store.db), states: accountingStateCounts(store.db), sessions: count(store, "sessions") };

    const second = await scanAndIngest(store, [BASIC, A, B]);
    const third = await scanAndIngest(store, [B, A, BASIC]);

    expect(second.sources.map((s) => s.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(third.sources.map((s) => s.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect({ rows: count(store, "usage_records"), summary: accountingSummary(store.db), states: accountingStateCounts(store.db), sessions: count(store, "sessions") }).toEqual(before);
    expect(count(store, "scan_runs")).toBe(3);
    expect(count(store, "source_files")).toBe(3);
  });

  it("does not double count when the same file is listed twice in one scan", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC, BASIC]);

    await expectMatchesParser(store, [BASIC]);
    expect(count(store, "source_files")).toBe(1);
  });

  it("is independent of ingestion order and of splitting a scan across runs", async () => {
    const one = freshStore();
    const two = freshStore();
    const three = freshStore();
    await scanAndIngest(one.store, [A, B]);
    await scanAndIngest(two.store, [B, A]);
    await scanAndIngest(three.store, [A]);
    await scanAndIngest(three.store, [B]);

    const expected = accountingSummary(one.store.db);
    expect(accountingSummary(two.store.db)).toEqual(expected);
    expect(accountingSummary(three.store.db)).toEqual(expected);
    expect(accountingStateCounts(three.store.db)).toEqual(accountingStateCounts(one.store.db));
  });
});

describe("source modification and reconciliation", () => {
  async function seeded() {
    const ctx = freshStore();
    const a = copyFixtureTo(ctx.dir, "replay-a.jsonl", "a.jsonl");
    await scanAndIngest(ctx.store, [a, B]);
    return { ...ctx, a };
  }

  it("treats an append to a newline-terminated file as appended, adding only the new line", async () => {
    const { store, a } = await seeded();
    writeText(a, `${readText(a)}${NEW_LINE}\n`);
    const result = await scanAndIngest(store, [a, B]);

    expect(result.sources[0]).toMatchObject({ outcome: "appended", anonymousIdentityUncertain: false });
    expect(accountingSummary(store.db).settled.inputTokens).toBe(147);
    await expectMatchesParser(store, [a, B]);
  });

  it("replaces rows for an edited source and recomputes cross-file groups", async () => {
    const { store, a } = await seeded();
    writeText(a, readText(a).replace('"input_tokens":10,"output_tokens":5', '"input_tokens":11,"output_tokens":5'));
    const result = await scanAndIngest(store, [a, B]);

    expect(result.sources[0]).toMatchObject({ outcome: "modified" });
    expect(result.sources[0]?.recordsRemoved).toBe(5);
    expect(accountingSummary(store.db).conflicting.groups).toBe(2);
    await expectMatchesParser(store, [a, B]);
  });

  it("heals a conflict when the edit is reverted", async () => {
    const { store, a } = await seeded();
    const original = readText(a);
    writeText(a, original.replace('"input_tokens":10,"output_tokens":5', '"input_tokens":11,"output_tokens":5'));
    await scanAndIngest(store, [a, B]);
    writeText(a, original);
    await scanAndIngest(store, [a, B]);

    expect(accountingSummary(store.db).conflicting.groups).toBe(1);
    await expectMatchesParser(store, [a, B]);
  });

  it("flags anonymous identity as uncertain when a line is inserted above anonymous records, without inflating counts", async () => {
    const { store, a } = await seeded();
    const rowsBefore = count(store, "usage_records");
    writeText(a, `${ANON_LINE}\n${readText(a)}`);
    const result = await scanAndIngest(store, [a, B]);

    expect(result.sources[0]).toMatchObject({ outcome: "modified", anonymousIdentityUncertain: true });
    expect(count(store, "usage_records")).toBe(rowsBefore + 1);
    await expectMatchesParser(store, [a, B]);
  });

  it("removes rows for lines that were truncated away", async () => {
    const { store, a } = await seeded();
    const lines = readText(a).trimEnd().split("\n");
    writeText(a, `${lines.slice(0, 2).join("\n")}\n`);
    const result = await scanAndIngest(store, [a, B]);

    expect(result.sources[0]).toMatchObject({ outcome: "modified", recordsRemoved: 5, recordsInserted: 2 });
    await expectMatchesParser(store, [a, B]);
  });

  it("replaces a file wholesale and leaves no stale rows", async () => {
    const { store, a } = await seeded();
    writeText(a, `${NEW_LINE}\n`);
    await scanAndIngest(store, [a, B]);

    await expectMatchesParser(store, [a, B]);
    expect(count(store, "source_files")).toBe(2);
  });

  it("does not trust an append when the stored content had no final newline", async () => {
    const ctx = freshStore();
    const file = join(ctx.dir, "partial.jsonl");
    writeText(file, NEW_LINE);
    await scanAndIngest(ctx.store, [file]);
    writeText(file, `${NEW_LINE}\n${ANON_LINE}\n`);
    const result = await scanAndIngest(ctx.store, [file]);

    expect(result.sources[0]).toMatchObject({ outcome: "modified", anonymousIdentityUncertain: true });
    await expectMatchesParser(ctx.store, [file]);
  });
});

describe("failed and partial scans never delete prior data", () => {
  it("records a partial scan and keeps the readable source", async () => {
    const { store, dir } = freshStore();
    const result = await scanAndIngest(store, [BASIC, join(dir, "missing.jsonl")]);

    expect(result.status).toBe("partial");
    expect(result.sources.map((s) => [s.outcome, s.errorCode])).toEqual([["new", null], ["failed", "ENOENT"]]);
    await expectMatchesParser(store, [BASIC]);
  });

  it("keeps a source's records when the file later disappears", async () => {
    const { store, dir } = freshStore();
    const a = copyFixtureTo(dir, "replay-a.jsonl", "a.jsonl");
    await scanAndIngest(store, [a, B]);
    const before = accountingSummary(store.db);
    rmSync(a);

    const result = await scanAndIngest(store, [a, B]);

    expect(result.status).toBe("partial");
    expect(result.sources[0]).toMatchObject({ outcome: "failed", errorCode: "ENOENT" });
    expect(accountingSummary(store.db)).toEqual(before);
    expect(count(store, "source_files")).toBe(2);
  });

  it("marks a scan failed when every source fails and still changes nothing", async () => {
    const { store, dir } = freshStore();
    await scanAndIngest(store, [BASIC]);
    const before = accountingSummary(store.db);
    const result = await scanAndIngest(store, [join(dir, "nope.jsonl"), join(dir, "no-dir", "nope.jsonl"), dir]);

    expect(result.status).toBe("failed");
    expect(result.sources.map((s) => s.errorCode)).toEqual(["ENOENT", "ENOENT", "NOT_REGULAR_FILE"]);
    expect(accountingSummary(store.db)).toEqual(before);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable file as EACCES and keeps its prior rows", async () => {
    const { store, dir } = freshStore();
    const file = copyFixtureTo(dir, "malformed-lines.jsonl", "locked.jsonl");
    await scanAndIngest(store, [file]);
    const before = accountingSummary(store.db);
    chmodSync(file, 0o000);
    try {
      const result = await scanAndIngest(store, [file]);
      expect(result.sources[0]).toMatchObject({ outcome: "failed", errorCode: "EACCES" });
      expect(accountingSummary(store.db)).toEqual(before);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("transactional ingestion", () => {
  async function inputs() {
    const { store } = freshStore();
    const good = await readSource(store, A);
    const other = await readSource(store, B);
    if (good.kind !== "ok" || other.kind !== "ok") throw new Error("fixture unreadable");
    const [first, ...rest] = other.scan.usage;
    if (!first) throw new Error("fixture empty");
    const poisoned = {
      ...other,
      scan: { ...other.scan, usage: [{ ...first, tokens: { ...first.tokens, inputTokens: { kind: "value" as const, value: -5 } } }, ...rest] },
    };
    return { store, good, other, poisoned };
  }

  it("rolls back every row when a later source fails, and records a failed run with a code only", async () => {
    const { store, good, poisoned } = await inputs();

    let caught: unknown;
    try {
      ingestSources(store, [good, poisoned]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IngestError);
    expect((caught as IngestError).code).toMatch(/^SQLITE_\d+$/);
    expect((caught as IngestError).message).not.toMatch(/-5|msg_|sess-/);
    expect([count(store, "source_files"), count(store, "usage_records"), count(store, "sessions"), count(store, "source_scan_results")]).toEqual([0, 0, 0, 0]);
    expect(store.db.prepare("SELECT status, error_code FROM scan_runs").all()).toEqual([{ status: "failed", error_code: (caught as IngestError).code }]);
  });

  it("restores a previously ingested source exactly when its reconciliation is rolled back", async () => {
    const { store, good, other, poisoned } = await inputs();
    ingestSources(store, [good]);
    const dump = () => JSON.stringify(store.db.prepare("SELECT * FROM usage_records ORDER BY id").all());
    const before = dump();
    const hashBefore = JSON.stringify(store.db.prepare("SELECT content_hash, size_bytes FROM source_files").all());

    const edited = { ...good, contentHash: "different", scan: { ...good.scan, usage: good.scan.usage.slice(0, 1) } };
    expect(() => ingestSources(store, [edited, poisoned])).toThrow(IngestError);

    expect(dump()).toBe(before);
    expect(JSON.stringify(store.db.prepare("SELECT content_hash, size_bytes FROM source_files").all())).toBe(hashBefore);
    expect(ingestSources(store, [good, other]).status).toBe("complete");
    await expectMatchesParser(store, [A, B]);
  });
});

describe("anonymous source-position identity", () => {
  it("keeps identical anonymous lines as separate ambiguous rows keyed by line number", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC]);
    const rows = store.db.prepare("SELECT line_number, accounting, event_key_fp FROM usage_records WHERE identity_kind = 'none' ORDER BY line_number").all();

    expect(rows).toEqual([
      { line_number: 8, accounting: "ambiguous", event_key_fp: null },
      { line_number: 9, accounting: "ambiguous", event_key_fp: null },
    ]);
  });

  it("documents the cross-path limit: a copied file collapses identity-bearing usage but doubles anonymous rows", async () => {
    const { store, dir } = freshStore();
    const copy = copyFixtureTo(dir, "usage-basic.jsonl", "copy.jsonl");
    await scanAndIngest(store, [BASIC]);
    const single = accountingSummary(store.db);
    await scanAndIngest(store, [copy]);
    const doubled = accountingSummary(store.db);

    expect(doubled.settled).toEqual(single.settled);
    expect(doubled.conflicting.groups).toBe(1);
    expect(doubled.ambiguous.records).toBe(4);
    expect(doubled.ambiguous.ifDistinct.inputTokens).toBe(single.ambiguous.ifDistinct.inputTokens * 2);
    expect(doubled.ambiguous.ifRepeats).toEqual(single.ambiguous.ifRepeats);
  });

  it("never merges anonymous records across files on payload equality", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [A, B]);

    expect(accountingSummary(store.db).ambiguous).toMatchObject({ records: 2, ifDistinct: { inputTokens: 8 }, ifRepeats: { inputTokens: 4 } });
  });
});
