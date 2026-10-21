import { describe, expect, it } from "vitest";
import { parseJsonlStream, summarizeAccounting, TOKEN_FIELDS, type TokenFieldName } from "@/core/parse";
import { chunked, mulberry32 } from "./helpers";

type Generated = Partial<Record<TokenFieldName, number | null>>;

const SOURCE_KEY: Record<TokenFieldName, string> = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheCreationTokens: "cache_creation_input_tokens",
};

function generate(seed: number, count: number) {
  const random = mulberry32(seed);
  const events = Array.from({ length: count }, (_, index) => {
    const tokens: Generated = {};
    for (const field of TOKEN_FIELDS) {
      const roll = random();
      if (roll < 0.15) continue; // missing
      tokens[field] = roll < 0.3 ? null : roll < 0.5 ? 0 : Math.floor(random() * 5000);
    }
    const usage = Object.fromEntries(Object.entries(tokens).map(([f, v]) => [SOURCE_KEY[f as TokenFieldName], v]));
    return {
      tokens,
      line: JSON.stringify({
        type: "assistant",
        uuid: `u-${seed}-${index}`,
        sessionId: `s-${index % 3}`,
        timestamp: "2026-02-01T00:00:00.000Z",
        message: { id: `msg-${seed}-${index}`, model: "model-alpha", usage },
      }),
    };
  });
  const expected = Object.fromEntries(
    TOKEN_FIELDS.map((f) => [f, events.reduce((sum, e) => sum + (e.tokens[f] ?? 0), 0)]),
  );
  return { events, expected };
}

const parse = (lines: readonly string[]) =>
  parseJsonlStream(chunked(Buffer.from(`${lines.join("\n")}\n`), [64]));

describe("generated usage streams", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: totals match the generator's expected sums", async (seed) => {
    const { events, expected } = generate(seed, 60);
    const result = await parse(events.map((e) => e.line));

    expect(summarizeAccounting(result.usageRecords).settled).toMatchObject({ ...expected, records: 60 });
    expect(result.diagnostics.accounting).toEqual({ accepted: 60, duplicate: 0, conflicting: 0, ambiguous: 0 });
  });

  it.each([11, 12, 13])("seed %i: line order does not change totals, and parsing is deterministic", async (seed) => {
    const { events, expected } = generate(seed, 40);
    const lines = events.map((e) => e.line);
    const random = mulberry32(seed);
    const shuffled = [...lines].sort(() => random() - 0.5);

    const [a, b, c] = await Promise.all([parse(lines), parse(lines), parse(shuffled)]);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(summarizeAccounting(c.usageRecords).settled).toMatchObject(expected);
  });

  it.each([21, 22, 23])("seed %i: repeating every line leaves totals unchanged and counts duplicates", async (seed) => {
    const { events, expected } = generate(seed, 30);
    const lines = events.map((e) => e.line);
    const result = await parse([...lines, ...lines, ...lines]);

    expect(summarizeAccounting(result.usageRecords).settled).toMatchObject({ ...expected, records: 30 });
    expect(result.diagnostics).toMatchObject({ usageRecordsParsed: 90, conflictGroups: 0 });
    expect(result.diagnostics.accounting).toEqual({ accepted: 30, duplicate: 60, conflicting: 0, ambiguous: 0 });
    expect(result.usageRecords.every((r) => r.groupSize === 3)).toBe(true);
  });

  it("never throws or leaks on arbitrary junk lines", async () => {
    const random = mulberry32(99);
    const junk = Array.from({ length: 200 }, () =>
      Array.from({ length: Math.floor(random() * 40) }, () => String.fromCharCode(32 + Math.floor(random() * 95))).join("") + "CANARY_JUNK",
    );
    const result = await parse(junk);

    expect(result.usageRecords).toHaveLength(0);
    expect(JSON.stringify(result.diagnostics)).not.toContain("CANARY_JUNK");
  });
});
