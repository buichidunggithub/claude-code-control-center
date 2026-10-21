import { describe, expect, it } from "vitest";
import { parseJsonlFile, summarizeAccounting } from "@/core/parse";
import { CANARIES, fixtureBytes, fixturePath } from "./helpers";

describe("usage-basic.jsonl", () => {
  it("reports exact diagnostics for the synthetic fixture", async () => {
    const { diagnostics } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));

    expect(diagnostics).toMatchObject({
      linesRead: 17,
      blankLines: 0,
      malformedLines: 0,
      oversizedLines: 0,
      nonObjectLines: 0,
      eventsWithoutUsage: 4,
      usageObjectsMalformed: 1,
      usageRecordsParsed: 12,
      accounting: { accepted: 7, duplicate: 1, conflicting: 2, ambiguous: 2 },
      conflictGroups: 1,
      conflictGroupsComparable: 1,
      conflictGroupsContradictory: 0,
      duplicateMetadataMismatches: 0,
      identicalPayloadDistinctIdentities: 0,
      unusableTimestamps: 1,
      missingSessionIds: 1,
      missingModels: 1,
      sidechainRecords: 1,
      unrecognizedUsageKeyCount: 1,
      toolEventsParsed: 3,
      toolEventsKept: 2,
    });
    expect(diagnostics.eventsByType).toMatchObject({ user: 2, assistant: 14, other: 1, missing: 0 });
    expect(diagnostics.tokenFieldIssues).toEqual({
      inputTokens: { missing: 0, null: 0, invalid: 1 },
      outputTokens: { missing: 0, null: 0, invalid: 1 },
      cacheReadTokens: { missing: 1, null: 1, invalid: 1 },
      cacheCreationTokens: { missing: 1, null: 0, invalid: 0 },
    });
  });

  it("separates settled totals from conflicting and ambiguous usage", async () => {
    const { usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const summary = summarizeAccounting(usageRecords);

    expect(summary.settled).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: 1000,
      cacheCreationTokens: 204,
      records: 7,
    });
    expect(summary.conflicting).toEqual({
      groups: 1,
      lower: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      upper: { inputTokens: 7, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    expect(summary.ambiguous).toMatchObject({
      records: 2,
      ifRepeats: { inputTokens: 1, outputTokens: 1 },
      ifDistinct: { inputTokens: 2, outputTokens: 2 },
    });
    expect(summary.duplicates).toBe(1);
    expect(summarizeAccounting(usageRecords, { includeSidechain: false }).settled).toMatchObject({
      inputTokens: 115,
      outputTokens: 75,
      records: 6,
    });
  });

  it("preserves missing, null, zero, invalid and positive values distinctly", async () => {
    const { usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const byKey = new Map([...usageRecords].reverse().map((r) => [r.eventKey, r]))  // first occurrence wins;

    expect(byKey.get("msg:msg_2")?.tokens.cacheReadTokens).toEqual({ kind: "missing" });
    expect(byKey.get("msg:msg_3")?.tokens.cacheReadTokens).toEqual({ kind: "null" });
    expect(byKey.get("msg:msg_3")?.tokens.inputTokens).toEqual({ kind: "value", value: 0 });
    expect(byKey.get("msg:msg_9")?.tokens).toEqual({
      inputTokens: { kind: "invalid" },
      outputTokens: { kind: "invalid" },
      cacheReadTokens: { kind: "invalid" },
      cacheCreationTokens: { kind: "value", value: 4 },
    });
    expect(byKey.get("msg:msg_1")?.tokens.cacheReadTokens).toEqual({ kind: "value", value: 1000 });
  });

  it("normalizes metadata and keeps sidechain records flagged, not removed", async () => {
    const { usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const byKey = new Map([...usageRecords].reverse().map((r) => [r.eventKey, r]))  // first occurrence wins;

    expect(byKey.get("msg:msg_1")).toMatchObject({
      timestamp: "2026-01-10T10:00:01.000Z",
      sessionId: "sess-A",
      model: "model-alpha",
      isSidechain: false,
      identity: "message-id",
      groupSize: 2,
      accounting: "accepted",
      lineNumber: 2,
    });
    expect(byKey.get("msg:msg_4")?.isSidechain).toBe(true);
    expect(byKey.get("msg:msg_7")).toMatchObject({ timestamp: null, sessionId: "sess-B" });
    expect(byKey.get("msg:msg_8")).toMatchObject({ sessionId: null, model: null });
  });

  it("marks records without a reliable identity ambiguous and keeps them all", async () => {
    const { usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const anonymous = usageRecords.filter((r) => r.identity === "none");

    expect(anonymous).toHaveLength(2);
    expect(anonymous.every((r) => r.eventKey === null && r.accounting === "ambiguous")).toBe(true);
  });

  it("treats no conflicting snapshot as authoritative, whichever order they arrive in", async () => {
    const { usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const conflicting = usageRecords.filter((r) => r.eventKey === "msg:msg_6");

    expect(conflicting.map((r) => r.accounting)).toEqual(["conflicting", "conflicting"]);
    expect(conflicting.map((r) => r.tokens.outputTokens)).toEqual([
      { kind: "value", value: 1 },
      { kind: "value", value: 9 },
    ]);
  });

  it("marks the repeated identical message as accepted once plus one duplicate", async () => {
    const { usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));

    expect(usageRecords.filter((r) => r.eventKey === "msg:msg_1").map((r) => r.accounting)).toEqual([
      "accepted",
      "duplicate",
    ]);
  });

  it("emits tool events separately, by name only, deduplicated by tool_use id", async () => {
    const { toolEvents, usageRecords } = await parseJsonlFile(fixturePath("usage-basic.jsonl"));

    expect(toolEvents.map((t) => [t.toolUseId, t.toolName])).toEqual([
      ["toolu_1", "Read"],
      ["toolu_2", "Bash"],
    ]);
    expect(Object.keys(usageRecords[0] ?? {})).not.toContain("tools");
  });

  it("never leaks fixture content into records, tool events or diagnostics", async () => {
    const result = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const serialized = JSON.stringify(result);

    for (const canary of CANARIES) expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("weirdField");
    expect(serialized).not.toContain("mystery_counter");
  });

  it("is deterministic and does not modify the source file", async () => {
    const before = fixtureBytes("usage-basic.jsonl");
    const first = await parseJsonlFile(fixturePath("usage-basic.jsonl"));
    const second = await parseJsonlFile(fixturePath("usage-basic.jsonl"));

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(fixtureBytes("usage-basic.jsonl").equals(before)).toBe(true);
  });
});

describe("malformed-lines.jsonl", () => {
  it("skips and counts blank, malformed and non-object lines without leaking content", async () => {
    const result = await parseJsonlFile(fixturePath("malformed-lines.jsonl"));

    expect(result.diagnostics).toMatchObject({
      linesRead: 6,
      blankLines: 1,
      malformedLines: 1,
      nonObjectLines: 2,
      accounting: { accepted: 2, duplicate: 0, conflicting: 0, ambiguous: 0 },
    });
    expect(summarizeAccounting(result.usageRecords).settled).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
    });
    for (const canary of CANARIES) expect(JSON.stringify(result)).not.toContain(canary);
  });
});

describe("parseJsonlFile", () => {
  it("rejects directories instead of discovering files inside them", async () => {
    await expect(parseJsonlFile("tests/fixtures/synthetic")).rejects.toThrow(TypeError);
  });
});
