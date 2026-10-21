import { describe, expect, it } from "vitest";
import {
  parseJsonlFiles,
  parseJsonlSources,
  summarizeAccounting,
  type TokenSums,
} from "@/core/parse";
import { CANARIES, chunked, fixturePath } from "./helpers";

const A = fixturePath("replay-a.jsonl");
const B = fixturePath("replay-b.jsonl");

const sums = (i: number, o: number, r: number, c: number): TokenSums => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: r,
  cacheCreationTokens: c,
});

const line = (id: string | null, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "s",
    timestamp: "2026-03-01T00:00:00.000Z",
    ...(id ? { uuid: `u-${id}`, message: { id, usage } } : { message: { usage } }),
    ...extra,
  });

const source = (lines: readonly string[]) => chunked(Buffer.from(`${lines.join("\n")}\n`), [50]);

describe("accounting across multiple fixture files", () => {
  it("collapses replays, flags conflicts and ambiguity, and keeps settled totals exact", async () => {
    const { usageRecords, diagnostics } = await parseJsonlFiles([A, B]);
    const summary = summarizeAccounting(usageRecords);

    expect(diagnostics).toMatchObject({
      sourcesScanned: 2,
      usageRecordsParsed: 13,
      accounting: { accepted: 6, duplicate: 3, conflicting: 2, ambiguous: 2 },
      conflictGroups: 1,
      conflictGroupsComparable: 1,
      duplicateMetadataMismatches: 3,
      identicalPayloadDistinctIdentities: 1,
    });
    expect(summary.settled).toEqual({ ...sums(47, 32, 115, 15), records: 6 });
    expect(summary.conflicting).toEqual({ groups: 1, lower: sums(1, 1, 1, 1), upper: sums(1, 2, 1, 1) });
    expect(summary.ambiguous).toEqual({ records: 2, ifRepeats: sums(4, 4, 0, 0), ifDistinct: sums(8, 8, 0, 0) });
  });

  it("does not merge different identities that carry identical payloads", async () => {
    const { usageRecords } = await parseJsonlFiles([A, B]);
    const twins = usageRecords.filter((r) => r.eventKey === "msg:msg_r5" || r.eventKey === "msg:msg_r6");

    expect(twins.map((r) => r.accounting)).toEqual(["accepted", "accepted"]);
  });

  it("treats a sidechain replay of a main-thread message as a duplicate with a metadata mismatch", async () => {
    const { usageRecords } = await parseJsonlFiles([A, B]);
    const r2 = usageRecords.filter((r) => r.eventKey === "msg:msg_r2");

    expect(r2.map((r) => [r.sourceIndex, r.isSidechain, r.accounting])).toEqual([
      [0, false, "accepted"],
      [1, false, "duplicate"],
      [1, true, "duplicate"],
    ]);
  });

  it("counts an own-identity sidechain record in settled totals unless excluded", async () => {
    const { usageRecords } = await parseJsonlFiles([A, B]);

    expect(summarizeAccounting(usageRecords).settled.inputTokens).toBe(47);
    expect(summarizeAccounting(usageRecords, { includeSidechain: false }).settled).toMatchObject({
      inputTokens: 45,
      records: 5,
    });
  });

  it("gives the same settled and conflicting totals whichever file is scanned first", async () => {
    const forward = summarizeAccounting((await parseJsonlFiles([A, B])).usageRecords);
    const backward = summarizeAccounting((await parseJsonlFiles([B, A])).usageRecords);

    expect(backward.settled).toEqual(forward.settled);
    expect(backward.conflicting).toEqual(forward.conflicting);
    expect(backward.ambiguous).toEqual(forward.ambiguous);
  });

  it("does not inflate settled totals when the same files are scanned again in one call", async () => {
    const once = summarizeAccounting((await parseJsonlFiles([A, B])).usageRecords);
    const twice = summarizeAccounting((await parseJsonlFiles([A, B, A, B])).usageRecords);

    expect(twice.settled).toEqual(once.settled);
    expect(twice.conflicting).toEqual(once.conflicting);
    expect(twice.ambiguous.ifRepeats).toEqual(once.ambiguous.ifRepeats);
  });

  it("documents the idempotence boundary: ambiguous 'ifDistinct' grows with repeated scans", async () => {
    const once = summarizeAccounting((await parseJsonlFiles([A, B])).usageRecords);
    const twice = summarizeAccounting((await parseJsonlFiles([A, B, A, B])).usageRecords);

    expect(twice.ambiguous.ifDistinct.inputTokens).toBe(once.ambiguous.ifDistinct.inputTokens * 2);
  });

  it("keeps tool events separate and deduplicated by tool_use id across files", async () => {
    const { toolEvents } = await parseJsonlFiles([A, B]);

    expect(toolEvents.map((t) => [t.toolUseId, t.toolName, t.sourceIndex])).toEqual([["toolu_r1", "Grep", 0]]);
  });

  it("never leaks fixture content", async () => {
    const serialized = JSON.stringify(await parseJsonlFiles([A, B]));
    for (const canary of CANARIES) expect(serialized).not.toContain(canary);
  });
});

describe("conflict handling", () => {
  const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o });

  it("classifies a contradictory conflict (one counter up, another down)", async () => {
    const result = await parseJsonlSources([source([line("m", usage(5, 1)), line("m", usage(2, 9))])]);

    expect(result.diagnostics).toMatchObject({ conflictGroups: 1, conflictGroupsComparable: 0, conflictGroupsContradictory: 1 });
  });

  it("yields the same totals and states regardless of snapshot order", async () => {
    const lines = [line("m", usage(5, 1)), line("m", usage(5, 9)), line("m", usage(5, 4))];
    const forward = await parseJsonlSources([source(lines)]);
    const reversed = await parseJsonlSources([source([...lines].reverse())]);

    expect(summarizeAccounting(reversed.usageRecords)).toEqual(summarizeAccounting(forward.usageRecords));
    expect(summarizeAccounting(forward.usageRecords).conflicting).toMatchObject({
      groups: 1,
      lower: { outputTokens: 1 },
      upper: { outputTokens: 9 },
    });
    expect(summarizeAccounting(forward.usageRecords).settled.records).toBe(0);
  });

  it("treats differing raw states as a conflict (missing versus zero), and keeps the raw states", async () => {
    const result = await parseJsonlSources([
      source([line("m", { input_tokens: 3 }), line("m", { input_tokens: 3, output_tokens: 0 })]),
    ]);

    expect(result.diagnostics.accounting.conflicting).toBe(2);
    expect(result.usageRecords.map((r) => r.tokens.outputTokens.kind)).toEqual(["missing", "value"]);
  });

  it("does not collapse identical anonymous lines: both stay ambiguous", async () => {
    const result = await parseJsonlSources([source([line(null, usage(4, 4)), line(null, usage(4, 4))])]);

    expect(result.diagnostics.accounting).toEqual({ accepted: 0, duplicate: 0, conflicting: 0, ambiguous: 2 });
    expect(summarizeAccounting(result.usageRecords).settled.records).toBe(0);
  });

  it("falls back to the line uuid so an exactly repeated line is a duplicate", async () => {
    const repeated = JSON.stringify({ type: "assistant", uuid: "only-uuid", message: { usage: usage(1, 1) } });
    const result = await parseJsonlSources([source([repeated, repeated])]);

    expect(result.usageRecords.map((r) => [r.identity, r.accounting])).toEqual([
      ["uuid", "accepted"],
      ["uuid", "duplicate"],
    ]);
  });
});
