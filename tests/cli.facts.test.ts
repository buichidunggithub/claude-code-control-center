import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PROMPT_SIZE_FLAG, parseArgs } from "@/cli/args";
import { CliError, REJECTIONS } from "@/cli/codes";
import { HELP_TEXT } from "@/cli/help";
import { main } from "@/cli/main";
import { fileToken } from "@/cli/token";
import { IngestError, accountingStateCounts, accountingSummary, openStore, scanAndIngest } from "@/core/store";
import { projection, realTemp, registerCliCleanup, writeFile } from "./cli-helpers";

registerCliCleanup();

const CANARY_TEXT = ["CANARY_PROMPT_STR_aa11", "CANARY_PROMPT_BLK_bb22", "CANARY_RESULT_cc33", "CANARY_MIXED_dd44", "CANARY_ARGS_ee55"] as const;
const UNSAFE = ["mcp__CANARY_MCP_ff66__do", "CustomTool_CANARY_0a77", "toolu_RAW_1", "toolu_RAW_2", "sess-RAW-ID", "SECRET_DIR_NAME", "secret-file-name"] as const;
const FORBIDDEN = [...CANARY_TEXT, ...UNSAFE];

const user = (i: number, content: unknown) => ({ type: "user", uuid: `u${i}`, sessionId: "sess-RAW-ID", timestamp: "2026-05-01T10:00:00.000Z", message: { role: "user", content } });
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
const assistant = (i: number, content: unknown[], day = "2026-05-01") => ({
  type: "assistant", uuid: `a${i}`, sessionId: "sess-RAW-ID", timestamp: `${day}T10:00:0${i}.000Z`,
  message: { id: `m${i}`, role: "assistant", model: "model-alpha", content, usage },
});
const toolUse = (id: string | null, name: unknown) => ({ type: "tool_use", ...(id === null ? {} : { id }), name, input: { q: CANARY_TEXT[4] } });

function transcript(extra: readonly unknown[] = []): string {
  const events = [
    user(1, `${CANARY_TEXT[0]} typed text`),
    user(2, [{ type: "text", text: `${CANARY_TEXT[1]} block` }]),
    user(3, [{ type: "tool_result", tool_use_id: "toolu_RAW_1", content: CANARY_TEXT[2] }]),
    user(4, [{ type: "text", text: CANARY_TEXT[3] }, { type: "image", source: { data: CANARY_TEXT[3] } }]),
    assistant(5, [toolUse("toolu_RAW_1", "Read"), toolUse("toolu_RAW_2", UNSAFE[0]), toolUse(null, UNSAFE[1]), toolUse(null, "Bash")]),
    assistant(6, [{ type: "text", text: "ok" }]),
    ...extra,
  ];
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

interface Run { readonly code: number; readonly out: string; readonly err: string }
const sink = (chunks: string[]) => ({ write: (text: string, done?: (error?: Error | null) => void) => (chunks.push(text), done?.(null), true) });

async function cli(argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, sink(out), sink(err), () => import("@/cli/run"));
  return { code, out: out.join(""), err: err.join("") };
}

const tokenFor = (path: string) => fileToken(path, lstatSync(path, { bigint: true }));

function setup(text = transcript()) {
  const root = realTemp();
  const file = writeFile(join(root, "data"), "SECRET_DIR_NAME/secret-file-name.jsonl", text);
  return { root, file, db: join(root, "out", "usage.db") };
}

const ingest = (s: { file: string; db: string }, ...flags: string[]) =>
  cli(["run", "--db", s.db, "--token", tokenFor(s.file), ...flags, s.file]);

const rows = (db: string, sql: string) => {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    return raw.prepare(sql).all();
  } finally {
    raw.close();
  }
};
const edit = (db: string, sql: string) => {
  const raw = new DatabaseSync(db);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
};

const sizeStates = (db: string) => rows(db, "SELECT size_state AS s, COUNT(*) AS n FROM source_user_events GROUP BY s ORDER BY s");
const factRows = (db: string) => ({
  events: rows(db, "SELECT line_number, ts, day, is_sidechain, size_state FROM source_user_events ORDER BY line_number"),
  tools: rows(db, "SELECT line_number, block_index, tool_bucket, dedup, dedup_group_size, tool_id_fp IS NULL AS anon FROM tool_calls ORDER BY line_number, block_index"),
});

/** Everything that feeds usage views and settled totals. */
function usageView(db: string) {
  const store = openStore(db, { tightenExistingFile: false });
  try {
    return {
      projected: (projection(db) as { records: unknown; sessions: unknown }).records,
      records: store.db.prepare("SELECT * FROM usage_records ORDER BY id").all(),
      sessions: store.db.prepare("SELECT * FROM sessions ORDER BY id").all(),
      summary: accountingSummary(store.db),
      states: accountingStateCounts(store.db),
    };
  } finally {
    store.close();
  }
}

const dbBytes = (db: string): string => {
  const dir = join(db, "..");
  return readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
};

describe("help and argument parsing", () => {
  it("documents the scope, the repeat-to-refresh workflow and the opt-in, off by default", async () => {
    for (const argv of [["help"]]) {
      const r = await cli(argv);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out.trimEnd()).toBe(HELP_TEXT);
    }
    expect(HELP_TEXT).toContain("--prompt-size  (OFF by default)");
    expect(HELP_TEXT).toContain("Each run handles exactly ONE .jsonl file that you name");
    expect(HELP_TEXT).toContain("Nothing is discovered");
    expect(HELP_TEXT).toContain("A file you do not name is never touched. Nothing is deleted.");
    expect(HELP_TEXT).toContain("usage records and totals are left exactly as they are");
    expect(HELP_TEXT).toContain('Without this flag the content is never read and the state is "not-read"');
    expect(HELP_TEXT).toMatch(/Never stored, printed or logged: the text, an excerpt, a hash of it, or an exact length/);
    expect(REJECTIONS.USAGE.hint).toContain("[--prompt-size]");
  });

  it("rejects extra arguments to help with the usual usage code", async () => {
    for (const argv of [["help", "x"], ["--help"], ["preview", "--help"]]) {
      const r = await cli(argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^REJECTED \[(USAGE|INVALID_OPTION)\]/);
    }
  });

  it("accepts the flag only for run, once, without a value, in any position", () => {
    expect(PROMPT_SIZE_FLAG).toBe("--prompt-size");
    expect(parseArgs(["run", "--prompt-size", "--db", "/d/x.db", "--token", "t", "/a/b.jsonl"])).toEqual({ kind: "run", path: "/a/b.jsonl", db: "/d/x.db", token: "t", promptSize: true });
    expect(parseArgs(["run", "/a/b.jsonl", "--db", "/d/x.db", "--token", "t", "--prompt-size"])).toMatchObject({ promptSize: true });
    const plain = parseArgs(["run", "--db", "/d/x.db", "--token", "t", "/a/b.jsonl"]);
    expect(plain).not.toHaveProperty("promptSize");
    const code = (argv: string[]) => { try { parseArgs(argv); return null; } catch (e) { return e instanceof CliError ? e.code : "OTHER"; } };
    expect(code(["run", "--prompt-size", "--prompt-size", "/a/b.jsonl"])).toBe("DUPLICATE_OPTION");
    expect(code(["preview", "--prompt-size", "/a/b.jsonl"])).toBe("INVALID_OPTION");
    expect(code(["run", "--prompt-size=1", "/a/b.jsonl"])).toBe("INVALID_OPTION");
    expect(code(["run", "--db", "--prompt-size", "/a/b.jsonl"])).toBe("USAGE"); // a flag is not a value
  });

  it("does not let a flag-like value become the opt-in", () => {
    expect(parseArgs(["run", "--token", "t", "--db", "/d/x.db", "/a/--prompt-size.jsonl"])).not.toHaveProperty("promptSize");
  });
});

describe("default ingest does not read prompt content", () => {
  it("stores every user event as not-read and says so", async () => {
    const s = setup();
    const r = await ingest(s);

    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(sizeStates(s.db)).toEqual([{ s: "not-read", n: 4 }]);
    expect(r.out).toContain("Text size ....... not requested (content not read); states: not-read 4");
    expect(r.out).toContain("4 source-typed user events, 4 tool_use blocks");
    expect(r.out).toContain("collected or replaced for this file");
  });
});

describe("explicit --prompt-size", () => {
  it("records coarse buckets and `unsupported`, and no content, length, name or id leaks anywhere", async () => {
    const s = setup();
    const r = await ingest(s, "--prompt-size");

    expect(r.code).toBe(0);
    expect(sizeStates(s.db)).toEqual([{ s: "unsupported", n: 1 }, { s: "xs", n: 3 }].sort((a, b) => (a.s < b.s ? -1 : 1)));
    expect(r.out).toContain("requested (--prompt-size); states: unsupported 1, xs 3");

    const bytes = dbBytes(s.db);
    for (const needle of FORBIDDEN) {
      expect(r.out, needle).not.toContain(needle);
      expect(r.err, needle).not.toContain(needle);
      expect(bytes, needle).not.toContain(needle);
    }
    expect(JSON.stringify(factRows(s.db))).not.toMatch(/CANARY|mcp__|toolu_|sess-/);
  });

  it("stores only allowlisted names or generic buckets for tools", async () => {
    const s = setup();
    await ingest(s, "--prompt-size");
    expect(rows(s.db, "SELECT tool_bucket AS b, COUNT(*) AS n FROM tool_calls GROUP BY b ORDER BY b")).toEqual([
      { b: "Bash", n: 1 }, { b: "Read", n: 1 }, { b: "other", n: 2 },
    ]);
  });

  it("gives the same stored value for different exact lengths in one bucket", async () => {
    const lineOf = (text: string) => `${JSON.stringify(user(1, text))}\n`;
    const stored = async (text: string) => {
      const s = setup(lineOf(text));
      await ingest(s, "--prompt-size");
      return rows(s.db, "SELECT line_number, ts, day, is_sidechain, size_state FROM source_user_events");
    };
    expect(await stored("a".repeat(60))).toEqual(await stored("b".repeat(190)));
  });
});

describe("refreshing facts of a source that already exists", () => {
  /** Puts a database into the state of one created before facts existed: usage rows, no facts, version 0. */
  const makeStale = (db: string) => edit(db, "UPDATE source_files SET facts_version = 0; DELETE FROM tool_calls; DELETE FROM source_user_events;");

  it("collects facts for an unchanged source without touching usage rows, sessions or totals", async () => {
    const s = setup();
    await ingest(s);
    makeStale(s.db);
    const before = usageView(s.db);
    expect(rows(s.db, "SELECT facts_version AS v FROM source_files")).toEqual([{ v: 0 }]);

    const r = await ingest(s);
    expect(r.code).toBe(0);
    expect(r.out).toContain("This file ....... unchanged; 0 records stored, 0 replaced");
    expect(r.out).toContain("collected or replaced for this file");
    expect(rows(s.db, "SELECT facts_version AS v FROM source_files")).toEqual([{ v: 1 }]);
    expect(factRows(s.db).events).toHaveLength(4);
    expect(usageView(s.db)).toEqual(before);
  });

  it("is idempotent: a retry changes nothing and says the facts are already current", async () => {
    const s = setup();
    await ingest(s, "--prompt-size");
    makeStale(s.db);
    await ingest(s, "--prompt-size");
    const first = { facts: factRows(s.db), ids: rows(s.db, "SELECT id FROM tool_calls ORDER BY id"), usage: usageView(s.db) };

    const again = await ingest(s, "--prompt-size");
    expect(again.out).toContain("already current for this file; unchanged");
    expect({ facts: factRows(s.db), ids: rows(s.db, "SELECT id FROM tool_calls ORDER BY id"), usage: usageView(s.db) }).toEqual(first);
  });

  it("produces identical facts from independent databases given the same bytes", async () => {
    const [a, b] = [setup(), setup()];
    await ingest(a, "--prompt-size");
    await ingest(b, "--prompt-size");
    expect(factRows(a.db)).toEqual(factRows(b.db));
  });

  it("upgrades `not-read` to buckets on opt-in and never downgrades afterwards", async () => {
    const s = setup();
    await ingest(s);
    expect(sizeStates(s.db)).toEqual([{ s: "not-read", n: 4 }]);
    const before = usageView(s.db);

    await ingest(s, "--prompt-size");
    expect(sizeStates(s.db).map((r) => r["s"])).toEqual(["unsupported", "xs"]);

    const plain = await ingest(s);
    expect(plain.out).toContain("already current for this file; unchanged");
    expect(sizeStates(s.db).map((r) => r["s"])).toEqual(["unsupported", "xs"]);
    expect(usageView(s.db)).toEqual(before);
  });

  it("refreshes only the file you name, and never discovers its neighbours", async () => {
    const root = realTemp();
    const a = writeFile(join(root, "data"), "a.jsonl", transcript());
    const b = writeFile(join(root, "data"), "b.jsonl", transcript([assistant(7, [toolUse("toolu_B", "Grep")], "2026-05-02")]));
    const c = writeFile(join(root, "data"), "never-named.jsonl", transcript());
    const db = join(root, "out", "usage.db");
    for (const file of [a, b]) expect((await cli(["run", "--db", db, "--token", tokenFor(file), file])).code).toBe(0);
    makeStale(db);
    const sourcesBefore = rows(db, "SELECT fingerprint, facts_version FROM source_files ORDER BY id");

    expect((await cli(["run", "--db", db, "--token", tokenFor(a), a])).code).toBe(0);
    const after = rows(db, "SELECT facts_version AS v, (SELECT COUNT(*) FROM source_user_events e WHERE e.source_file_id = f.id) AS events FROM source_files f ORDER BY id");
    expect(after).toEqual([{ v: 1, events: 4 }, { v: 0, events: 0 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM source_files")).toEqual([{ n: 2 }]); // c was never ingested
    expect(rows(db, "SELECT fingerprint FROM source_files ORDER BY id")).toEqual(sourcesBefore.map((r) => ({ fingerprint: r["fingerprint"] })));
    expect(readFileSync(c, "utf8")).toBe(transcript()); // sources are never modified
  });

  it("deletes no source or database record while refreshing", async () => {
    const s = setup();
    await ingest(s);
    makeStale(s.db);
    const before = ["usage_records", "sessions", "source_files", "scan_runs", "source_scan_results"].map((t) => rows(s.db, `SELECT COUNT(*) AS n FROM ${t}`));
    await ingest(s, "--prompt-size");
    const after = ["usage_records", "sessions", "source_files", "scan_runs", "source_scan_results"].map((t) => rows(s.db, `SELECT COUNT(*) AS n FROM ${t}`));
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(rows(s.db, "SELECT COUNT(*) AS n FROM scan_runs")).toEqual([{ n: 2 }]);
    expect(lstatSync(s.file).isFile()).toBe(true);
  });
});

describe("a failed refresh", () => {
  it.each(["tool_calls", "source_user_events"])("rolls back usage and facts together when a write to %s fails, then recovers", async (table) => {
    const s = setup();
    await ingest(s);
    edit(s.db, "UPDATE source_files SET facts_version = 0; DELETE FROM tool_calls; DELETE FROM source_user_events;");
    const usageBefore = usageView(s.db);
    const sourcesBefore = rows(s.db, "SELECT * FROM source_files ORDER BY id");
    edit(s.db, `CREATE TRIGGER fail_facts BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'CANARY_DB_ERROR /Users/q/secret'); END`);

    const r = await ingest(s, "--prompt-size");
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^FAILED \[FACTS_FAILED\] /);
    expect(r.err).toContain("No usage records and no facts were changed by this run");
    expect(r.err + r.out).not.toMatch(/CANARY|secret|\/Users\/|SQLITE/);
    expect(rows(s.db, "SELECT COUNT(*) AS n FROM tool_calls")).toEqual([{ n: 0 }]);
    expect(rows(s.db, "SELECT COUNT(*) AS n FROM source_user_events")).toEqual([{ n: 0 }]);
    expect(rows(s.db, "SELECT * FROM source_files ORDER BY id")).toEqual(sourcesBefore);
    expect(usageView(s.db).records).toEqual(usageBefore.records);
    expect(usageView(s.db).summary).toEqual(usageBefore.summary);

    edit(s.db, "DROP TRIGGER fail_facts");
    const retry = await ingest(s, "--prompt-size");
    expect(retry.code).toBe(0);
    expect(rows(s.db, "SELECT facts_version AS v FROM source_files")).toEqual([{ v: 1 }]);
    expect(factRows(s.db).events).toHaveLength(4);
    expect(usageView(s.db).records).toEqual(usageBefore.records);
  });

  it("tells a usage-write failure (INGEST_FAILED) apart from a facts-write failure (FACTS_FAILED)", async () => {
    const usageSide = setup();
    await ingest(usageSide);
    edit(usageSide.db, "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_records BEGIN SELECT RAISE(ABORT, 'CANARY_USAGE_ERROR /Users/q/x'); END");
    writeFile(join(usageSide.file, ".."), "secret-file-name.jsonl", `${transcript()}${JSON.stringify(assistant(9, [], "2026-05-03"))}\n`);
    const usage = await ingest(usageSide);
    expect(usage.code).toBe(3);
    expect(usage.err).toMatch(/^FAILED \[INGEST_FAILED\] /);
    expect(usage.err).not.toMatch(/CANARY|\/Users\//);

    // A brand-new source whose facts cannot be written: nothing at all is stored, and the code says why.
    const factsSide = setup();
    await ingest(factsSide); // creates the database
    const other = writeFile(join(factsSide.root, "data"), "other.jsonl", transcript([assistant(8, [toolUse("toolu_RAW_9", "Grep")], "2026-05-04")]));
    edit(factsSide.db, "CREATE TRIGGER fail_facts BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'CANARY_FACTS_ERROR /Users/q/x'); END");
    const before = rows(factsSide.db, "SELECT COUNT(*) AS n FROM usage_records");
    const facts = await cli(["run", "--db", factsSide.db, "--token", tokenFor(other), other]);
    expect(facts.code).toBe(3);
    expect(facts.err).toMatch(/^FAILED \[FACTS_FAILED\] /);
    expect(facts.err + facts.out).not.toMatch(/CANARY|\/Users\/|toolu_|SQLITE|errcode/i);
    expect(rows(factsSide.db, "SELECT COUNT(*) AS n FROM usage_records")).toEqual(before);
    expect(rows(factsSide.db, "SELECT COUNT(*) AS n FROM source_files")).toEqual([{ n: 1 }]);
  });

  it("carries the phase on the store error and records the same fixed code in run history", async () => {
    const s = setup();
    await ingest(s);
    edit(s.db, "UPDATE source_files SET facts_version = 0; DELETE FROM tool_calls; DELETE FROM source_user_events;");
    edit(s.db, "CREATE TRIGGER fail_facts BEFORE INSERT ON source_user_events BEGIN SELECT RAISE(ABORT, 'x'); END");
    const store = openStore(s.db, { tightenExistingFile: false });
    try {
      const error = await scanAndIngest(store, [s.file]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).phase).toBe("facts");
      expect((error as IngestError).code).toMatch(/^SQLITE_/);
      expect(String(error)).not.toContain("facts write failed");
    } finally {
      store.close();
    }
    expect(rows(s.db, "SELECT status, error_code FROM scan_runs ORDER BY id DESC LIMIT 1")).toEqual([{ status: "failed", error_code: expect.stringMatching(/^SQLITE_/) as string }]);
  });

  it("changes nothing for a rejected command (wrong token) and reads nothing", async () => {
    const s = setup();
    await ingest(s);
    const bytes = readFileSync(s.db).toString("hex");
    const r = await cli(["run", "--db", s.db, "--token", "0".repeat(64), "--prompt-size", s.file]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("TOKEN_MISMATCH");
    expect(readFileSync(s.db).toString("hex")).toBe(bytes);
  });
});
