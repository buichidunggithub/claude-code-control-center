import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countBy, fileOf, findingsOf, projectRoot, scan, treeDigest, userRoot, writeTree } from "./config-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const edgesOf = (inv: Awaited<ReturnType<typeof scan>>, label: string) =>
  inv.imports.filter((e) => e.sourceId === fileOf(inv, label).sourceId).sort((a, b) => a.line - b.line);

describe("import extraction and resolution", () => {
  const CLAUDE = [
    "See @docs/guide.md for details.",
    "Also @docs/missing.md here.",
    "Mention @someone and mail a@b.com about it.",
    "Inline `@docs/inline.md` is code.",
    "```",
    "@docs/fenced.md",
    "```",
    "Home notes @~/notes.md are unresolvable.",
    "Outside @../outside.md must not be read.",
    "Absolute @/etc/hosts must not be read.",
    "Trailing punctuation is trimmed: @docs/guide.md.",
  ].join("\n");

  async function project() {
    const base = tempDir();
    const dir = join(base, "proj");
    writeTree(dir, { "CLAUDE.md": `${CLAUDE}\n`, "docs/guide.md": "Guide text.\n", "docs/inline.md": "inline\n", "docs/fenced.md": "fenced\n" });
    writeTree(base, { "outside.md": "CANARY_OUTSIDE_FILE_7710\n" });
    return { base, dir, inv: await scan([projectRoot(dir)]) };
  }

  it("resolves only unambiguous imports and ignores mentions, emails, code and fences", async () => {
    const { inv } = await project();

    expect(edgesOf(inv, "CLAUDE.md").map((e) => [e.line, e.status])).toEqual([
      [1, "resolved"], [2, "broken"], [8, "unresolvable"], [9, "outside-roots"], [10, "outside-roots"], [11, "resolved"],
    ]);
  });

  it("inventories an imported file as import-only, with its depth, and reports broken imports", async () => {
    const { inv } = await project();

    expect(fileOf(inv, "guide.md")).toMatchObject({ category: "imported", activation: "import-only", importDepth: 1, scope: "project" });
    expect(findingsOf(inv, "CFG-IMP-001").map((f) => f.evidence["line"])).toEqual([2]);
    expect(findingsOf(inv, "CFG-IMP-001")[0]?.confidence).toBe("medium");
    expect(inv.files.some((f) => f.label === "inline.md" || f.label === "fenced.md")).toBe(false);
  });

  it("never reads files outside the roots, including absolute and ../ imports", async () => {
    const { inv } = await project();

    expect(findingsOf(inv, "CFG-IMP-002").map((f) => f.evidence["line"]).sort()).toEqual([10, 9]);
    expect(inv.files.some((f) => f.label === "outside.md" || f.label === "hosts")).toBe(false);
    expect(JSON.stringify(inv)).not.toContain("CANARY_OUTSIDE_FILE_7710");
  });

  it("extracts imports from rule files and resolves to an already inventoried file without duplicating it", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "Rules: @.claude/rules/api.md\n", ".claude/rules/api.md": "Rule text. @../../docs/extra.md\n", "docs/extra.md": "extra\n" });
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "api.md").category).toBe("rule");
    expect(inv.files.filter((f) => f.label === "api.md")).toHaveLength(1);
    expect(edgesOf(inv, "CLAUDE.md")[0]).toMatchObject({ status: "resolved", targetSourceId: fileOf(inv, "api.md").sourceId });
    expect(edgesOf(inv, "api.md")[0]?.status).toBe("resolved");
  });

  it("detects cycles, including a self import, and reports each back edge once", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "Start @a.md and self @CLAUDE.md\n", "a.md": "To b @b.md\n", "b.md": "Back to a @a.md\n" });
    const inv = await scan([projectRoot(dir)]);

    expect(inv.imports.filter((e) => e.status === "cycle")).toHaveLength(2);
    expect(findingsOf(inv, "CFG-IMP-003")).toHaveLength(2);
    expect(edgesOf(inv, "b.md")[0]?.status).toBe("cycle");
    expect(findingsOf(inv, "CFG-IMP-003").every((f) => f.confidence === "high")).toBe(true);
  });

  it("stops following imports past the depth limit and does not read deeper files", async () => {
    const dir = tempDir();
    const files: Record<string, string> = { "CLAUDE.md": "@d1.md\n" };
    for (let i = 1; i <= 7; i += 1) files[`d${i}.md`] = `Level ${i} CANARY_CFG_BODY_41af${i}. @d${i + 1}.md\n`;
    writeTree(dir, files);
    const inv = await scan([projectRoot(dir)]);

    expect(inv.files.filter((f) => f.category === "imported").map((f) => f.importDepth).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(findingsOf(inv, "CFG-IMP-004")).toHaveLength(1);
    expect(findingsOf(inv, "CFG-IMP-004")[0]?.evidence).toMatchObject({ depth: 6, maxDepth: 5 });
    expect(inv.files.some((f) => f.label === "d6.md")).toBe(false);
  });

  it("caps imported files and marks the rest skipped", async () => {
    const dir = tempDir();
    const files: Record<string, string> = { "CLAUDE.md": Array.from({ length: 5 }, (_, i) => `@docs/i${i}.md`).join("\n") };
    for (let i = 0; i < 5; i += 1) files[`docs/i${i}.md`] = `Doc ${i}\n`;
    writeTree(dir, files);
    const inv = await scan([projectRoot(dir)], { limits: { maxImportedFiles: 3 } });

    expect(inv.files.filter((f) => f.category === "imported")).toHaveLength(3);
    expect(inv.imports.filter((e) => e.status === "skipped")).toHaveLength(2);
  });

  it("treats a directory or oversize target as skipped, not broken", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "@docs/folder.md and @big.md\n", "docs/folder.md/x.txt": "x", "big.md": "x".repeat(300) });
    const inv = await scan([projectRoot(dir)], { limits: { maxFileBytes: 200 } });

    expect(edgesOf(inv, "CLAUDE.md").map((e) => e.status).sort()).toEqual(["skipped", "skipped"]);
    expect(findingsOf(inv, "CFG-IMP-001")).toEqual([]);
  });
});

describe("symlinks and traversal", () => {
  function tree() {
    const base = tempDir();
    const proj = join(base, "proj");
    const outside = join(base, "outside");
    writeTree(outside, { "secret.md": "CANARY_OUTSIDE_FILE_7710 secret text\n", "agents/a.md": "outside agent\n", "settings.json": '{"model":"CANARY_SECRET_TOKEN_7b13"}' });
    writeTree(proj, { "CLAUDE.md": "Project instructions.\n", ".claude/rules/real.md": "Real rule inside.\n" });
    return { base, proj, outside };
  }
  const link = (target: string, path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(target, path);
  };

  it("refuses a file symlink that points outside the roots, without opening it", async () => {
    const { proj, outside } = tree();
    link(join(outside, "secret.md"), join(proj, ".claude/rules/leak.md"));
    const inv = await scan([projectRoot(proj)]);

    expect(fileOf(inv, "leak.md")).toMatchObject({ status: "skipped", errorCode: "OUTSIDE_ROOTS", sizeBytes: 0, contentHash: null });
    expect(findingsOf(inv, "CFG-FS-001").map((f) => f.evidence)).toEqual([{ reason: "outside-roots" }]);
    expect(JSON.stringify(inv)).not.toContain("CANARY_OUTSIDE_FILE_7710");
  });

  it("refuses a symlinked layout directory that points outside and never lists it", async () => {
    const { proj, outside } = tree();
    link(join(outside, "agents"), join(proj, ".claude/agents"));
    const inv = await scan([projectRoot(proj)]);

    expect(inv.files.filter((f) => f.category === "agent")).toHaveLength(1);
    expect(inv.files.find((f) => f.category === "agent")).toMatchObject({ status: "skipped", errorCode: "OUTSIDE_ROOTS" });
    expect(inv.files.some((f) => f.label === "a.md")).toBe(false);
  });

  it("refuses a symlinked skill directory and a symlinked settings file that leave the roots", async () => {
    const { proj, outside } = tree();
    link(outside, join(proj, ".claude/skills/evil"));
    link(join(outside, "settings.json"), join(proj, ".claude/settings.json"));
    const inv = await scan([projectRoot(proj)]);

    expect(inv.files.filter((f) => f.status === "skipped").map((f) => f.category).sort()).toEqual(["settings", "skill"]);
    expect(JSON.stringify(inv)).not.toContain("CANARY_SECRET_TOKEN_7b13");
  });

  it("follows a symlink that stays inside the roots exactly once", async () => {
    const { proj } = tree();
    link(join(proj, ".claude/rules/real.md"), join(proj, ".claude/rules/alias.md"));
    const inv = await scan([projectRoot(proj)]);

    expect(inv.files.filter((f) => f.category === "rule")).toHaveLength(1);
    expect(inv.files.filter((f) => f.category === "rule")[0]?.status).toBe("ok");
  });

  it("survives a symlink loop and a directory loop", async () => {
    const { proj } = tree();
    link(join(proj, ".claude/rules/loop.md"), join(proj, ".claude/rules/loop.md"));
    link(join(proj, ".claude/rules"), join(proj, ".claude/rules/sub"));
    const inv = await scan([projectRoot(proj)]);

    expect(fileOf(inv, "loop.md")).toMatchObject({ status: "skipped", errorCode: "SYMLINK_LOOP" });
    expect(inv.files.filter((f) => f.label === "real.md")).toHaveLength(1);
  });

  it("accepts a root given as a symlink and canonicalizes it to the same identifiers", async () => {
    const { base, proj } = tree();
    link(proj, join(base, "proj-link"));
    const direct = await scan([projectRoot(proj)]);
    const viaLink = await scan([projectRoot(join(base, "proj-link"))]);

    expect(viaLink.files.map((f) => f.sourceId)).toEqual(direct.files.map((f) => f.sourceId));
  });

  it("refuses an import whose symlink target is outside, although its path looks inside", async () => {
    const { proj, outside } = tree();
    link(join(outside, "secret.md"), join(proj, "docs/ext.md"));
    writeTree(proj, { "CLAUDE.md": "Import @docs/ext.md and @docs/../.claude/rules/real.md and @../../../../../../etc/passwd\n" });
    const inv = await scan([projectRoot(proj)]);

    expect(edgesOf(inv, "CLAUDE.md").map((e) => e.status).sort()).toEqual(["outside-roots", "outside-roots", "resolved"]);
    expect(JSON.stringify(inv)).not.toContain("CANARY_OUTSIDE_FILE_7710");
  });

  it("allows an import that crosses between two explicitly allowed roots", async () => {
    const base = tempDir();
    const user = join(base, "user");
    const proj = join(base, "proj");
    writeTree(user, { "shared.md": "Shared notes.\n" });
    writeTree(proj, { "CLAUDE.md": `Shared: @${user}/shared.md\n` });
    const inv = await scan([userRoot(user), projectRoot(proj)]);

    expect(edgesOf(inv, "CLAUDE.md")[0]?.status).toBe("resolved");
  });

  it("reports a directory named like a file as not a regular file", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md/inside.txt": "x" });
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ status: "skipped", errorCode: "NOT_REGULAR_FILE" });
  });

  it("leaves the whole tree, including the outside directory, untouched", async () => {
    const { base, proj, outside } = tree();
    link(join(outside, "secret.md"), join(proj, ".claude/rules/leak.md"));
    link(outside, join(proj, ".claude/skills/evil"));
    const before = treeDigest(base);
    await scan([projectRoot(proj)]);

    expect(treeDigest(base)).toEqual(before);
    expect(Object.keys(countBy(await scan([projectRoot(proj)]))).length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not list an unreadable directory's contents or fail the scan", async () => {
    const { proj } = tree();
    writeTree(proj, { ".claude/rules/hidden/x.md": "x\n" });
    chmodSync(join(proj, ".claude/rules/hidden"), 0o000);
    try {
      const inv = await scan([projectRoot(proj)]);
      expect(inv.status).toBe("complete");
      expect(inv.files.some((f) => f.label === "x.md")).toBe(false);
    } finally {
      chmodSync(join(proj, ".claude/rules/hidden"), 0o700);
    }
  });
});
