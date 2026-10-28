import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseJsonlFiles, TEXT_LENGTH_STATES, TOOL_BUCKETS } from "@/core/parse";
import {
  CURRENT_FACTS_VERSION,
  IngestError,
  MIGRATIONS,
  accountingStateCounts,
  accountingSummary,
  fingerprint,
  ingestSources,
  openStore,
  readSource,
  recomputeToolDedup,
  scanAndIngest,
  type Store,
} from "@/core/store";
import { FACT_CANARIES, PROMPT_FACTS_A, PROMPT_FACTS_B } from "./facts-helpers";
import { CANARIES, fixturePath } from "./helpers";
import { copyFixtureTo, expectMatchesParser, freshStore, readText, registerTempStoreCleanup, tempDir, writeText } from "./store-helpers";

registerTempStoreCleanup();

const OPT_IN = { readPromptLength: true } as const;
const BASIC = fixturePath("usage-basic.jsonl");
const SALT = "ab".repeat(32);

const extraStores: Store[] = [];
afterEach(() => {
  for (const store of extraStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
});

/** A fresh database whose salt is fixed, so fingerprints are comparable between databases. */
function saltedStore(): { store: Store; dbPath: string } {
  const { store, dbPath } = freshStore();
  store.close();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE meta SET value = ? WHERE key = 'salt'").run(SALT);
  raw.close();
  const reopened = openStore(dbPath);
  extraStores.push(reopened);
  return { store: reopened, dbPath };
}

/** Two synthetic fact sources in a fresh directory. They share the tool-use id `toolu_f7`. */
function twoSources(): { a: string; b: string } {
  const dir = tempDir();
  return { a: copyFixtureTo(dir, PROMPT_FACTS_A, "a.jsonl"), b: copyFixtureTo(dir, PROMPT_FACTS_B, "b.jsonl") };
}

const sourceFp = (store: Store, path: string) =>
  fingerprint(store.salt, "source", join(realpathSync(dirname(path)), basename(path)));

const rows = (store: Store, sql: string) => store.db.prepare(sql).all();

const USER_EVENTS = `SELECT sf.fingerprint AS src, e.line_number AS line, e.session_fp, e.ts, e.day, e.is_sidechain AS side, e.size_state
  FROM source_user_events e JOIN source_files sf ON sf.id = e.source_file_id ORDER BY sf.fingerprint, e.line_number`;
const TOOL_CALLS = `SELECT sf.fingerprint AS src, tc.line_number AS line, tc.block_index AS block, tc.tool_id_fp AS id_fp, tc.tool_bucket AS bucket,
  tc.session_fp, tc.ts, tc.day, tc.is_sidechain AS side, tc.dedup, tc.dedup_group_size AS size
  FROM tool_calls tc JOIN source_files sf ON sf.id = tc.source_file_id ORDER BY sf.fingerprint, tc.line_number, tc.block_index`;
const USAGE = `SELECT ur.*, sf.fingerprint AS src FROM usage_records ur JOIN source_files sf ON sf.id = ur.source_file_id ORDER BY sf.fingerprint, ur.line_number`;

const factsOf = (store: Store) => ({ userEvents: rows(store, USER_EVENTS), toolCalls: rows(store, TOOL_CALLS) });
const accountingOf = (store: Store) => ({
  usage: rows(store, USAGE),
  summary: accountingSummary(store.db),
  states: accountingStateCounts(store.db),
  sessions: rows(store, "SELECT fingerprint FROM sessions ORDER BY fingerprint"),
});
const countOf = (store: Store, table: "source_user_events" | "tool_calls") =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("schema v4", () => {
  it("is the latest migration and is purely additive", () => {
    const v4 = MIGRATIONS.find((m) => m.version === 4);
    expect(v4?.name).toBe("event-facts");
    expect(MIGRATIONS.at(-1)?.version).toBe(4);
    expect(v4?.sql).toMatch(/ALTER TABLE source_files ADD COLUMN facts_version/);
    expect(v4?.sql).not.toMatch(/DROP |DELETE FROM|UPDATE |INSERT /i);
    expect(v4?.sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(v4?.sql.match(/CREATE TABLE/g)).toHaveLength(2);
  });

  it("has no column that could hold content, exact lengths, names, ids, arguments or results", () => {
    const { store } = freshStore();
    const columns = (table: string) => (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("source_user_events")).toEqual(["id", "source_file_id", "line_number", "session_fp", "ts", "day", "is_sidechain", "size_state"]);
    expect(columns("tool_calls")).toEqual([
      "id", "source_file_id", "line_number", "block_index", "tool_id_fp", "tool_bucket", "session_fp", "ts", "day", "is_sidechain", "dedup", "dedup_group_size",
    ]);
  });

  it("restricts the stored vocabularies in the database itself, in step with the code's", () => {
    const { store } = freshStore();
    const db = store.db;
    db.exec("INSERT INTO scan_runs (started_at, status) VALUES ('t', 'complete')");
    db.exec("INSERT INTO source_files (fingerprint, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id) VALUES ('f', 'h', 0, 1, 1, 1)");
    const event = db.prepare("INSERT INTO source_user_events (source_file_id, line_number, size_state) VALUES (1, ?, ?)");
    TEXT_LENGTH_STATES.forEach((state, i) => event.run(i + 1, state));
    for (const bad of ["abc", "", "123", "CANARY"]) expect(() => event.run(99, bad)).toThrow();

    const tool = db.prepare("INSERT INTO tool_calls (source_file_id, line_number, block_index, tool_bucket, dedup, dedup_group_size) VALUES (1, 1, ?, ?, 'kept', 1)");
    TOOL_BUCKETS.forEach((bucket, i) => tool.run(i, bucket));
    for (const bad of ["Foo", "mcp__a__b", "read", "Read ", ""]) expect(() => tool.run(99, bad)).toThrow();
    expect(() => tool.run(-1, "Read")).toThrow();
  });

  it("enforces one kept occurrence per id, and that calls without an id are always kept", () => {
    const { store } = freshStore();
    const db = store.db;
    db.exec("INSERT INTO scan_runs (started_at, status) VALUES ('t', 'complete')");
    db.exec("INSERT INTO source_files (fingerprint, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id) VALUES ('f', 'h', 0, 1, 1, 1)");
    const insert = db.prepare("INSERT INTO tool_calls (source_file_id, line_number, block_index, tool_id_fp, tool_bucket, dedup, dedup_group_size) VALUES (1, ?, ?, ?, 'Read', ?, 1)");

    insert.run(1, 0, "id", "kept");
    expect(() => insert.run(2, 0, "id", "kept")).toThrow();
    insert.run(2, 0, "id", "duplicate");
    expect(() => insert.run(1, 0, "other", "kept")).toThrow(); // same position
    expect(() => insert.run(3, 0, null, "duplicate")).toThrow();
    insert.run(3, 0, null, "kept");
  });
});

describe("migration from v3", () => {
  it("keeps every existing row, marks sources as uncollected, and populates facts on the next explicit ingest", async () => {
    const { a, b } = twoSources();
    const paths = [BASIC, a, b];
    const original = saltedStore();
    await scanAndIngest(original.store, paths);
    const expected = { accounting: accountingOf(original.store), facts: factsOf(original.store) };
    original.store.close();

    // A genuine v3 file: the v1-v3 schema, filled from the v4 database's pre-existing tables only.
    const v3Path = join(tempDir(), "v3.db");
    const v3 = new DatabaseSync(v3Path);
    v3.exec("PRAGMA foreign_keys = ON");
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) v3.exec(m.sql);
    v3.exec("PRAGMA user_version = 3");
    v3.exec(`ATTACH DATABASE '${original.dbPath.replace(/'/g, "''")}' AS old`);
    v3.exec(`INSERT INTO meta SELECT * FROM old.meta;
      INSERT INTO scan_runs SELECT * FROM old.scan_runs;
      INSERT INTO source_files (id, fingerprint, label, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id)
        SELECT id, fingerprint, label, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id FROM old.source_files;
      INSERT INTO sessions SELECT * FROM old.sessions;
      INSERT INTO usage_records SELECT * FROM old.usage_records;
      INSERT INTO source_scan_results SELECT * FROM old.source_scan_results;`);
    v3.exec("DETACH DATABASE old");
    const tables = ["meta", "scan_runs", "sessions", "usage_records", "source_scan_results"] as const;
    const before = Object.fromEntries(tables.map((t) => [t, v3.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
    const sourcesBefore = v3.prepare("SELECT id, fingerprint, label, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id FROM source_files ORDER BY id").all();
    v3.close();

    const store = openStore(v3Path);
    extraStores.push(store);
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const t of tables) expect(store.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(), t).toEqual(before[t]);
    expect(store.db.prepare("SELECT id, fingerprint, label, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id FROM source_files ORDER BY id").all()).toEqual(sourcesBefore);
    expect(accountingOf(store)).toEqual(expected.accounting);

    // Never collected: version 0, no rows. This is not the same as collected-and-empty.
    expect(rows(store, "SELECT DISTINCT facts_version FROM source_files")).toEqual([{ facts_version: 0 }]);
    expect([countOf(store, "source_user_events"), countOf(store, "tool_calls")]).toEqual([0, 0]);

    const rescan = await scanAndIngest(store, paths);
    expect(rescan.sources.map((s) => s.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(rows(store, "SELECT DISTINCT facts_version FROM source_files")).toEqual([{ facts_version: CURRENT_FACTS_VERSION }]);
    expect(factsOf(store)).toEqual(expected.facts);
    expect(accountingOf(store)).toEqual(expected.accounting);

    const idsBefore = rows(store, "SELECT id FROM tool_calls ORDER BY id");
    await scanAndIngest(store, paths);
    expect(rows(store, "SELECT id FROM tool_calls ORDER BY id")).toEqual(idsBefore);
    expect(factsOf(store)).toEqual(expected.facts);
  });

  it("leaves a source that is not named alone: no discovery, no implicit backfill", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);
    store.db.exec("UPDATE source_files SET facts_version = 0");
    store.db.exec("DELETE FROM tool_calls; DELETE FROM source_user_events;");

    await scanAndIngest(store, [a]);
    const versions = rows(store, "SELECT fingerprint, facts_version FROM source_files");
    expect(versions.filter((v) => v["facts_version"] === CURRENT_FACTS_VERSION)).toHaveLength(1);
    expect(rows(store, `SELECT DISTINCT src FROM (${USER_EVENTS})`)).toEqual([{ src: sourceFp(store, a) }]);
  });
});

describe("persisted facts", () => {
  it("stores source-typed user events as not-read by default, with no prompt length claim", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);

    expect(countOf(store, "source_user_events")).toBe(12);
    expect(rows(store, "SELECT DISTINCT size_state FROM source_user_events")).toEqual([{ size_state: "not-read" }]);
  });

  it("stores buckets and `unsupported` only on an explicit parse-layer opt-in", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b], OPT_IN);

    const states = rows(store, "SELECT size_state, COUNT(*) AS n FROM source_user_events GROUP BY size_state ORDER BY size_state");
    expect(states).toEqual([
      { size_state: "empty", n: 1 },
      { size_state: "s", n: 1 },
      { size_state: "unsupported", n: 6 },
      { size_state: "xs", n: 4 },
    ]);
    expect(rows(store, `SELECT line FROM (${USER_EVENTS}) WHERE size_state = 'empty'`)).toEqual([{ line: 10 }]);
  });

  it("does not enable reading through any default path", async () => {
    const { a } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a], { label: "x" });
    const input = await readSource(store, a);
    expect(input.kind === "ok" && input.scan.userEvents.every((e) => e.textLength === "not-read")).toBe(true);
    expect(rows(store, "SELECT DISTINCT size_state FROM source_user_events")).toEqual([{ size_state: "not-read" }]);
  });

  it("gives the same stored value for different exact lengths in one bucket", async () => {
    const lineOf = (text: string) => `${JSON.stringify({ type: "user", sessionId: "s1", timestamp: "2026-05-01T00:00:00.000Z", message: { content: text } })}\n`;
    const dir = tempDir();
    writeText(join(dir, "short.jsonl"), lineOf("a".repeat(60)));
    writeText(join(dir, "long.jsonl"), lineOf("b".repeat(190)));
    const stored = async (name: string) => {
      const { store } = freshStore();
      await scanAndIngest(store, [join(dir, name)], OPT_IN);
      return rows(store, "SELECT line_number, ts, day, is_sidechain, size_state FROM source_user_events");
    };
    expect(await stored("short.jsonl")).toEqual(await stored("long.jsonl"));
    expect(await stored("short.jsonl")).toEqual([{ line_number: 1, ts: "2026-05-01T00:00:00.000Z", day: "2026-05-01", is_sidechain: null, size_state: "s" }]);
  });

  it("stores every tool_use occurrence as a bucket, with the parser's counts as a cross-check", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);
    const parsed = (await parseJsonlFiles([a, b])).diagnostics;

    expect(countOf(store, "tool_calls")).toBe(parsed.toolEventsParsed);
    expect(rows(store, "SELECT COUNT(*) AS n FROM tool_calls WHERE dedup = 'kept'")).toEqual([{ n: parsed.toolEventsKept }]);
    const buckets = rows(store, "SELECT DISTINCT tool_bucket AS b FROM tool_calls").map((r) => r["b"]);
    expect(buckets.every((bucket) => (TOOL_BUCKETS as readonly unknown[]).includes(bucket))).toBe(true);
    expect(buckets).toContain("other");
    expect(buckets).toContain("unknown");
  });

  it("keeps several anonymous tool blocks in one event distinct, by original block position", async () => {
    const dir = tempDir();
    const use = (extra: Record<string, unknown> = {}) => ({ type: "tool_use", name: "Edit", input: {}, ...extra });
    const event = { type: "assistant", sessionId: "s1", message: { content: [{ type: "text", text: "t" }, use(), "bare", use(), use(), use({ id: "toolu_z" })] } };
    const path = join(dir, "anon.jsonl");
    writeText(path, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
    const { store } = freshStore();
    await scanAndIngest(store, [path]);

    expect(rows(store, `SELECT line, block, id_fp IS NULL AS anonymous, dedup, size FROM (${TOOL_CALLS})`)).toEqual([
      { line: 1, block: 1, anonymous: 1, dedup: "kept", size: 1 },
      { line: 1, block: 3, anonymous: 1, dedup: "kept", size: 1 },
      { line: 1, block: 4, anonymous: 1, dedup: "kept", size: 1 },
      { line: 1, block: 5, anonymous: 0, dedup: "kept", size: 2 },
      { line: 2, block: 1, anonymous: 1, dedup: "kept", size: 1 },
      { line: 2, block: 3, anonymous: 1, dedup: "kept", size: 1 },
      { line: 2, block: 4, anonymous: 1, dedup: "kept", size: 1 },
      { line: 2, block: 5, anonymous: 0, dedup: "duplicate", size: 2 },
    ]);

    // An insertion changes the version of the source: anonymous identities are replaced, not carried over.
    writeText(path, `${JSON.stringify({ type: "system" })}\n${readText(path)}`);
    const modified = await scanAndIngest(store, [path]);
    expect(modified.sources[0]?.outcome).toBe("modified");
    expect(rows(store, "SELECT DISTINCT line_number AS line FROM tool_calls ORDER BY 1")).toEqual([{ line: 2 }, { line: 3 }]);
    expect(countOf(store, "tool_calls")).toBe(8);
  });
});

describe("global deduplication of tool-use ids", () => {
  const f7 = (store: Store) => fingerprint(store.salt, "tool", "toolu_f7");
  const holders = (store: Store) =>
    store.db.prepare("SELECT sf.fingerprint AS src, tc.dedup, tc.dedup_group_size AS size, tc.tool_bucket AS bucket FROM tool_calls tc JOIN source_files sf ON sf.id = tc.source_file_id WHERE tc.tool_id_fp = ? ORDER BY sf.fingerprint").all(f7(store));

  it("keeps the occurrence in the earliest source fingerprint, whatever order sources arrive in", async () => {
    const { a, b } = twoSources();
    const variants: [string, (store: Store) => Promise<unknown>][] = [
      ["one scan, a then b", (s) => scanAndIngest(s, [a, b])],
      ["one scan, b then a", (s) => scanAndIngest(s, [b, a])],
      ["a, later b", async (s) => { await scanAndIngest(s, [a]); await scanAndIngest(s, [b]); }],
      ["b, later a", async (s) => { await scanAndIngest(s, [b]); await scanAndIngest(s, [a]); }],
    ];
    const results = [];
    for (const [, ingest] of variants) {
      const { store } = saltedStore();
      await ingest(store);
      results.push(factsOf(store));
      const winner = holders(store);
      expect(winner.map((h) => h["dedup"])).toEqual(["kept", "duplicate"]);
      expect(winner.map((h) => h["size"])).toEqual([2, 2]);
    }
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  });

  it("keeps exactly one occurrence of every id", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);
    expect(rows(store, "SELECT tool_id_fp, SUM(dedup = 'kept') AS kept, COUNT(*) AS n, MIN(dedup_group_size) AS lo, MAX(dedup_group_size) AS hi FROM tool_calls WHERE tool_id_fp IS NOT NULL GROUP BY tool_id_fp")
      .every((r) => r["kept"] === 1 && r["lo"] === r["n"] && r["hi"] === r["n"])).toBe(true);
  });

  it("recomputes when a source is added", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a]);
    expect(holders(store)).toEqual([{ src: sourceFp(store, a), dedup: "kept", size: 1, bucket: "Bash" }]);

    await scanAndIngest(store, [b]);
    const after = holders(store);
    expect(after.map((h) => h["dedup"]).sort()).toEqual(["duplicate", "kept"]);
    expect(after.map((h) => h["size"])).toEqual([2, 2]);
    expect(after.find((h) => h["dedup"] === "kept")?.["src"]).toBe([sourceFp(store, a), sourceFp(store, b)].sort()[0]);
  });

  it("recomputes when a source changes so that it no longer holds the id", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);
    const winnerFp = holders(store).find((h) => h["dedup"] === "kept")?.["src"];
    const winnerPath = winnerFp === sourceFp(store, a) ? a : b;
    const loserFp = winnerFp === sourceFp(store, a) ? sourceFp(store, b) : sourceFp(store, a);

    writeText(winnerPath, readText(winnerPath).replace('"toolu_f7"', '"toolu_f7-renamed"'));
    const run = await scanAndIngest(store, [a, b]);

    expect(run.sources.find((s) => s.sourceFingerprint === winnerFp)?.outcome).toBe("modified");
    expect(holders(store)).toEqual([{ src: loserFp, dedup: "kept", size: 1, bucket: expect.any(String) as string }]);
  });

  it("recomputes when a source is removed", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);
    const winnerFp = holders(store).find((h) => h["dedup"] === "kept")?.["src"] as string;
    const affected = new Set((rows(store, "SELECT DISTINCT tool_id_fp AS fp FROM tool_calls WHERE source_file_id = (SELECT id FROM source_files WHERE fingerprint = '" + winnerFp + "') AND tool_id_fp IS NOT NULL")).map((r) => r["fp"] as string));
    const loserFp = [sourceFp(store, a), sourceFp(store, b)].find((fp) => fp !== winnerFp);

    store.db.prepare("DELETE FROM source_files WHERE fingerprint = ?").run(winnerFp);
    expect(rows(store, `SELECT 1 FROM (${TOOL_CALLS}) WHERE src = '${winnerFp}'`)).toEqual([]);
    expect(rows(store, `SELECT 1 FROM (${USER_EVENTS}) WHERE src = '${winnerFp}'`)).toEqual([]);
    recomputeToolDedup(store.db, affected);

    expect(holders(store)).toEqual([{ src: loserFp, dedup: "kept", size: 1, bucket: expect.any(String) as string }]);
  });
});

describe("re-ingestion, failure and rollback", () => {
  it("is idempotent for identical bytes and does not rewrite rows", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b], OPT_IN);
    const facts = factsOf(store);
    const ids = [rows(store, "SELECT id FROM tool_calls ORDER BY id"), rows(store, "SELECT id FROM source_user_events ORDER BY id")];

    for (const order of [[a, b], [b, a], [a], [b, b]]) {
      const run = await scanAndIngest(store, order, OPT_IN);
      expect(run.sources.every((s) => s.outcome === "unchanged")).toBe(true);
    }
    expect(factsOf(store)).toEqual(facts);
    expect([rows(store, "SELECT id FROM tool_calls ORDER BY id"), rows(store, "SELECT id FROM source_user_events ORDER BY id")]).toEqual(ids);
  });

  it("upgrades an unchanged source to text-length buckets on opt-in, and never downgrades it", async () => {
    const { a } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a]);
    expect(rows(store, "SELECT DISTINCT size_state FROM source_user_events")).toEqual([{ size_state: "not-read" }]);

    const upgraded = await scanAndIngest(store, [a], OPT_IN);
    expect(upgraded.sources[0]?.outcome).toBe("unchanged");
    expect(rows(store, "SELECT size_state, COUNT(*) AS n FROM source_user_events GROUP BY 1 ORDER BY 1")).toEqual([
      { size_state: "empty", n: 1 }, { size_state: "s", n: 1 }, { size_state: "unsupported", n: 6 }, { size_state: "xs", n: 3 },
    ]);

    await scanAndIngest(store, [a]);
    expect(rows(store, "SELECT COUNT(*) AS n FROM source_user_events WHERE size_state = 'not-read'")).toEqual([{ n: 0 }]);
  });

  it("marks a collected source with no events as collected, not as uncollected", async () => {
    const path = join(tempDir(), "quiet.jsonl");
    writeText(path, `${JSON.stringify({ type: "assistant", message: { id: "m", usage: { input_tokens: 1 } } })}\n`);
    const { store } = freshStore();
    await scanAndIngest(store, [path]);

    expect(rows(store, "SELECT facts_version FROM source_files")).toEqual([{ facts_version: CURRENT_FACTS_VERSION }]);
    expect([countOf(store, "source_user_events"), countOf(store, "tool_calls")]).toEqual([0, 0]);
  });

  it("keeps stored facts when a source fails, in a partial or a wholly failed scan", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a, b]);
    const facts = factsOf(store);
    const missing = join(tempDir(), "gone.jsonl");

    const partial = await scanAndIngest(store, [a, missing]);
    expect(partial.status).toBe("partial");
    const failed = await scanAndIngest(store, [missing]);
    expect(failed.status).toBe("failed");
    expect(factsOf(store)).toEqual(facts);
  });

  it("rolls usage and facts back together when a write fails, and recovers afterwards", async () => {
    const { a, b } = twoSources();
    for (const table of ["tool_calls", "source_user_events"]) {
      const { store } = freshStore();
      await scanAndIngest(store, [a]);
      const before = { accounting: accountingOf(store), facts: factsOf(store), sources: rows(store, "SELECT * FROM source_files ORDER BY id") };
      const runs = rows(store, "SELECT COUNT(*) AS n FROM scan_runs");

      store.db.exec(`CREATE TRIGGER fail_facts BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'CANARY_DB_ERROR_TEXT /Users/q/secret'); END`);
      writeText(a, `${readText(a)}${JSON.stringify({ type: "user", sessionId: "s", message: { content: "CANARY_LATE" } })}\n`);
      const error = await scanAndIngest(store, [a, b]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IngestError);
      expect(String(error)).not.toMatch(/CANARY|secret/);
      expect({ accounting: accountingOf(store), facts: factsOf(store), sources: rows(store, "SELECT * FROM source_files ORDER BY id") }).toEqual(before);
      expect(rows(store, "SELECT status, error_code FROM scan_runs ORDER BY id DESC LIMIT 1")).toEqual([{ status: "failed", error_code: expect.stringMatching(/^SQLITE_/) as string }]);
      expect(rows(store, "SELECT COUNT(*) AS n FROM scan_runs")).toEqual([{ n: (runs[0] as { n: number }).n + 1 }]);

      store.db.exec("DROP TRIGGER fail_facts");
      const retry = await scanAndIngest(store, [a, b]);
      expect(retry.status).toBe("complete");
      expect(countOf(store, "source_user_events")).toBe(13);
      writeText(a, readText(a).split("\n").slice(0, -2).join("\n") + "\n");
    }
  });

  it("rolls back facts when a later source in the same scan fails to write", async () => {
    const { a, b } = twoSources();
    const { store } = freshStore();
    store.db.exec("CREATE TRIGGER fail_b BEFORE INSERT ON tool_calls WHEN NEW.tool_bucket = 'Glob' BEGIN SELECT RAISE(ABORT, 'x'); END");

    await expect(scanAndIngest(store, [a, b])).rejects.toBeInstanceOf(IngestError);
    expect([countOf(store, "tool_calls"), countOf(store, "source_user_events"), (store.db.prepare("SELECT COUNT(*) AS n FROM usage_records").get() as { n: number }).n]).toEqual([0, 0, 0]);
    expect(rows(store, "SELECT COUNT(*) AS n FROM source_files")).toEqual([{ n: 0 }]);
  });

  it("writes nothing for an input that failed to read", async () => {
    const { store } = freshStore();
    const input = await readSource(store, join(tempDir(), "nope.jsonl"));
    expect(input.kind).toBe("failed");
    ingestSources(store, [input]);
    expect([countOf(store, "tool_calls"), countOf(store, "source_user_events")]).toEqual([0, 0]);
  });
});

describe("privacy of persisted facts", () => {
  it("keeps canaries, raw ids, odd tool names, arguments and results out of the database file and rows", async () => {
    const { a, b } = twoSources();
    const { store, dbPath } = freshStore();
    await scanAndIngest(store, [a, b, BASIC], OPT_IN);
    store.close();

    const dir = dirname(dbPath);
    const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
    const forbidden = [...FACT_CANARIES, ...CANARIES, "CANARY", "toolu_", "sess-", "mcp__", "<odd>", "msg_", "fu-0", "fa-0", "a.jsonl", "b.jsonl", "secret.txt"];
    for (const needle of forbidden) expect(bytes, needle).not.toContain(needle);

    const reopened = openStore(dbPath);
    extraStores.push(reopened);
    const text = JSON.stringify(factsOf(reopened));
    for (const needle of forbidden) expect(text, needle).not.toContain(needle);
    for (const row of rows(reopened, "SELECT tool_id_fp, session_fp FROM tool_calls WHERE tool_id_fp IS NOT NULL")) {
      expect(row["tool_id_fp"]).toMatch(/^[0-9a-f]{64}$/);
      expect(row["session_fp"] === null || /^[0-9a-f]{64}$/.test(String(row["session_fp"]))).toBe(true);
    }
    const stored = rows(reopened, "SELECT DISTINCT tool_bucket AS b FROM tool_calls").map((r) => r["b"]);
    expect(stored.every((bucket) => (TOOL_BUCKETS as readonly unknown[]).includes(bucket))).toBe(true);
  });

  it("never stores a raw tool-use id or session id, only the salted fingerprints", async () => {
    const { a } = twoSources();
    const { store } = freshStore();
    await scanAndIngest(store, [a]);
    const fp = fingerprint(store.salt, "tool", "toolu_f1");
    expect(rows(store, `SELECT COUNT(*) AS n FROM tool_calls WHERE tool_id_fp = '${fp}'`)).toEqual([{ n: 2 }]);
    expect(rows(store, "SELECT DISTINCT session_fp AS fp FROM source_user_events")).toEqual([{ fp: fingerprint(store.salt, "session", "sess-F") }]);
  });
});

describe("usage accounting is independent of facts", () => {
  it("gives the same records, states and settled totals with the opt-in on and off", async () => {
    const { a, b } = twoSources();
    const paths = [BASIC, a, b];
    const off = saltedStore().store;
    const on = saltedStore().store;
    await scanAndIngest(off, paths);
    await scanAndIngest(on, paths, OPT_IN);

    const surrogateKeys = new Set(["id", "source_file_id", "session_id"]);
    const strip = (store: Store) =>
      accountingOf(store).usage.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !surrogateKeys.has(key))));
    expect(strip(on)).toEqual(strip(off));
    expect(accountingSummary(on.db)).toEqual(accountingSummary(off.db));
    await expectMatchesParser(on, paths);
    await expectMatchesParser(off, paths);
  });

  it("still settles the original fixture to its pinned totals", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC], OPT_IN);
    expect(accountingSummary(store.db).settled).toEqual({ inputTokens: 120, outputTokens: 80, cacheReadTokens: 1000, cacheCreationTokens: 204, records: 7 });
    expect(accountingStateCounts(store.db)).toEqual({ accepted: 7, duplicate: 1, conflicting: 2, ambiguous: 2 });
  });

  it("leaves usage rows and the sessions table untouched by a facts-only refresh or by user-only sources", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [BASIC]);
    const before = accountingOf(store);
    store.db.exec("UPDATE source_files SET facts_version = 0; DELETE FROM tool_calls; DELETE FROM source_user_events;");
    await scanAndIngest(store, [BASIC], OPT_IN);
    expect(accountingOf(store)).toEqual(before);

    const only = join(tempDir(), "users-only.jsonl");
    writeText(only, `${JSON.stringify({ type: "user", sessionId: "only-user-session", message: { content: "hi" } })}\n`);
    await scanAndIngest(store, [only]);
    expect(accountingOf(store).sessions).toEqual(before.sessions);
    expect(rows(store, "SELECT COUNT(*) AS n FROM source_user_events WHERE session_fp IS NOT NULL")).toEqual([{ n: expect.any(Number) as number }]);
    expect(accountingOf(store).summary).toEqual(before.summary);
  });
});
