import { describe, expect, it } from "vitest";
import { parseJsonlStream } from "@/core/parse";
import { readBoundedLines } from "@/core/parse/lines";
import { chunked, fixtureBytes } from "./helpers";

const LIMIT = 1024;

function eventOfExactSize(bytes: number): string {
  const base = '{"type":"assistant","pad":""}';
  return `{"type":"assistant","pad":"${"x".repeat(bytes - base.length)}"}`;
}

async function collect(text: string, sizes: readonly number[], limit = LIMIT) {
  const bytes = Buffer.from(text, "utf8");
  const lines = [];
  for await (const line of readBoundedLines(chunked(bytes, sizes), limit)) lines.push(line);
  return lines;
}

describe("line size boundary", () => {
  it("accepts a line of exactly maxLineBytes and rejects one byte more", async () => {
    const exact = eventOfExactSize(LIMIT);
    const over = eventOfExactSize(LIMIT + 1);
    expect(Buffer.byteLength(exact)).toBe(LIMIT);

    const atLimit = await parseJsonlStream(chunked(Buffer.from(`${exact}\n`), [100]), { maxLineBytes: LIMIT });
    const aboveLimit = await parseJsonlStream(chunked(Buffer.from(`${over}\n`), [100]), { maxLineBytes: LIMIT });

    expect(atLimit.diagnostics).toMatchObject({ oversizedLines: 0, eventsWithoutUsage: 1 });
    expect(aboveLimit.diagnostics).toMatchObject({ oversizedLines: 1, eventsWithoutUsage: 0 });
  });

  it("skips an oversized line and keeps parsing the lines after it, across chunk splits", async () => {
    const good = '{"type":"assistant","message":{"id":"m","usage":{"input_tokens":1}}}';
    const text = `${good}\n${eventOfExactSize(LIMIT * 5)}\n${good.replace('"m"', '"n"')}\n`;

    for (const sizes of [[1], [7], [LIMIT], [3, 500, 11]]) {
      const result = await parseJsonlStream(chunked(Buffer.from(text), sizes), { maxLineBytes: LIMIT });
      expect(result.diagnostics).toMatchObject({ linesRead: 3, oversizedLines: 1, accounting: { accepted: 2, duplicate: 0, conflicting: 0, ambiguous: 0 } });
    }
  });

  it("handles an unterminated final line, CRLF endings and a BOM", async () => {
    const good = '{"type":"assistant","message":{"id":"m","usage":{"input_tokens":2}}}';
    const text = `﻿${good}\r\n${good.replace('"m"', '"n"')}`;
    const result = await parseJsonlStream(chunked(Buffer.from(text), [5]));

    expect(result.diagnostics).toMatchObject({ linesRead: 2, malformedLines: 0, accounting: { accepted: 2, duplicate: 0, conflicting: 0, ambiguous: 0 } });
  });

  it("does not emit empty trailing lines", async () => {
    expect(await collect('{"a":1}\n', [3])).toHaveLength(1);
    expect(await collect("", [3])).toHaveLength(0);
  });

  it("rejects an invalid maxLineBytes", async () => {
    await expect(parseJsonlStream(chunked(Buffer.from("{}\n"), [1]), { maxLineBytes: 0 })).rejects.toThrow(RangeError);
  });

  it("treats deeply nested JSON as malformed instead of crashing", async () => {
    const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}\n`;
    const result = await parseJsonlStream(chunked(Buffer.from(deep), [65536]), { maxLineBytes: 1_000_000 });

    expect(result.diagnostics.malformedLines + result.diagnostics.nonObjectLines).toBe(1);
  });
});

describe("chunk-boundary invariance", () => {
  it("yields identical results for 40 pseudo-random chunkings, including mid-character splits", async () => {
    const bytes = fixtureBytes("usage-basic.jsonl");
    const baseline = JSON.stringify(await parseJsonlStream(chunked(bytes, [bytes.length])));

    for (let seed = 1; seed <= 40; seed += 1) {
      const sizes = Array.from({ length: 7 }, (_, i) => ((seed * 31 + i * 17) % 97) + 1);
      expect(JSON.stringify(await parseJsonlStream(chunked(bytes, sizes)))).toBe(baseline);
    }
  });
});
