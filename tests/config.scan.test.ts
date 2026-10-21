import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanConfig } from "@/core/config";
import { SALT, VALID_AGENT, VALID_SKILL, agentFile, countBy, fileOf, findingsOf, projectRoot, scan, treeDigest, userRoot, writeTree } from "./config-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

function layout() {
  const base = tempDir();
  const user = join(base, "home", ".claude");
  const project = join(base, "proj");
  writeTree(user, {
    "CLAUDE.md": "# Personal\n- Prefer concise answers.\n",
    "settings.json": '{"model":"sonnet"}',
    "rules/style.md": "Prefer small functions in all modules.\n",
    "agents/reviewer.md": VALID_AGENT,
    "skills/pdf/SKILL.md": VALID_SKILL,
    "commands/ignored.md": "not part of the supported layout\n",
    "notes.txt": "ignored\n",
  });
  writeTree(project, {
    "CLAUDE.md": "# Project\nUse the build script.\n",
    "CLAUDE.local.md": "Local notes live here.\n",
    ".claude/settings.json": "{}",
    ".claude/settings.local.json": "{}",
    ".claude/rules/api.md": "API handlers validate their input.\n",
    ".claude/rules/nested/deep.md": "Nested rules are found too.\n",
    ".claude/agents/helper.md": agentFile("name: helper\ndescription: Helps"),
    ".claude/skills/lint/SKILL.md": agentFile("name: lint\ndescription: Lints"),
    ".claude/commands/x.md": "unsupported\n",
    "docs/readme.md": "not configuration\n",
  });
  return { base, user, project };
}

describe("scopes and layout", () => {
  it("inventories user and project scopes separately and ignores unsupported locations", async () => {
    const { user, project } = layout();
    const inv = await scan([userRoot(user), projectRoot(project)]);

    expect(inv.status).toBe("complete");
    expect(countBy(inv)).toEqual({
      "user:claude_md": 1, "user:settings": 1, "user:rule": 1, "user:agent": 1, "user:skill": 1,
      "project:claude_md": 2, "project:settings": 2, "project:rule": 2, "project:agent": 1, "project:skill": 1,
    });
    expect(inv.files.some((f) => ["ignored.md", "notes.txt", "x.md", "readme.md"].includes(f.label ?? ""))).toBe(false);
  });

  it("scans only the roots it is given", async () => {
    const { user, project } = layout();

    expect(Object.keys(countBy(await scan([userRoot(user)]))).every((k) => k.startsWith("user:"))).toBe(true);
    expect(Object.keys(countBy(await scan([projectRoot(project)]))).every((k) => k.startsWith("project:"))).toBe(true);
  });

  it("does not assume paths exist: a missing root is reported, the rest still scanned", async () => {
    const { base, project } = layout();
    const inv = await scan([userRoot(join(base, "nope")), projectRoot(project)]);

    expect(inv.status).toBe("partial");
    expect(inv.roots).toEqual([{ kind: "user-config", status: "unavailable", errorCode: "ENOENT" }, { kind: "project", status: "ok", errorCode: null }]);
    expect(inv.files.length).toBeGreaterThan(0);
  });

  it("reports failed when every root is unavailable, and rejects relative roots", async () => {
    const inv = await scan([userRoot("relative/dir"), projectRoot(join(tempDir(), "gone"))]);

    expect(inv.status).toBe("failed");
    expect(inv.files).toEqual([]);
    expect(inv.roots.map((r) => r.status)).toEqual(["unavailable", "unavailable"]);
  });

  it("handles a project with only a CLAUDE.md", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "Only this.\n" });

    expect(countBy(await scan([projectRoot(dir)]))).toEqual({ "project:claude_md": 1 });
  });

  it("records size, line count, estimated tokens and a keyed content hash", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "abcd\r\nefgh\r\n", ".claude/rules/a.md": "no trailing newline", ".claude/rules/b.md": "" });
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ sizeBytes: 12, lineCount: 2, estimatedTokens: 3 });
    expect(fileOf(inv, "a.md")).toMatchObject({ lineCount: 1, estimatedTokens: 5 });
    expect(fileOf(inv, "b.md")).toMatchObject({ sizeBytes: 0, lineCount: 0, estimatedTokens: 0 });
    expect(fileOf(inv, "CLAUDE.md").contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fileOf(inv, "CLAUDE.md").sourceId).toMatch(/^cfg_[0-9a-f]{12}$/);
  });
});

describe("frontmatter and metadata", () => {
  async function agents(files: Record<string, string>) {
    const dir = tempDir();
    writeTree(join(dir, ".claude/agents"), files);
    const inv = await scan([projectRoot(dir)]);
    const meta = (label: string) => findingsOf(inv, "CFG-META-001").concat(findingsOf(inv, "CFG-META-002"), findingsOf(inv, "CFG-META-003")).filter((f) => f.sourceId === fileOf(inv, label).sourceId);
    return { inv, meta };
  }

  it("accepts valid frontmatter and stores only safe metadata", async () => {
    const { inv, meta } = await agents({ "ok.md": VALID_AGENT });

    expect(fileOf(inv, "ok.md")).toMatchObject({ frontmatterState: "valid", metadata: { name: "reviewer", descriptionLength: 12, toolCount: 2, model: "sonnet" } });
    expect(meta("ok.md")).toEqual([]);
  });

  it("parses block lists, CRLF frontmatter and quoted values", async () => {
    const { inv, meta } = await agents({
      "block.md": agentFile("name: 'blocky'\ndescription: \"Quoted text\"\ntools:\n  - Read\n  - Grep\n  - Bash"),
      "crlf.md": "---\r\nname: crlf\r\ndescription: Works\r\n---\r\nBody.\r\n",
    });

    expect(fileOf(inv, "block.md").metadata).toMatchObject({ name: "blocky", toolCount: 3 });
    expect(fileOf(inv, "crlf.md").frontmatterState).toBe("valid");
    expect([...meta("block.md"), ...meta("crlf.md")]).toEqual([]);
  });

  it("reads literal and folded block scalars as valid text, storing only their length", async () => {
    const { inv, meta } = await agents({
      "literal.md": agentFile("name: lit\ndescription: |\n  CANARY_DESC_TEXT_2e90\n  second line\nmodel: sonnet"),
      "folded.md": agentFile("name: fold\ndescription: >\n  first part\n  second part"),
    });

    expect(fileOf(inv, "literal.md")).toMatchObject({ frontmatterState: "valid", metadata: { name: "lit", descriptionLength: 33, model: "sonnet" } });
    expect(fileOf(inv, "folded.md").metadata).toMatchObject({ name: "fold", descriptionLength: 22 });
    expect([...meta("literal.md"), ...meta("folded.md")]).toEqual([]);
    expect(JSON.stringify(inv)).not.toContain("CANARY_DESC_TEXT_2e90");
  });

  it("reports missing required fields with the field name and reason", async () => {
    const { meta } = await agents({ "nodesc.md": agentFile("name: nodesc"), "bare.md": "No frontmatter at all.\n" });

    expect(meta("nodesc.md").map((f) => f.evidence)).toEqual([{ field: "description", reason: "missing" }]);
    const bare = meta("bare.md");
    expect(bare.every((f) => f.ruleId === "CFG-META-002")).toBe(true);
    expect(bare.map((f) => f.evidence).sort((a, b) => String(a["field"]).localeCompare(String(b["field"])))).toEqual([
      { field: "description", reason: "no-frontmatter" },
      { field: "name", reason: "no-frontmatter" },
    ]);
  });

  it("reports malformed frontmatter without guessing", async () => {
    const { inv, meta } = await agents({
      "open.md": "---\nname: open\ndescription: never closed\n",
      "line.md": agentFile("name: line\ndescription: ok\nthis is not a key value line"),
      "dup.md": agentFile("name: a\nname: b\ndescription: d"),
      "nested.md": agentFile("name: n\ndescription: d\ntools:\n  nested: map"),
    });

    expect(meta("open.md").map((f) => f.evidence)).toEqual([{ field: "frontmatter", reason: "unterminated" }]);
    expect(meta("line.md")[0]?.evidence).toEqual({ field: "frontmatter", reason: "unparseable-line" });
    expect(meta("dup.md")[0]?.evidence).toEqual({ field: "frontmatter", reason: "duplicate-key" });
    expect(meta("nested.md")[0]?.ruleId).toBe("CFG-META-001");
    expect(fileOf(inv, "open.md").frontmatterState).toBe("malformed");
  });

  it("flags invalid values and never stores an invalid name", async () => {
    const { inv, meta } = await agents({
      "badname.md": agentFile("name: Bad Name!\ndescription: d"),
      "badmodel.md": agentFile("name: bm\ndescription: d\nmodel: has spaces!!"),
      "flowmap.md": agentFile("name: fm\ndescription: {a: b}"),
    });

    expect(meta("badname.md").map((f) => f.evidence)).toEqual([{ field: "name", reason: "bad-format" }]);
    expect(fileOf(inv, "badname.md").metadata.name).toBeUndefined();
    expect(meta("badmodel.md").map((f) => f.evidence)).toEqual([{ field: "model", reason: "bad-format" }]);
    expect(meta("flowmap.md").map((f) => f.evidence)).toEqual([{ field: "description", reason: "not-a-string" }]);
  });

  it("validates skills and conditional rules", async () => {
    const dir = tempDir();
    writeTree(dir, {
      ".claude/skills/long/SKILL.md": agentFile(`name: long\ndescription: ${"x".repeat(1100)}`),
      ".claude/rules/scoped.md": "---\npaths:\n  - 'src/**/*.ts'\n  - tests/**\n---\nRule body line.\n",
      ".claude/rules/empty.md": "---\npaths:\n---\nRule body line.\n",
      ".claude/rules/plain.md": "Rule without frontmatter.\n",
    });
    const inv = await scan([projectRoot(dir)]);

    expect(findingsOf(inv, "CFG-META-003").map((f) => f.evidence)).toEqual(
      expect.arrayContaining([{ field: "description", reason: "too-long" }, { field: "paths", reason: "not-a-list" }]),
    );
    expect(fileOf(inv, "scoped.md")).toMatchObject({ metadata: { pathGlobCount: 2 }, activation: "conditional" });
    expect(fileOf(inv, "plain.md").activation).toBe("unverified-candidate");
  });
});

describe("size limits", () => {
  it("flags large and very large files using estimates, and says nothing about savings", async () => {
    const dir = tempDir();
    writeTree(dir, {
      "CLAUDE.md": "tiny\n",
      ".claude/rules/big.md": `${"line of text here\n".repeat(1000)}`,
      ".claude/rules/huge.md": `${"line of text here\n".repeat(3000)}`,
    });
    const inv = await scan([projectRoot(dir)]);

    const large = findingsOf(inv, "CFG-SIZE-001");
    const veryLarge = findingsOf(inv, "CFG-SIZE-002");
    expect(large.map((f) => f.sourceId)).toEqual([fileOf(inv, "big.md").sourceId]);
    expect(veryLarge.map((f) => f.sourceId)).toEqual([fileOf(inv, "huge.md").sourceId]);
    expect(large[0]?.evidence).toMatchObject({ estimatedTokens: 4500, lines: 1000, trigger: "both" });
    expect(large[0]?.confidence).toBe("medium");
    expect(large[0]?.limitations).toMatch(/estimate/i);
    expect(large[0]?.recommendation).toMatch(/No saving is claimed/);
  });

  it("honors configured thresholds and triggers on line count alone", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "a\n".repeat(12) });
    const inv = await scan([projectRoot(dir)], { limits: { largeLines: 10, largeTokens: 100000, veryLargeTokens: 200000 } });

    expect(findingsOf(inv, "CFG-SIZE-001")[0]?.evidence).toMatchObject({ trigger: "lines", lines: 12 });
  });

  it("skips files above the byte limit without reading them", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": `CANARY_CFG_BODY_41af ${"x".repeat(500)}` });
    const inv = await scan([projectRoot(dir)], { limits: { maxFileBytes: 100 } });

    expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ status: "skipped", errorCode: "TOO_LARGE", sizeBytes: 521, contentHash: null, lineCount: 0 });
    expect(findingsOf(inv, "CFG-SIZE-003")[0]?.evidence).toEqual({ sizeBytes: 521, limitBytes: 100 });
    expect(JSON.stringify(inv)).not.toContain("CANARY_CFG_BODY_41af");
  });

  it("skips binary content", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "text\u0000binary" });
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ status: "skipped", errorCode: "BINARY" });
    expect(findingsOf(inv, "CFG-FS-001")[0]?.evidence).toEqual({ reason: "binary" });
  });

  it("reports the scan limit instead of silently truncating", async () => {
    const dir = tempDir();
    writeTree(dir, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`.claude/rules/r${i}.md`, `Rule ${i} body text.\n`])));
    const inv = await scan([projectRoot(dir)], { limits: { maxFiles: 4 } });

    expect(inv.files).toHaveLength(4);
    expect(findingsOf(inv, "CFG-SCAN-001")[0]?.evidence).toEqual({ limit: 4 });
  });
});

describe("settings analysis (structure only)", () => {
  const SETTINGS = JSON.stringify({
    model: "sonnet",
    mystery: 1,
    env: { TOKEN: "CANARY_ENV_VALUE_c0de", OTHER: "x" },
    permissions: { allow: ["Bash(CANARY_PERM_RULE_88b1:*)"], deny: [], ask: ["Read"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "CANARY_HOOK_CMD_5d2e one" }, { type: "command", command: "other" }] }],
      WeirdEvent: [{ hooks: [] }],
    },
  });

  it("extracts counts and known key names only", async () => {
    const dir = tempDir();
    writeTree(dir, { ".claude/settings.json": SETTINGS });
    const inv = await scan([projectRoot(dir)]);

    expect(fileOf(inv, "settings.json").detail).toEqual({
      knownKeys: ["permissions", "hooks", "env", "model"],
      unknownKeyCount: 1,
      permissions: { allow: 1, deny: 0, ask: 1 },
      hooks: { PreToolUse: { matchers: 1, hooks: 2, commandHooks: 2 } },
      unknownHookEvents: 1,
      envKeyCount: 2,
    });
    for (const canary of ["CANARY_ENV_VALUE_c0de", "CANARY_PERM_RULE_88b1", "CANARY_HOOK_CMD_5d2e"]) expect(JSON.stringify(inv)).not.toContain(canary);
  });

  it("reports invalid JSON, non-object roots and documents nested beyond the depth limit", async () => {
    const dir = tempDir();
    const deep = `${'{"a":'.repeat(40)}1${"}".repeat(40)}`;
    writeTree(dir, { ".claude/settings.json": "{not json", ".claude/settings.local.json": "[1,2]", "CLAUDE.md": "x\n" });
    const inv = await scan([projectRoot(dir)]);
    writeTree(dir, { ".claude/settings.local.json": deep });
    const deepInv = await scan([projectRoot(dir)]);

    expect(findingsOf(inv, "CFG-SET-001").map((f) => f.evidence).sort((a, b) => String(a["reason"]).localeCompare(String(b["reason"])))).toEqual([{ reason: "invalid-json" }, { reason: "invalid-shape" }]);
    expect(findingsOf(deepInv, "CFG-SET-001").map((f) => f.evidence)).toContainEqual({ reason: "too-deep" });
  });

  it("flags a permission both allowed and denied, with confidence by locality", async () => {
    const dir = tempDir();
    const user = join(dir, "u");
    writeTree(join(dir, "p"), { ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)", "Read"], deny: ["Bash(ls)"] } }) });
    writeTree(user, { "settings.json": JSON.stringify({ permissions: { deny: ["Read"] } }) });
    const inv = await scan([userRoot(user), projectRoot(join(dir, "p"))]);

    const found = findingsOf(inv, "CFG-CONF-002");
    expect(found.map((f) => `${f.confidence}:${String(f.evidence["sameFile"])}:${String(f.evidence["overlappingRules"])}`).sort()).toEqual(["high:true:1", "medium:false:1"]);
  });

  it("flags duplicate hook commands without exposing the command", async () => {
    const dir = tempDir();
    const hook = { PostToolUse: [{ hooks: [{ type: "command", command: "CANARY_HOOK_CMD_5d2e" }] }, { hooks: [{ type: "command", command: "CANARY_HOOK_CMD_5d2e" }] }] };
    writeTree(dir, { ".claude/settings.json": JSON.stringify({ hooks: hook }) });
    const inv = await scan([projectRoot(dir)]);

    expect(findingsOf(inv, "CFG-HOOK-001")).toHaveLength(1);
    expect(findingsOf(inv, "CFG-HOOK-001")[0]).toMatchObject({ confidence: "high", evidence: { occurrences: 2, files: 1 } });
    expect(JSON.stringify(inv)).not.toContain("CANARY_HOOK_CMD_5d2e");
  });
});

describe("activation is never claimed", () => {
  it("uses only non-loaded statuses and explains every non-candidate", async () => {
    const { user, project } = layout();
    writeTree(project, { "CLAUDE.md": "See @docs/readme.md for the guide.\n" });
    const inv = await scan([userRoot(user), projectRoot(project)]);
    const allowed = new Set(["unverified-candidate", "conditional", "on-demand", "import-only", "unknown"]);

    expect(inv.files.every((f) => allowed.has(f.activation))).toBe(true);
    expect(fileOf(inv, "reviewer.md").activation).toBe("on-demand");
    expect(fileOf(inv, "SKILL.md", "user").activationBasis).toBe("on-demand-skill");
    expect(fileOf(inv, "readme.md").activation).toBe("import-only");
    expect(fileOf(inv, "CLAUDE.md", "user").activation).toBe("unverified-candidate");
    const flagged = new Set(findingsOf(inv, "CFG-ACT-001").map((f) => f.sourceId));
    expect(inv.files.filter((f) => f.activation !== "unverified-candidate").every((f) => flagged.has(f.sourceId))).toBe(true);
    expect(inv.files.filter((f) => f.activation === "unverified-candidate").some((f) => flagged.has(f.sourceId))).toBe(false);
  });
});

describe("read-only and deterministic", () => {
  it("leaves every file, directory and mtime untouched", async () => {
    const { base, user, project } = layout();
    writeTree(base, { "outside.md": "CANARY_OUTSIDE_FILE_7710\n" });
    const before = treeDigest(base);
    await scan([userRoot(user), projectRoot(project)]);
    await scan([userRoot(user), projectRoot(project)]);

    expect(treeDigest(base)).toEqual(before);
  });

  it("produces identical inventories on repeated scans and for any root order", async () => {
    const { user, project } = layout();
    writeTree(project, { "CLAUDE.md": "Dup line one here.\n@docs/readme.md\n" });
    const first = await scan([userRoot(user), projectRoot(project)]);
    const again = await scan([userRoot(user), projectRoot(project)]);
    const reversed = await scan([projectRoot(project), userRoot(user)]);

    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(JSON.stringify({ ...reversed, roots: [] })).toBe(JSON.stringify({ ...first, roots: [] }));
  });

  it("changes identifiers with the salt but not the findings' shape", async () => {
    const { project } = layout();
    const a = await scan([projectRoot(project)]);
    const b = await scanConfig([projectRoot(project)], { salt: Buffer.alloc(32, 9), includeLabels: true });

    expect(b.files.map((f) => f.sourceId)).not.toEqual(a.files.map((f) => f.sourceId));
    expect(b.findings.map((f) => f.ruleId).sort()).toEqual(a.findings.map((f) => f.ruleId).sort());
    expect(SALT).toHaveLength(32);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable file as EACCES with a code, not a message", async () => {
    const dir = tempDir();
    writeTree(dir, { "CLAUDE.md": "secret-ish\n" });
    chmodSync(join(dir, "CLAUDE.md"), 0o000);
    try {
      const inv = await scan([projectRoot(dir)]);
      expect(fileOf(inv, "CLAUDE.md")).toMatchObject({ status: "skipped", errorCode: "EACCES" });
      expect(JSON.stringify(inv)).not.toContain(dir);
    } finally {
      chmodSync(join(dir, "CLAUDE.md"), 0o600);
    }
  });
});
