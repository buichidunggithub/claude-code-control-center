import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonlSources, parseJsonlStream, summarizeAccounting } from "@/core/parse";
import { accountingSummary, scanAndIngest } from "@/core/store";
import { chunked, fixturePath } from "./helpers";
import { freshStore, registerTempStoreCleanup, tempDir, writeText } from "./store-helpers";

registerTempStoreCleanup();

/**
 * Synthetic usage objects shaped like newer transcripts: an `iterations` array that itemizes the same counters,
 * a `cache_creation` breakdown and `output_tokens_details.thinking_tokens`. Every value is made up. The tests pin
 * what the EXISTING parser does with them: it reads only the four top-level counter keys, so none of these
 * structures may change a token total. Nothing here claims how a real API accounts for them.
 */
const TOP = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } as const;
const EXPECTED_TOP = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 } as const;

const iteration = (i: number, o: number, r: number, c: number, extra: Record<string, unknown> = {}) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: c,
  cache_creation: { ephemeral_5m_input_tokens: c, ephemeral_1h_input_tokens: 0 },
  type: "message",
  ...extra,
});

const line = (id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", sessionId: "s", timestamp: "2026-03-01T00:00:00.000Z", uuid: `u-${id}`, message: { id, model: "model-alpha", usage }, ...extra });

const bytes = (lines: readonly string[]) => chunked(Buffer.from(`${lines.join("\n")}\n`), [37]);
const parse = (lines: readonly string[]) => parseJsonlStream(bytes(lines));

async function one(usage: Record<string, unknown>) {
  const result = await parse([line("m1", usage)]);
  return { ...result, summary: summarizeAccounting(result.usageRecords) };
}

const settledTop = { ...EXPECTED_TOP, records: 1 };

describe("one iteration that matches the top-level counters", () => {
  it("counts the message once, from the top-level counters only", async () => {
    const { usageRecords, summary, diagnostics } = await one({ ...TOP, iterations: [iteration(10, 20, 30, 40)] });

    expect(usageRecords).toHaveLength(1);
    expect(usageRecords[0]?.tokens).toEqual({
      inputTokens: { kind: "value", value: 10 },
      outputTokens: { kind: "value", value: 20 },
      cacheReadTokens: { kind: "value", value: 30 },
      cacheCreationTokens: { kind: "value", value: 40 },
    });
    expect(summary.settled).toEqual(settledTop);
    expect(diagnostics.accounting).toEqual({ accepted: 1, duplicate: 0, conflicting: 0, ambiguous: 0 });
    expect(diagnostics.usageRecordsParsed).toBe(1);
  });

  it("reports `iterations` as exactly one unrecognized key and nothing else", async () => {
    const { diagnostics } = await one({ ...TOP, iterations: [iteration(10, 20, 30, 40)] });

    expect(diagnostics.unrecognizedUsageKeyCount).toBe(1);
    expect(diagnostics.usageObjectsMalformed).toBe(0);
    expect(Object.values(diagnostics.tokenFieldIssues).every((issue) => Object.values(issue).every((n) => n === 0))).toBe(true);
  });
});

describe("several iterations", () => {
  const three = [iteration(1, 2, 3, 4), iteration(5, 6, 7, 8), iteration(9, 10, 11, 12)];

  it("keeps the top-level totals when each iteration has valid counters", async () => {
    const { summary, usageRecords } = await one({ ...TOP, iterations: three });

    expect(summary.settled).toEqual(settledTop);
    expect(usageRecords).toHaveLength(1);
  });

  it("does not double count when the iterations sum to exactly the top-level counters", async () => {
    const { summary } = await one({ ...TOP, iterations: [iteration(4, 8, 12, 16), iteration(6, 12, 18, 24)] });

    expect(summary.settled).toEqual(settledTop); // not 20 / 40 / 60 / 80
  });

  it.each([
    ["larger than", [iteration(100, 200, 300, 400), iteration(1, 1, 1, 1)]],
    ["smaller than", [iteration(1, 1, 1, 1), iteration(0, 0, 0, 0)]],
    ["unrelated to", [iteration(7, 7, 7, 7), iteration(3, 3, 3, 3), iteration(0, 9, 0, 9)]],
  ])("keeps the top-level totals when the summed iterations are %s them, and raises no warning", async (_name, iterations) => {
    const { summary, diagnostics } = await one({ ...TOP, iterations });

    expect(summary.settled).toEqual(settledTop);
    expect(diagnostics.accounting).toEqual({ accepted: 1, duplicate: 0, conflicting: 0, ambiguous: 0 });
    expect(diagnostics.conflictGroups).toBe(0);
    expect(diagnostics.unrecognizedUsageKeyCount).toBe(1);
  });

  it("gives identical records whatever the order or number of iterations", async () => {
    const base = await one({ ...TOP, iterations: three });
    const reversed = await one({ ...TOP, iterations: [...three].reverse() });
    const more = await one({ ...TOP, iterations: [...three, ...three, ...three] });

    expect(reversed.usageRecords).toEqual(base.usageRecords);
    expect(more.usageRecords).toEqual(base.usageRecords);
    expect(more.diagnostics.unrecognizedUsageKeyCount).toBe(1); // one key, however long its array
  });

  it("is deterministic across repeated parses of the same input", async () => {
    const lines = [line("m1", { ...TOP, iterations: three })];

    expect(await parse(lines)).toEqual(await parse(lines));
  });
});

describe("empty, missing, null and malformed iterations", () => {
  it("treats an empty array like any other unrecognized key", async () => {
    const { summary, diagnostics } = await one({ ...TOP, iterations: [] });

    expect(summary.settled).toEqual(settledTop);
    expect(diagnostics.unrecognizedUsageKeyCount).toBe(1);
  });

  it("does not count a missing field, and counts a null one as a present key", async () => {
    const missing = await one({ ...TOP });
    const nulled = await one({ ...TOP, iterations: null });

    expect(missing.summary.settled).toEqual(settledTop);
    expect(nulled.summary.settled).toEqual(settledTop);
    expect(missing.diagnostics.unrecognizedUsageKeyCount).toBe(0);
    expect(nulled.diagnostics.unrecognizedUsageKeyCount).toBe(1);
  });

  it.each([
    ["a string", "iterations"],
    ["a number", 7],
    ["a boolean", true],
    ["an object instead of an array", { input_tokens: 99, output_tokens: 99 }],
    ["entries that are not objects", [null, "x", 5, true, [], [[1]]]],
    ["entries with missing counters", [{}, { input_tokens: 1 }, { type: "message" }]],
    ["entries with invalid counters", [{ input_tokens: "7", output_tokens: -1, cache_read_input_tokens: 1.5, cache_creation_input_tokens: null }]],
    ["entries with unsafe integers", [{ input_tokens: 2 ** 60, output_tokens: Number.MAX_SAFE_INTEGER + 2 }]],
    ["deeply nested entries", [{ a: { b: { c: { d: { e: { input_tokens: 99 } } } } } }]],
  ])("does not crash, warn or change totals for %s", async (_name, iterations) => {
    const { summary, diagnostics, usageRecords } = await one({ ...TOP, iterations });

    expect(usageRecords).toHaveLength(1);
    expect(summary.settled).toEqual(settledTop);
    expect(diagnostics.usageObjectsMalformed).toBe(0);
    expect(diagnostics.malformedLines).toBe(0);
    expect(diagnostics.unrecognizedUsageKeyCount).toBe(1);
    expect(Object.values(diagnostics.tokenFieldIssues).every((issue) => Object.values(issue).every((n) => n === 0))).toBe(true);
  });

  it("never lets a hostile key name reach the counters", async () => {
    const hostile = `{"type":"assistant","sessionId":"s","uuid":"u-h","message":{"id":"h","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40,"iterations":[{"__proto__":{"input_tokens":999},"constructor":{"output_tokens":999}}]}}}`;
    const { usageRecords } = await parse([hostile]);

    expect(summarizeAccounting(usageRecords).settled).toEqual(settledTop);
  });
});

describe("cache-creation breakdowns", () => {
  const breakdown = { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: 15 };

  it("counts the cache-creation counter once, not again through the breakdowns", async () => {
    const { summary, diagnostics } = await one({ ...TOP, cache_creation: breakdown, iterations: [iteration(10, 20, 30, 40, { cache_creation: breakdown })] });

    expect(summary.settled.cacheCreationTokens).toBe(40); // not 80, and not 40 + 25 + 15
    expect(summary.settled).toEqual(settledTop);
    expect(diagnostics.unrecognizedUsageKeyCount).toBe(1); // `cache_creation` is on the ignore list; `iterations` is not
  });

  it("reads only the named counter even when the breakdown disagrees with it", async () => {
    const { summary } = await one({ ...TOP, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 500 } });

    expect(summary.settled.cacheCreationTokens).toBe(40);
  });

  it("does not derive the counter from its breakdown when the named counter is absent", async () => {
    const { usageRecords, summary, diagnostics } = await one({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation: breakdown,
      iterations: [iteration(10, 20, 30, 40, { cache_creation: breakdown })],
    });

    expect(usageRecords[0]?.tokens.cacheCreationTokens).toEqual({ kind: "missing" });
    expect(summary.settled.cacheCreationTokens).toBe(0);
    expect(diagnostics.tokenFieldIssues.cacheCreationTokens).toMatchObject({ missing: 1 });
  });
});

describe("output_tokens_details.thinking_tokens", () => {
  it("is not added to output_tokens", async () => {
    const { summary, diagnostics } = await one({ ...TOP, output_tokens_details: { thinking_tokens: 15 } });

    expect(summary.settled.outputTokens).toBe(20); // not 35
    expect(summary.settled).toEqual(settledTop);
    expect(diagnostics.unrecognizedUsageKeyCount).toBe(1);
  });

  it.each([
    ["larger than output_tokens", 99],
    ["equal to output_tokens", 20],
    ["zero", 0],
    ["not a number", "many"],
    ["null", null],
  ])("leaves output_tokens unchanged when thinking_tokens is %s", async (_name, thinking) => {
    const { summary } = await one({ ...TOP, output_tokens_details: { thinking_tokens: thinking } });

    expect(summary.settled).toEqual(settledTop);
  });

  it("does not derive output_tokens from thinking_tokens when output_tokens is absent", async () => {
    const { usageRecords, summary } = await one({ input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, output_tokens_details: { thinking_tokens: 15 } });

    expect(usageRecords[0]?.tokens.outputTokens).toEqual({ kind: "missing" });
    expect(summary.settled.outputTokens).toBe(0);
  });

  it("is also ignored when the details object is malformed", async () => {
    for (const details of [null, [], "x", 5, { thinking_tokens: { nested: 1 } }]) {
      expect((await one({ ...TOP, output_tokens_details: details })).summary.settled).toEqual(settledTop);
    }
  });
});

describe("identity, duplicates and conflicts ignore these structures", () => {
  it("treats a repeat with different iterations as an exact duplicate", async () => {
    const result = await parse([
      line("m1", { ...TOP, iterations: [iteration(10, 20, 30, 40)] }),
      line("m1", { ...TOP, iterations: [iteration(1, 1, 1, 1), iteration(2, 2, 2, 2)], output_tokens_details: { thinking_tokens: 3 } }),
    ]);

    expect(result.diagnostics.accounting).toEqual({ accepted: 1, duplicate: 1, conflicting: 0, ambiguous: 0 });
    expect(result.diagnostics.conflictGroups).toBe(0);
    expect(summarizeAccounting(result.usageRecords).settled).toEqual(settledTop);
  });

  it("flags a conflict by the top-level counters, even when the iterations are identical", async () => {
    const same = [iteration(10, 20, 30, 40)];
    const result = await parse([line("m1", { ...TOP, iterations: same }), line("m1", { ...TOP, output_tokens: 21, iterations: same })]);

    expect(result.diagnostics.accounting).toEqual({ accepted: 0, duplicate: 0, conflicting: 2, ambiguous: 0 });
    expect(result.diagnostics.conflictGroups).toBe(1);
    expect(summarizeAccounting(result.usageRecords).settled.records).toBe(0);
  });
});

describe("regression: totals for previously supported inputs are unchanged", () => {
  const fixtureLines = (name: string): string[] => readFileSync(fixturePath(name), "utf8").split("\n").filter((l) => l !== "");

  /** Adds the three structures to every usage object that already exists, leaving every other byte of meaning alone. */
  const decorate = (l: string): string => {
    let value: unknown;
    try {
      value = JSON.parse(l);
    } catch {
      return l;
    }
    const message = (value as { message?: { usage?: unknown } } | null)?.message;
    if (message && typeof message === "object" && message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)) {
      message.usage = { ...message.usage, iterations: [iteration(1, 2, 3, 4), iteration(5, 6, 7, 8)], cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 9 }, output_tokens_details: { thinking_tokens: 12345 } };
    }
    return JSON.stringify(value);
  };

  it("pins the exact settled, conflicting and ambiguous totals of the replay fixtures", async () => {
    const plain = await parseJsonlSources(["replay-a.jsonl", "replay-b.jsonl"].map((n) => bytes(fixtureLines(n))));
    const summary = summarizeAccounting(plain.usageRecords);

    expect(summary.settled).toEqual({ inputTokens: 47, outputTokens: 32, cacheReadTokens: 115, cacheCreationTokens: 15, records: 6 });
    expect(summary.conflicting).toEqual({ groups: 1, lower: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 }, upper: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 1 } });
    expect(summary.ambiguous.records).toBe(2);
  });

  it("gives identical records, states and totals once every usage object also carries the new structures", async () => {
    const names = ["replay-a.jsonl", "replay-b.jsonl", "usage-basic.jsonl"];
    const plain = await parseJsonlSources(names.map((n) => bytes(fixtureLines(n))));
    const decorated = await parseJsonlSources(names.map((n) => bytes(fixtureLines(n).map(decorate))));

    expect(decorated.usageRecords).toEqual(plain.usageRecords);
    expect(summarizeAccounting(decorated.usageRecords)).toEqual(summarizeAccounting(plain.usageRecords));
    expect(decorated.diagnostics.accounting).toEqual(plain.diagnostics.accounting);
    expect(decorated.diagnostics.conflictGroups).toBe(plain.diagnostics.conflictGroups);
    // Only the quality metric moves: one more unrecognized key (`iterations`) and one more (`output_tokens_details`) per usage object.
    expect(decorated.diagnostics.unrecognizedUsageKeyCount - plain.diagnostics.unrecognizedUsageKeyCount).toBe(2 * plain.diagnostics.usageRecordsParsed);
  });

  it("stores identical accounting through the existing ingest, with and without the new structures", async () => {
    const dir = tempDir();
    writeText(join(dir, "plain.jsonl"), `${fixtureLines("replay-a.jsonl").join("\n")}\n`);
    writeText(join(dir, "decorated.jsonl"), `${fixtureLines("replay-a.jsonl").map(decorate).join("\n")}\n`);
    const a = freshStore();
    const b = freshStore();
    await scanAndIngest(a.store, [join(dir, "plain.jsonl")]);
    await scanAndIngest(b.store, [join(dir, "decorated.jsonl")]);

    expect(accountingSummary(b.store.db)).toEqual(accountingSummary(a.store.db));
    expect(accountingSummary(a.store.db).settled.records).toBeGreaterThan(0);
  });
});
