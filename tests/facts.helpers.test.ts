import { describe, expect, it } from "vitest";
import {
  PROMPT_LENGTH_BUCKETS,
  PROMPT_LENGTH_THRESHOLDS,
  TOOL_BUCKETS,
  TOOL_NAME_ALLOWLIST,
  promptLengthBucket,
  toolNameBucket,
} from "@/core/parse";
import { mulberry32 } from "./helpers";

const text = (value: string) => ({ type: "text", text: value });

describe("promptLengthBucket", () => {
  it("maps string lengths onto the documented thresholds", () => {
    const { EXTRA_SMALL, SMALL, MEDIUM, LARGE } = PROMPT_LENGTH_THRESHOLDS;
    const cases: [number, string][] = [
      [0, "empty"], [1, "xs"], [EXTRA_SMALL, "xs"], [EXTRA_SMALL + 1, "s"], [SMALL, "s"], [SMALL + 1, "m"],
      [MEDIUM, "m"], [MEDIUM + 1, "l"], [LARGE, "l"], [LARGE + 1, "xl"], [5_000_000, "xl"],
    ];
    for (const [length, bucket] of cases) expect(promptLengthBucket("a".repeat(length))).toBe(bucket);
  });

  it("returns the same value for different exact lengths in one bucket", () => {
    expect(promptLengthBucket("a".repeat(60))).toBe(promptLengthBucket("b".repeat(190)));
    expect(promptLengthBucket([text("a".repeat(60))])).toBe(promptLengthBucket("c".repeat(190)));
  });

  it("sums text blocks and skips other blocks", () => {
    expect(promptLengthBucket([text("a".repeat(30)), text("b".repeat(30))])).toBe("s");
    expect(promptLengthBucket([text("a"), { type: "image", source: { data: "x".repeat(9000) } }])).toBe("xs");
  });

  it("is null for tool results, even when text is mixed in", () => {
    expect(promptLengthBucket([{ type: "tool_result", content: "x" }])).toBeNull();
    expect(promptLengthBucket([text("hello"), { type: "tool_result", content: "x" }])).toBeNull();
  });

  it("is null for unsupported or malformed content without throwing", () => {
    const unsupported: unknown[] = [
      undefined, null, 5, true, {}, { text: "x" }, [], [null, 7, "bare", ["nested"]],
      [{ type: "text" }], [{ type: "text", text: 5 }], [{ type: "text", text: { inner: "x" } }], [{ type: "other", text: "x" }],
    ];
    for (const content of unsupported) expect(promptLengthBucket(content)).toBeNull();
  });

  it("never traverses nested structures or stringifies objects", () => {
    let touched = 0;
    const trap = (value: unknown) => ({ get [Symbol.toPrimitive]() { touched += 1; return () => "x"; }, value });
    const nested = { toString: () => { touched += 1; return "x"; }, deep: [trap(1)] };
    promptLengthBucket(nested);
    promptLengthBucket([nested, [nested], { type: "text", text: nested }]);
    expect(touched).toBe(0);
  });

  it("returns null instead of throwing when a getter throws", () => {
    const hostile = { type: "text", get text(): string { throw new Error("CANARY_THROWN_TEXT"); } };
    expect(promptLengthBucket([hostile])).toBeNull();
  });

  it("only ever returns a bucket or null, for arbitrary shapes", () => {
    const random = mulberry32(8_2);
    const atoms: unknown[] = ["", "abc", "x".repeat(300), 0, 3.5, null, undefined, true, {}, []];
    const pick = (): unknown => {
      const roll = random();
      if (roll < 0.4) return atoms[Math.floor(random() * atoms.length)];
      if (roll < 0.6) return text("t".repeat(Math.floor(random() * 6000)));
      if (roll < 0.7) return { type: "tool_result", content: "r" };
      return { type: random() < 0.5 ? "text" : "image", text: atoms[Math.floor(random() * atoms.length)], nested: [pickAtom()] };
    };
    const pickAtom = (): unknown => atoms[Math.floor(random() * atoms.length)];
    const allowed = new Set<string | null>([...PROMPT_LENGTH_BUCKETS, null]);
    for (let i = 0; i < 500; i += 1) {
      const content = random() < 0.3 ? pick() : Array.from({ length: Math.floor(random() * 5) }, pick);
      expect(allowed.has(promptLengthBucket(content))).toBe(true);
    }
  });
});

/** An independent copy: changing the allowlist must change this list too, as a deliberate, reviewed edit. */
const APPROVED_TOOL_NAMES = [
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite",
] as const;

describe("toolNameBucket", () => {
  it("has exactly the approved allowlist, each name as its own exact entry", () => {
    expect([...TOOL_NAME_ALLOWLIST]).toEqual([...APPROVED_TOOL_NAMES]);
    expect(new Set(TOOL_NAME_ALLOWLIST).size).toBe(TOOL_NAME_ALLOWLIST.length);
    for (const name of TOOL_NAME_ALLOWLIST) {
      expect(name).toMatch(/^[A-Za-z]+$/);
      expect(toolNameBucket(name)).toBe(name);
    }
    expect([...TOOL_BUCKETS]).toEqual([...APPROVED_TOOL_NAMES, "other", "unknown"]);
  });

  it("keeps no near-miss of an approved name", () => {
    for (const name of APPROVED_TOOL_NAMES) {
      const variants = [
        name.toLowerCase(), name.toUpperCase(), ` ${name}`, `${name} `, `${name}\n`, `${name}\u0000`, `${name}\u200b`,
        `${name}2`, `x${name}`, `mcp__${name}`, `mcp__server__${name}`, `${name}.${name}`, name.slice(0, -1),
      ];
      for (const variant of variants) expect(toolNameBucket(variant)).toBe("other");
    }
  });

  it("maps every mcp__ name to `other`, whatever follows the prefix", () => {
    for (const name of ["mcp__", "mcp__a", "mcp__a__b", "mcp__Read", "mcp____", `mcp__${"x".repeat(5000)}`]) {
      expect(toolNameBucket(name)).toBe("other");
    }
  });

  it("maps overlong names to `other`, not `unknown`, and keeps allowlisted length checks exact", () => {
    for (const length of [100, 256, 257, 10_000]) expect(toolNameBucket("n".repeat(length))).toBe("other");
  });

  it("collapses inherited object property names", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(toolNameBucket(name)).toBe("other");
    }
  });

  it("collapses unknown names, including every mcp__ name, into `other`", () => {
    const names = [
      "mcp__server__tool", "mcp__", "MCP__server__tool", "Custom", "read", "READ", " Read", "Read ", "Read\n",
      "Re\u0000ad", "<script>", "../../etc/passwd", "emoji-\u{1F600}", "x".repeat(300), "__proto__", "constructor", "toString",
    ];
    for (const name of names) expect(toolNameBucket(name)).toBe("other");
  });

  it("maps missing or malformed names to `unknown`", () => {
    for (const name of [undefined, null, "", 5, true, {}, [], ["Read"], { toString: () => "Read" }]) {
      expect(toolNameBucket(name)).toBe("unknown");
    }
  });

  it("only ever returns a member of the fixed vocabulary", () => {
    const vocabulary = new Set<string>(TOOL_BUCKETS);
    for (const name of ["Read", "mcp__a", "zzz", null, 3, "x".repeat(1000)]) {
      expect(vocabulary.has(toolNameBucket(name))).toBe(true);
    }
  });
});
