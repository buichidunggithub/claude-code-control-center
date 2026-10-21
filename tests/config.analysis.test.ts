import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES, isSafeEvidence } from "@/core/config";
import { agentFile, fileOf, findingsOf, projectRoot, scan, userRoot, writeTree } from "./config-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const lines = (prefix: string, count: number, change: readonly number[] = []): string =>
  `${Array.from({ length: count }, (_, i) => `${prefix} instruction number ${i} applies here${change.includes(i) ? " (changed)" : ""}`).join("\n")}\n`;

describe("exact duplicates", () => {
  it("reports identical content once per group, across scopes, with high confidence and no text", async () => {
    const base = tempDir();
    const body = `${"Shared guidance that is long enough to matter. ".repeat(6)}\n`;
    writeTree(join(base, "u"), { "rules/a.md": body });
    writeTree(join(base, "p"), { ".claude/rules/b.md": body, ".claude/rules/c.md": body, ".claude/rules/other.md": "Something else entirely and unique.\n" });
    const inv = await scan([userRoot(join(base, "u")), projectRoot(join(base, "p"))]);

    const found = findingsOf(inv, "CFG-DUP-001");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ confidence: "high", severity: "low", evidence: { fileCount: 3, crossScope: true } });
    expect(found[0]?.recommendation).toMatch(/not a claim/);
    expect(findingsOf(inv, "CFG-DUP-002")).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("Shared guidance");
  });

  it("ignores tiny identical files", async () => {
    const dir = tempDir();
    writeTree(dir, { ".claude/rules/a.md": "Short rule.\n", ".claude/rules/b.md": "Short rule.\n" });

    expect(findingsOf(await scan([projectRoot(dir)]), "CFG-DUP-001")).toEqual([]);
  });
});

describe("near duplicates", () => {
  it("scores shared normalized lines and keeps confidence conservative", async () => {
    const dir = tempDir();
    writeTree(dir, {
      ".claude/rules/base30.md": lines("alpha", 30),
      ".claude/rules/close30.md": lines("alpha", 30, [3]),
      ".claude/rules/base20.md": lines("beta", 20),
      ".claude/rules/edit20.md": lines("beta", 20, [1, 2]),
      ".claude/rules/unrelated.md": lines("gamma", 30),
    });
    const inv = await scan([projectRoot(dir)]);

    const byEvidence = findingsOf(inv, "CFG-DUP-002")
      .map((f): Record<string, number | string | boolean> => ({ confidence: f.confidence, ...f.evidence }))
      .sort((a, b) => Number(a["linesA"]) - Number(b["linesA"]));
    expect(byEvidence).toEqual([
      { confidence: "low", sharedLines: 18, linesA: 20, linesB: 20, similarityPct: 82 },
      { confidence: "medium", sharedLines: 29, linesA: 30, linesB: 30, similarityPct: 94 },
    ]);
    expect(findingsOf(inv, "CFG-DUP-001")).toEqual([]);
  });

  it("does not report files below the similarity threshold or with too few lines", async () => {
    const dir = tempDir();
    writeTree(dir, {
      ".claude/rules/a.md": lines("delta", 20),
      ".claude/rules/b.md": lines("delta", 20, [0, 1, 2, 3, 4, 5, 6, 7]),
      ".claude/rules/s1.md": lines("tiny", 5),
      ".claude/rules/s2.md": lines("tiny", 5),
    });

    expect(findingsOf(await scan([projectRoot(dir)]), "CFG-DUP-002")).toEqual([]);
  });

  it("ignores lines inside code fences and frontmatter", async () => {
    const dir = tempDir();
    const fenced = `\`\`\`\n${lines("code", 20)}\`\`\`\n`;
    writeTree(dir, { ".claude/rules/a.md": `${fenced}Unique A closing sentence here.\n`, ".claude/rules/b.md": `${fenced}Unique B closing sentence here.\n` });

    expect(findingsOf(await scan([projectRoot(dir)]), "CFG-DUP-002")).toEqual([]);
  });
});

describe("scope overlap", () => {
  it("flags the same rule, agent or skill path in both scopes, but not the CLAUDE.md pair", async () => {
    const base = tempDir();
    writeTree(join(base, "u"), { "CLAUDE.md": "User level.\n", "rules/style.md": "User style rule text.\n", "agents/x.md": agentFile("name: x\ndescription: user"), "rules/only-user.md": "Only here.\n" });
    writeTree(join(base, "p"), { "CLAUDE.md": "Project level.\n", ".claude/rules/style.md": "Project style rule text, different.\n", ".claude/agents/x.md": agentFile("name: x\ndescription: user") });
    const inv = await scan([userRoot(join(base, "u")), projectRoot(join(base, "p"))]);

    const found = findingsOf(inv, "CFG-SCOPE-001");
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.evidence["sameContent"]).sort()).toEqual([false, true]);
    expect(found.every((f) => f.confidence === "medium")).toBe(true);
    expect(found[0]?.limitations).toMatch(/not verified/);
  });

  it("flags rules declaring exactly the same path patterns, in any order", async () => {
    const dir = tempDir();
    writeTree(dir, {
      ".claude/rules/a.md": "---\npaths:\n  - src/**/*.ts\n  - tests/**\n---\nRule A body.\n",
      ".claude/rules/b.md": "---\npaths: [tests/**, src/**/*.ts]\n---\nRule B body.\n",
      ".claude/rules/c.md": "---\npaths:\n  - src/**/*.ts\n---\nRule C body.\n",
    });
    const found = findingsOf(await scan([projectRoot(dir)]), "CFG-SCOPE-002");

    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toEqual({ fileCount: 2, globCount: 2 });
  });
});

describe("possibly opposing instructions", () => {
  it("pairs always/never lines with identical remainders and reports file line numbers", async () => {
    const dir = tempDir();
    writeTree(dir, {
      "CLAUDE.md": "# Style\n\n- Always use tabs for indentation.\n- Prefer short functions please.\n",
      ".claude/rules/fmt.md": "---\npaths:\n  - src/**\n---\nNotes first.\nNever use tabs for indentation!\n",
      ".claude/rules/other.md": "Don't use tabs for indentation.\nAlways test.\nNever test.\n",
    });
    const found = findingsOf(await scan([projectRoot(dir)]), "CFG-CONF-001");

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ confidence: "low", severity: "medium", evidence: { alwaysLine: 3, neverCount: 2, remainderWords: 4, sameFile: false } });
    expect(found[0]?.evidence["neverLine"]).toBeGreaterThan(0);
    expect(found[0]?.limitations).toMatch(/false positive/);
  });

  it("raises confidence when both lines are in one file and ignores code fences", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "Always commit the lockfile changes.\nNever commit the lockfile changes.\n```\nAlways run the slow suite now.\nNever run the slow suite now.\n```\n" });
    const found = findingsOf(await scan([projectRoot(dir)]), "CFG-CONF-001");

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ confidence: "medium", relatedSourceId: null, evidence: { sameFile: true, alwaysLine: 1, neverLine: 2 } });
  });

  it("does not report different remainders or unrelated lines", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "Always use tabs for indentation.\nNever use spaces for indentation.\nYou must always write tests first.\n" });

    expect(findingsOf(await scan([projectRoot(dir)]), "CFG-CONF-001")).toEqual([]);
  });
});

describe("finding contract", () => {
  it("gives every finding a stable rule, severity, confidence, structural evidence, limitations and recommendation", async () => {
    const base = tempDir();
    const body = `${"Repeated guidance text goes here for sizing. ".repeat(8)}\n`;
    writeTree(join(base, "p"), {
      "CLAUDE.md": `${body}Always use tabs for indentation.\nNever use tabs for indentation.\n@missing.md\n`,
      ".claude/rules/a.md": body,
      ".claude/agents/bad.md": "no frontmatter\n",
      ".claude/settings.json": "{oops",
    });
    const inv = await scan([projectRoot(join(base, "p"))], { limits: { largeLines: 2 } });

    expect(inv.findings.length).toBeGreaterThan(5);
    for (const f of inv.findings) {
      expect(Object.keys(RULES)).toContain(f.ruleId);
      expect(["info", "low", "medium", "high"]).toContain(f.severity);
      expect(["high", "medium", "low"]).toContain(f.confidence);
      expect(isSafeEvidence(f.evidence)).toBe(true);
      expect(f.limitations.length).toBeGreaterThan(20);
      expect(f.recommendation.length).toBeGreaterThan(10);
      expect(f.key).toMatch(/^[0-9a-f]{24}$/);
    }
    expect(new Set(inv.findings.map((f) => f.key)).size).toBe(inv.findings.length);
  });

  it("never claims causal savings, and only mentions loading in negated or conditional terms", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "x\n".repeat(400), ".claude/agents/a.md": agentFile("name: a\ndescription: d") });
    const findings = (await scan([projectRoot(dir)])).findings;
    const sentences = findings.flatMap((f) => `${f.limitations} ${f.recommendation}`.split(/(?<=[.!?])\s+/));

    expect(sentences.filter((t) => /will (save|reduce|cut)|saves \d|reduces .* by \d/i.test(t))).toEqual([]);
    const loaded = sentences.filter((t) => /\bloaded?\b|\bloads?\b/i.test(t));
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((t) => !/\b(not|no|cannot|unknown|unmeasured|unverified|whether|depends|never)\b/i.test(t))).toEqual([]);
  });

  it("produces the same findings for the same structure in different locations", async () => {
    const make = async () => {
      const dir = tempDir();
      writeTree(dir, { "CLAUDE.md": "Always use tabs for indentation.\nSee @a.md\n", "a.md": "Never use tabs for indentation.\nBack @b.md\n", "b.md": "Again @a.md\n", ".claude/rules/r.md": lines("same", 12), ".claude/agents/g.md": lines("same", 12) });
      return (await scan([projectRoot(dir)])).findings.map((f) => [f.ruleId, f.confidence, JSON.stringify(f.evidence)].join("|")).sort();
    };

    expect(await make()).toEqual(await make());
  });

  it("keeps identical finding keys across repeated scans of the same tree", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "@gone.md\n", ".claude/agents/x.md": "bare\n" });
    const first = (await scan([projectRoot(dir)])).findings.map((f) => f.key);
    const second = (await scan([projectRoot(dir)])).findings.map((f) => f.key);

    expect(second).toEqual(first);
    expect(fileOf(await scan([projectRoot(dir)]), "x.md").sourceId).toMatch(/^cfg_/);
  });
});
