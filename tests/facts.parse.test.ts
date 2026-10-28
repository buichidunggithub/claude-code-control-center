import { afterEach, describe, expect, it, vi } from "vitest";
import { TEXT_LENGTH_STATES, parseJsonlFiles, parseJsonlStream, summarizeAccounting, type ParseResult } from "@/core/parse";
import { normalizeEvent } from "@/core/parse/normalize";
import { FACT_CANARIES, PROMPT_FACTS_A, PROMPT_FACTS_B } from "./facts-helpers";
import { CANARIES, chunked, fixturePath } from "./helpers";

const A = fixturePath(PROMPT_FACTS_A);
const B = fixturePath(PROMPT_FACTS_B);
const BASIC = fixturePath("usage-basic.jsonl");
const OPT_IN = { readPromptLength: true } as const;

afterEach(() => vi.restoreAllMocks());

const accountingView = (result: ParseResult) => ({
  usageRecords: result.usageRecords,
  toolEvents: result.toolEvents,
  summary: summarizeAccounting(result.usageRecords),
  accounting: result.diagnostics.accounting,
});

describe("source-typed user events and the prompt-content opt-in", () => {
  it("emits a source-typed user event fact without reading content, with the opt-in off", async () => {
    for (const options of [undefined, {}, { readPromptLength: false }]) {
      const { facts, diagnostics } = await parseJsonlFiles([A, B], options);
      expect(facts.sourceUserEvents).toHaveLength(12);
      expect(facts.sourceUserEvents.every((e) => e.textLength === "not-read")).toBe(true);
      expect(diagnostics.promptLengthEnabled).toBe(false);
      expect(diagnostics.sourceUserEventFacts).toBe(12);
      expect(diagnostics.textLengthStates).toEqual({ empty: 0, xs: 0, s: 0, m: 0, l: 0, xl: 0, unsupported: 0, "not-read": 12 });
    }
  });

  it("does not read a text block's content unless enabled", () => {
    let reads = 0;
    const block = { type: "text", get text(): string { reads += 1; return "CANARY_PROMPT_GETTER"; } };
    const event = { type: "user", message: { role: "user", content: [block] } };
    const position = { sourceIndex: 0, lineNumber: 1 };

    expect(normalizeEvent(event, position).userEvent?.textLength).toBe("not-read");
    expect(normalizeEvent(event, position, { readPromptLength: false }).userEvent?.textLength).toBe("not-read");
    expect(reads).toBe(0);

    expect(normalizeEvent(event, position, { readPromptLength: true }).userEvent?.textLength).toBe("xs");
    expect(reads).toBe(1);
  });

  it("only treats the literal `true` as enabling it", async () => {
    const result = await parseJsonlFiles([A], { readPromptLength: "yes" as unknown as boolean });
    expect(result.facts.sourceUserEvents.every((e) => e.textLength === "not-read")).toBe(true);
  });

  it("makes no claim about what a user event is: only source-typed user events get a fact", async () => {
    const { facts, diagnostics } = await parseJsonlFiles([A], OPT_IN);
    expect(facts.sourceUserEvents.map((e) => e.lineNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(diagnostics.eventsByType.user).toBe(11);
    expect(Object.keys(diagnostics)).not.toContain("prompts");
    expect(Object.keys(diagnostics)).not.toContain("turns");
  });
});

describe("text-length heuristic for source-typed user events", () => {
  it("buckets each content shape and reports unsupported content as `unsupported`", async () => {
    const { facts } = await parseJsonlFiles([A, B], OPT_IN);
    expect(facts.sourceUserEvents.map((e) => [e.sourceIndex, e.lineNumber, e.textLength])).toEqual([
      [0, 1, "xs"], // string
      [0, 2, "s"], // two text blocks, summed
      [0, 3, "unsupported"], // tool_result only
      [0, 4, "xs"], // text plus image: text only
      [0, 5, "unsupported"], // text plus tool_result
      [0, 6, "unsupported"], // content missing
      [0, 7, "unsupported"], // content is an object
      [0, 8, "unsupported"], // nested and malformed blocks
      [0, 9, "unsupported"], // content is a number
      [0, 10, "empty"], // empty text block
      [0, 11, "xs"], // sidechain: still a source-typed user event; whether it is a prompt is undecided
      [1, 2, "xs"],
    ]);
  });

  it("counts states in diagnostics", async () => {
    const { diagnostics } = await parseJsonlFiles([A, B], OPT_IN);
    expect(diagnostics.sourceUserEventFacts).toBe(12);
    expect(diagnostics.textLengthStates).toEqual({ empty: 1, xs: 4, s: 1, m: 0, l: 0, xl: 0, unsupported: 6, "not-read": 0 });
  });

  it("gives the same persisted-safe value for different exact lengths in one bucket", async () => {
    const lineFor = (content: string) => JSON.stringify({ type: "user", message: { content } });
    const stateOf = async (content: string) => {
      const bytes = chunked(Buffer.from(`${lineFor(content)}\n`), [13]);
      return (await parseJsonlStream(bytes, OPT_IN)).facts.sourceUserEvents.map(({ textLength }) => textLength);
    };
    expect(await stateOf("a".repeat(210))).toEqual(await stateOf("b".repeat(990)));
  });

  it("buckets an oversized-content line, and still skips a line over the byte cap", async () => {
    const big = JSON.stringify({ type: "user", message: { content: "z".repeat(20_000) } });
    const ok = await parseJsonlStream(chunked(Buffer.from(`${big}\n`), [4096]), OPT_IN);
    expect(ok.facts.sourceUserEvents.map((e) => e.textLength)).toEqual(["xl"]);

    const capped = await parseJsonlStream(chunked(Buffer.from(`${big}\n`), [4096]), { ...OPT_IN, maxLineBytes: 1000 });
    expect(capped.facts.sourceUserEvents).toEqual([]);
    expect(capped.diagnostics.oversizedLines).toBe(1);
  });
});

describe("tool facts from synthetic assistant events", () => {
  it("keeps only buckets, deduplicated by tool_use id across events and sources", async () => {
    const { facts, diagnostics } = await parseJsonlFiles([A, B]);
    expect(facts.toolCalls.map((c) => c.toolBucket)).toEqual([
      "Read", "other", "other", "unknown", "unknown", "Edit", "other", "Bash", "Write",
    ]);
    expect(diagnostics.toolEventsParsed).toBe(11);
    expect(diagnostics.toolEventsKept).toBe(9);
    expect(diagnostics.toolCallsByBucket).toMatchObject({ Read: 1, Edit: 1, Bash: 1, Write: 1, Grep: 0, Glob: 0, other: 3, unknown: 2 });
  });

  it("does not collapse tool calls with no id", async () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }, { type: "tool_use", name: "Edit" }] } });
    const { facts } = await parseJsonlStream(chunked(Buffer.from(`${line}\n`), [64]));
    expect(facts.toolCalls.map((c) => [c.toolUseId, c.toolBucket])).toEqual([[null, "Edit"], [null, "Edit"]]);
  });

  it("exposes no name, argument or result field on a fact", async () => {
    const { facts } = await parseJsonlFiles([A, B], OPT_IN);
    for (const call of facts.toolCalls) {
      expect(Object.keys(call).sort()).toEqual(["blockIndex", "isSidechain", "lineNumber", "sessionId", "sourceIndex", "timestamp", "toolBucket", "toolUseId"]);
    }
    for (const event of facts.sourceUserEvents) {
      expect(Object.keys(event).sort()).toEqual(["isSidechain", "lineNumber", "sessionId", "sourceIndex", "textLength", "timestamp"]);
    }
  });
});

const streamOf = (...events: readonly unknown[]) =>
  chunked(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`), [41]);
const assistant = (content: readonly unknown[]) => ({ type: "assistant", message: { content } });
const use = (extra: Record<string, unknown> = {}) => ({ type: "tool_use", name: "Edit", input: {}, ...extra });
const identity = (call: { sourceIndex: number; lineNumber: number; blockIndex: number }) =>
  `${call.sourceIndex}:${call.lineNumber}:${call.blockIndex}`;

describe("tool-use block identity", () => {
  it("pins the position of every kept call in the synthetic fixtures", async () => {
    const { facts } = await parseJsonlFiles([A, B]);
    expect(facts.toolCalls.map((c) => [c.sourceIndex, c.lineNumber, c.blockIndex, c.toolBucket])).toEqual([
      [0, 12, 1, "Read"],
      [0, 12, 2, "other"],
      [0, 12, 3, "other"],
      [0, 12, 4, "unknown"],
      [0, 12, 5, "unknown"],
      [0, 13, 1, "Edit"], // no id: kept, and placed by its original position
      [0, 13, 2, "other"],
      [0, 13, 3, "Bash"],
      [1, 1, 1, "Write"],
    ]);
  });

  it("takes the index from the original content array, not from the recognized blocks", async () => {
    const content = [{ type: "text", text: "t" }, use(), "bare", null, use(), [use()], 7, use({ id: "toolu_x" })];
    const { facts, toolEvents } = await parseJsonlStream(streamOf(assistant(content)));
    expect(facts.toolCalls.map((c) => c.blockIndex)).toEqual([1, 4, 7]);
    expect(toolEvents.map((e) => e.blockIndex)).toEqual([1, 4, 7]);
  });

  it("keeps blocks with a missing or unusable id individually distinguishable", async () => {
    const same = [use(), use({ id: null }), use({ id: "" }), use({ id: 5 }), use({ id: "  " })];
    const { facts } = await parseJsonlStream(streamOf(assistant(same), assistant(same)));
    expect(facts.toolCalls).toHaveLength(10);
    expect(facts.toolCalls.every((c) => c.toolUseId === null)).toBe(true);
    expect(new Set(facts.toolCalls.map(identity)).size).toBe(10);
  });

  it("keeps the first occurrence of a repeated id and drops later ones, wherever they sit", async () => {
    const result = await parseJsonlStream(
      streamOf(
        assistant([use({ id: "dup", name: "Read" }), use({ id: "other-id" }), use({ id: "dup", name: "Grep" })]),
        assistant([use({ id: "dup", name: "Bash" }), use({ id: "late" })]),
      ),
    );
    expect(result.facts.toolCalls.map((c) => [c.lineNumber, c.blockIndex, c.toolBucket])).toEqual([
      [1, 0, "Read"],
      [1, 1, "Edit"],
      [2, 1, "Edit"],
    ]);
    expect(result.diagnostics.toolEventsParsed).toBe(5);
    expect(result.diagnostics.toolEventsKept).toBe(3);
  });

  it("gives the same local identity for the same bytes, and none that carries across a modified file", async () => {
    const event = assistant([use(), use()]);
    const original = await parseJsonlStream(streamOf(event));
    const again = await parseJsonlStream(streamOf(event));
    expect(original.facts.toolCalls.map(identity)).toEqual(again.facts.toolCalls.map(identity));

    // An insertion shifts the line number: the same anonymous calls get new identities. They must be recomputed.
    const modified = await parseJsonlStream(streamOf({ type: "system" }, event));
    expect(modified.facts.toolCalls.map(identity)).toEqual(["0:2:0", "0:2:1"]);
    expect(original.facts.toolCalls.map(identity)).toEqual(["0:1:0", "0:1:1"]);
  });

  it("keeps position identity unchanged when lines are only appended", async () => {
    const first = assistant([use(), use()]);
    const before = await parseJsonlStream(streamOf(first));
    const after = await parseJsonlStream(streamOf(first, assistant([use()])));
    expect(after.facts.toolCalls.map(identity).slice(0, 2)).toEqual(before.facts.toolCalls.map(identity));
  });

  it("is unaffected by the opt-in", async () => {
    const off = await parseJsonlFiles([A, B]);
    const on = await parseJsonlFiles([A, B], OPT_IN);
    expect(on.facts.toolCalls).toEqual(off.facts.toolCalls);
  });
});

describe("tool-name buckets through the parser", () => {
  const bucketsFor = async (names: readonly unknown[]) => {
    const blocks = names.map((name, i) => ({ type: "tool_use", id: `t${i}`, name }));
    return (await parseJsonlStream(streamOf(assistant(blocks)))).facts.toolCalls.map((c) => c.toolBucket);
  };

  it("buckets the raw name, so padding and case never reach an allowlisted bucket", async () => {
    expect(await bucketsFor(["Read", " Read", "Read ", "read", "READ", "Read\n"])).toEqual([
      "Read", "other", "other", "other", "other", "other",
    ]);
  });

  it("maps mcp__, unusual, overlong, missing and malformed names to the right fallback", async () => {
    const names = ["mcp__a__b", "mcp__", "Re\u0000ad", "<odd>", "x".repeat(256), "x".repeat(257), "x".repeat(10_000), "  ", undefined, null, "", 5, {}, ["Read"]];
    expect(await bucketsFor(names)).toEqual([
      "other", "other", "other", "other", "other", "other", "other", "other", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown",
    ]);
  });

  it("leaves the raw, parse-only `toolName` exactly as before", async () => {
    const blocks = [use({ id: "a", name: " Read " }), use({ id: "b", name: "x".repeat(300) }), use({ id: "c", name: "Bash" })];
    const { toolEvents } = await parseJsonlStream(streamOf(assistant(blocks)));
    expect(toolEvents.map((e) => e.toolName)).toEqual(["Read", null, "Bash"]);
    expect(toolEvents.map((e) => e.toolBucket)).toEqual(["other", "other", "Bash"]);
  });
});

describe("privacy of everything the parser returns", () => {
  const forbidden = [...FACT_CANARIES, ...CANARIES, "CANARY_THROWN", "CANARY_PROMPT_GETTER"];

  it("leaks no canary into facts, results or diagnostics, enabled or not", async () => {
    for (const options of [{}, OPT_IN]) {
      const { facts, diagnostics } = await parseJsonlFiles([A, B], options);
      const factText = JSON.stringify([facts, diagnostics]);
      for (const canary of forbidden) expect(factText).not.toContain(canary);
      // The raw tool names of the existing, parse-only `toolEvents` are out of scope for facts.
      expect(factText).not.toMatch(/mcp__|<odd>/);
    }
  });

  it("leaks no canary into console output or error messages", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await parseJsonlFiles([A, B, BASIC], OPT_IN);
    await parseJsonlFiles([fixturePath("malformed-lines.jsonl")], OPT_IN);
    const failure = await parseJsonlFiles([A], { ...OPT_IN, maxLineBytes: 0 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RangeError);
    const text = JSON.stringify([...spies.map((s) => s.mock.calls), write.mock.calls, String(failure)]);
    for (const canary of forbidden) expect(text).not.toContain(canary);
  });

  it("returns only vocabulary values for text length and tool name", async () => {
    const { facts } = await parseJsonlFiles([A, B], OPT_IN);
    const states = new Set<string>(TEXT_LENGTH_STATES);
    expect(facts.sourceUserEvents.every((e) => states.has(e.textLength))).toBe(true);
    expect(facts.toolCalls.every((c) => typeof c.toolBucket === "string" && c.toolBucket.length < 16)).toBe(true);
  });
});

describe("usage accounting and settled totals are unaffected", () => {
  it.each([[[BASIC]], [[A, B]], [[fixturePath("replay-a.jsonl"), fixturePath("replay-b.jsonl")]]])(
    "gives identical records, tool events and totals with the opt-in on and off (%#)",
    async (files) => {
      const off = await parseJsonlFiles(files);
      const on = await parseJsonlFiles(files, OPT_IN);
      expect(accountingView(on)).toEqual(accountingView(off));
    },
  );

  it("still settles the original fixture to the pinned totals", async () => {
    const { usageRecords, diagnostics } = await parseJsonlFiles([BASIC], OPT_IN);
    expect(summarizeAccounting(usageRecords).settled).toEqual({
      inputTokens: 120, outputTokens: 80, cacheReadTokens: 1000, cacheCreationTokens: 204, records: 7,
    });
    expect(diagnostics.accounting).toEqual({ accepted: 7, duplicate: 1, conflicting: 2, ambiguous: 2 });
    expect(diagnostics.toolEventsParsed).toBe(3);
    expect(diagnostics.toolEventsKept).toBe(2);
  });

  it("accounts the new fixtures as expected", async () => {
    const { usageRecords, diagnostics } = await parseJsonlFiles([A, B]);
    expect(diagnostics.accounting).toEqual({ accepted: 3, duplicate: 0, conflicting: 0, ambiguous: 0 });
    expect(summarizeAccounting(usageRecords).settled).toEqual({
      inputTokens: 36, outputTokens: 48, cacheReadTokens: 60, cacheCreationTokens: 72, records: 3,
    });
  });
});
