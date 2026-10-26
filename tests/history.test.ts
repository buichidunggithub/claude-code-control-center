import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as runDetail } from "@/app/api/runs/detail/route";
import { GET as runs } from "@/app/api/runs/route";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, createAnalysis, parseRunDetailQuery, parseRunsQuery } from "@/core/analysis";
import { IngestError, ingestSources, readSource, scanAndIngest, type Store } from "@/core/store";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { ALL_CANARIES, databaseAtVersion, populatedDatabase } from "./analysis-helpers";
import { fixturePath } from "./helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const PAGE = { limit: PAGE_LIMIT_DEFAULT, offset: 0 } as const;
const detailQuery = (id: number) => ({ id, ...PAGE });

interface RunSeed {
  readonly startedAt: string;
  readonly status?: string;
  readonly finishedAt?: string | null;
  readonly errorCode?: string | null;
  readonly requested?: number;
  readonly counts?: readonly [number, number, number, number, number];
  readonly inserted?: number;
  readonly removed?: number;
}

/** Inserts a run row directly so ordering, status and unusual values can be controlled exactly. */
function seedRun(store: Store, seed: RunSeed): number {
  const [n, u, a, m, f] = seed.counts ?? [0, 0, 0, 0, 0];
  const result = store.db
    .prepare(
      `INSERT INTO scan_runs (started_at, finished_at, status, error_code, sources_requested, sources_new, sources_unchanged,
         sources_appended, sources_modified, sources_failed, records_inserted, records_removed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(seed.startedAt, seed.finishedAt === undefined ? seed.startedAt : seed.finishedAt, seed.status ?? "complete", seed.errorCode ?? null, seed.requested ?? 0, n, u, a, m, f, seed.inserted ?? 0, seed.removed ?? 0);
  return Number(result.lastInsertRowid);
}

describe("run history service", () => {
  it("reports an empty history as ok with no runs, not as an error", () => {
    const { store, dbPath } = freshStore();
    store.close();

    expect(createAnalysis(dbPath).runHistory(PAGE)).toEqual({
      state: "ok",
      errorCode: null,
      data: expect.objectContaining({ total: 0, items: [], limit: PAGE_LIMIT_DEFAULT, offset: 0 }),
    });
  });

  it("reports a missing database as no-database and creates nothing", () => {
    const target = join(tempDir(), "never-created", "usage.db");
    const a = createAnalysis(target);

    expect(a.runHistory(PAGE)).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    expect(a.runDetail(detailQuery(1))).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("reports an outdated schema with a fixed code and never migrates it", () => {
    const old = databaseAtVersion(2);
    const response = createAnalysis(old).runHistory(PAGE);

    expect(response).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
    const raw = new DatabaseSync(old, { readOnly: true });
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    raw.close();
  });

  it("lists newest first by start time and breaks equal start times by run id", () => {
    const { store, dbPath } = freshStore();
    const a = seedRun(store, { startedAt: "2026-01-01T10:00:00.000Z" });
    const b = seedRun(store, { startedAt: "2026-01-03T10:00:00.000Z" });
    const c = seedRun(store, { startedAt: "2026-01-03T10:00:00.000Z" });
    const d = seedRun(store, { startedAt: "2026-01-02T10:00:00.000Z" });
    store.close();

    const ids = createAnalysis(dbPath).runHistory(PAGE).data?.items.map((r) => r.id);
    expect(ids).toEqual([c, b, d, a]);
    expect(createAnalysis(dbPath).runHistory(PAGE).data?.items.map((r) => r.id)).toEqual(ids);
  });

  it("bounds and pages the list with a stable total", () => {
    const { store, dbPath } = freshStore();
    for (let i = 0; i < 7; i++) seedRun(store, { startedAt: `2026-02-0${i + 1}T00:00:00.000Z` });
    store.close();
    const a = createAnalysis(dbPath);

    const first = a.runHistory({ limit: 3, offset: 0 }).data;
    const second = a.runHistory({ limit: 3, offset: 3 }).data;
    const last = a.runHistory({ limit: 3, offset: 6 }).data;
    const beyond = a.runHistory({ limit: 3, offset: 50 }).data;

    expect([first?.items.length, second?.items.length, last?.items.length, beyond?.items.length]).toEqual([3, 3, 1, 0]);
    expect([first?.total, second?.total, last?.total, beyond?.total]).toEqual([7, 7, 7, 7]);
    const pages = [...(first?.items ?? []), ...(second?.items ?? []), ...(last?.items ?? [])].map((r) => r.id);
    expect(pages).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("records real source outcome counts from genuine ingests (new, unchanged, appended, modified)", async () => {
    const { store, dbPath, dir } = freshStore();
    const file = join(dir, "t.jsonl");
    const line = (id: string) => JSON.stringify({ type: "assistant", sessionId: "s", message: { id, model: "claude-x", usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: "2026-03-01T00:00:00.000Z" });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${line("m1")}\n`);
    await scanAndIngest(store, [file]); // new
    await scanAndIngest(store, [file]); // unchanged
    writeFileSync(file, `${line("m1")}\n${line("m2")}\n`);
    await scanAndIngest(store, [file]); // appended
    writeFileSync(file, `${line("m3")}\n`);
    await scanAndIngest(store, [file]); // modified
    store.close();

    const items = createAnalysis(dbPath).runHistory(PAGE).data?.items ?? [];
    const sources = items.map((r) => r.counts?.sources);
    expect(items.map((r) => r.kind)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(sources).toEqual([
      { new: 0, unchanged: 0, appended: 0, modified: 1, failed: 0 },
      { new: 0, unchanged: 0, appended: 1, modified: 0, failed: 0 },
      { new: 0, unchanged: 1, appended: 0, modified: 0, failed: 0 },
      { new: 1, unchanged: 0, appended: 0, modified: 0, failed: 0 },
    ]);
    expect(items[3]?.counts).toMatchObject({ recordsInserted: 1, recordsRemoved: 0 });
    expect(items[0]?.counts).toMatchObject({ recordsInserted: 1, recordsRemoved: 2 });
    expect(items[2]?.counts).toMatchObject({ recordsInserted: 0, recordsRemoved: 0 });
  });

  it("distinguishes a partial run from a run in which every source failed", async () => {
    const { store, dbPath, dir } = freshStore();
    const missing = join(dir, "missing.jsonl");
    await scanAndIngest(store, [fixturePath("usage-basic.jsonl"), missing]); // partial
    await scanAndIngest(store, [missing]); // every source failed
    store.close();

    const [allFailed, partial] = createAnalysis(dbPath).runHistory(PAGE).data?.items ?? [];
    expect(partial).toMatchObject({ kind: "partial", errorCode: null, sourcesRequested: 2 });
    expect(partial?.counts?.sources).toMatchObject({ new: 1, failed: 1 });
    expect(allFailed).toMatchObject({ kind: "failed", errorCode: null, sourcesRequested: 1 });
    expect(allFailed?.counts).toEqual({ sources: { new: 0, unchanged: 0, appended: 0, modified: 0, failed: 1 }, recordsInserted: 0, recordsRemoved: 0 });
  });

  it("marks a rolled-back run with its fixed code and records no counts for it", async () => {
    const { store, dbPath } = freshStore();
    store.db.exec("CREATE TRIGGER block_results BEFORE INSERT ON source_scan_results BEGIN SELECT RAISE(ABORT, 'CANARY_DB_ERROR_TEXT /Users/secret/path'); END");
    const input = await readSource(store, fixturePath("usage-basic.jsonl"));
    expect(() => ingestSources(store, [input])).toThrow(IngestError);
    store.close();

    const [run] = createAnalysis(dbPath).runHistory(PAGE).data?.items ?? [];
    expect(run).toMatchObject({ kind: "rolled-back", counts: null, sourcesRequested: 1 });
    expect(run?.errorCode).toMatch(/^SQLITE_\d+$/);
    expect(JSON.stringify(run)).not.toContain("CANARY_DB_ERROR_TEXT");
  });

  it("does not turn an unfinished run's default counters into zeros", () => {
    const { store, dbPath } = freshStore();
    seedRun(store, { startedAt: "2026-04-01T00:00:00.000Z", status: "running", finishedAt: null, requested: 3 });
    store.close();

    const [run] = createAnalysis(dbPath).runHistory(PAGE).data?.items ?? [];
    expect(run).toMatchObject({ kind: "unfinished", finishedAt: null, counts: null, sourcesRequested: 3 });
  });

  it("keeps a stored zero as zero", () => {
    const { store, dbPath } = freshStore();
    seedRun(store, { startedAt: "2026-04-01T00:00:00.000Z", requested: 1, counts: [0, 1, 0, 0, 0] });
    store.close();

    const [run] = createAnalysis(dbPath).runHistory(PAGE).data?.items ?? [];
    expect(run?.counts).toEqual({ sources: { new: 0, unchanged: 1, appended: 0, modified: 0, failed: 0 }, recordsInserted: 0, recordsRemoved: 0 });
  });

  it("fails closed on a status this version does not know, without echoing it", () => {
    const { store, dbPath } = freshStore();
    store.db.exec("PRAGMA ignore_check_constraints = ON");
    seedRun(store, { startedAt: "2026-04-01T00:00:00.000Z", status: "CANARY_STATUS_TEXT" });
    store.close();

    const response = createAnalysis(dbPath).runHistory(PAGE);
    expect(response).toEqual({ state: "unavailable", data: null, errorCode: "QUERY_FAILED" });
    expect(JSON.stringify(response)).not.toContain("CANARY_STATUS_TEXT");
  });

  it("replaces a stored code or timestamp that is not a fixed word or an ISO time", () => {
    const { store, dbPath } = freshStore();
    seedRun(store, { startedAt: "/Users/someone/CANARY_TIME_PATH", finishedAt: "CANARY_TIME_PATH", status: "failed", errorCode: "boom at /Users/x/CANARY_CODE_PATH" });
    store.close();

    const response = createAnalysis(dbPath).runHistory(PAGE);
    expect(response.data?.items[0]).toMatchObject({ errorCode: "UNKNOWN_CODE", startedAt: null, finishedAt: null });
    expect(JSON.stringify(response)).not.toMatch(/CANARY_|\/Users/);
  });
});

describe("run detail service", () => {
  it("returns per-source outcomes, codes and diagnostics of a partial run", async () => {
    const { store, dbPath, dir } = freshStore();
    await scanAndIngest(store, [fixturePath("malformed-lines.jsonl"), join(dir, "missing.jsonl")]);
    store.close();

    const detail = createAnalysis(dbPath).runDetail(detailQuery(1)).data;
    expect(detail?.run).toMatchObject({ id: 1, kind: "partial" });
    expect(detail?.sources.map((s) => [s.ordinal, s.outcome])).toEqual([[1, "new"], [2, "failed"]]);
    expect(detail?.sources[1]?.errorCode).toMatch(/^[A-Z_]+$/);
    expect(detail?.sourceErrorCodes).toEqual({ [detail?.sources[1]?.errorCode ?? ""]: 1 });
    expect(detail?.sources[0]?.skippedLines.malformed).toBeGreaterThan(0);
    expect(detail?.sourcePage).toEqual({ limit: PAGE_LIMIT_DEFAULT, offset: 0, total: 2 });
  });

  it("reports an unknown run as run: null, and a rolled-back run with no sources", async () => {
    const { store, dbPath } = freshStore();
    seedRun(store, { startedAt: "2026-05-01T00:00:00.000Z", status: "failed", errorCode: "SQLITE_13", requested: 2 });
    store.close();
    const a = createAnalysis(dbPath);

    expect(a.runDetail(detailQuery(999)).data).toMatchObject({ run: null, sources: [], sourcePage: { total: 0 } });
    expect(a.runDetail(detailQuery(1)).data).toMatchObject({ run: { kind: "rolled-back", errorCode: "SQLITE_13", counts: null }, sources: [], sourcePage: { total: 0 } });
  });

  it("pages the sources of a run", async () => {
    const { store, dbPath } = freshStore();
    await scanAndIngest(store, ["usage-basic.jsonl", "replay-a.jsonl", "replay-b.jsonl"].map(fixturePath));
    store.close();
    const a = createAnalysis(dbPath);

    const page = a.runDetail({ id: 1, limit: 2, offset: 2 }).data;
    expect(page?.sources.map((s) => s.ordinal)).toEqual([3]);
    expect(page?.sourcePage).toEqual({ limit: 2, offset: 2, total: 3 });
  });
});

describe("run history parameters", () => {
  const parse = (query: string) => parseRunsQuery(new URLSearchParams(query));

  it("defaults, bounds and rejects with the parameter name only", () => {
    expect(parse("")).toEqual({ ok: true, value: { limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
    expect(parse(`limit=${PAGE_LIMIT_MAX}`)).toMatchObject({ ok: true });
    expect(parse(`limit=${PAGE_LIMIT_MAX + 1}`)).toEqual({ ok: false, parameter: "limit" });
    expect(parse("limit=0")).toEqual({ ok: false, parameter: "limit" });
    expect(parse("offset=-1")).toEqual({ ok: false, parameter: "offset" });
    expect(parse("limit=1&limit=2")).toEqual({ ok: false, parameter: "limit" });
    expect(parse("sidechain=include")).toEqual({ ok: false, parameter: "sidechain" });
  });

  it("requires a positive integer run id for the detail", () => {
    const detail = (query: string) => parseRunDetailQuery(new URLSearchParams(query));
    expect(detail("id=12")).toEqual({ ok: true, value: { id: 12, limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
    for (const bad of ["", "id=", "id=0", "id=-3", "id=abc", "id=1.5", "id=1&id=2", "id=99999999"]) expect(detail(bad)).toEqual({ ok: false, parameter: "id" });
    expect(detail("id=1&path=/etc/passwd")).toEqual({ ok: false, parameter: "path" });
  });
});

describe("run history routes", () => {
  const saved = process.env[DATABASE_PATH_ENV];
  beforeEach(() => {
    process.env[DATABASE_PATH_ENV] = join(tempDir(), "never-created", "usage.db");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
    else process.env[DATABASE_PATH_ENV] = saved;
  });
  const call = (handler: (r: Request) => Response, path: string) => handler(new Request(`http://127.0.0.1:3210${path}`));

  it("answers 200 with a no-database state and creates nothing", async () => {
    const target = process.env[DATABASE_PATH_ENV] ?? "";
    for (const [path, handler] of [["/api/runs", runs], ["/api/runs/detail?id=1", runDetail]] as const) {
      const response = call(handler, path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    }
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("serves the documented envelope and headers, and the same values as the service", async () => {
    const { dbPath } = await populatedDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const response = call(runs, "/api/runs?limit=10");
    const body = (await response.json()) as { state: string; data: { items: unknown[] }; errorCode: null };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Object.keys(body).sort()).toEqual(["data", "errorCode", "state"]);
    expect(body).toEqual(JSON.parse(JSON.stringify(createAnalysis(dbPath).runHistory({ limit: 10, offset: 0 }))));
    expect(body.data.items.length).toBeGreaterThan(0);
  });

  it("answers 400 naming only the parameter, before opening the database", async () => {
    for (const path of ["/api/runs?limit=9999", "/api/runs?x=1", "/api/runs/detail", "/api/runs/detail?id=../../etc/passwd"]) {
      const response = call(path.startsWith("/api/runs/detail") ? runDetail : runs, path);
      expect(response.status).toBe(400);
      const text = JSON.stringify(await response.json());
      expect(text).toContain("INVALID_PARAMETER");
      expect(text).not.toContain("passwd");
    }
    expect(existsSync(join(process.env[DATABASE_PATH_ENV] ?? "", ".."))).toBe(false);
  });

  it("answers 503 with a fixed code for an unusable database", async () => {
    process.env[DATABASE_PATH_ENV] = databaseAtVersion(1);
    const response = call(runs, "/api/runs");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
  });
});

describe("run history privacy", () => {
  it("exposes no path, label, fingerprint, salt, canary or database error text", async () => {
    const { dbPath, base } = await populatedDatabase();
    const raw = new DatabaseSync(dbPath);
    // Plant text a leak would show: a source label, a path-like label, and a failed source with a message-like code.
    raw.exec("UPDATE source_files SET label = '/Users/someone/CANARY_LABEL_PATH_91ce/transcript.jsonl'");
    raw.close();
    const store = freshStoreSalt(dbPath);

    const a = createAnalysis(dbPath);
    const ids = (a.runHistory({ limit: 200, offset: 0 }).data?.items ?? []).map((r) => r.id);
    const text = JSON.stringify([a.runHistory({ limit: 200, offset: 0 }), ...ids.map((id) => a.runDetail({ id, limit: 200, offset: 0 }))]);

    expect(ids.length).toBeGreaterThan(0);
    for (const canary of [...ALL_CANARIES, "CANARY_LABEL_PATH_91ce", "transcript.jsonl", "usage-basic", "replay-a", base, dbPath, store.salt, "workspace-secret-name"]) expect(text).not.toContain(canary);
    expect(text).not.toMatch(/\/Users\/|\/private\/var|\/tmp\//);
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
    expect(text).not.toMatch(/"(label|fingerprint|path|sourceFileId|source_file_id)"/i);
  });

  it("does not write: the database file is byte-identical after reading history", async () => {
    const { dbPath } = await populatedDatabase();
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(dbPath);
    const a = createAnalysis(dbPath);
    a.runHistory(PAGE);
    a.runDetail(detailQuery(1));

    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});

function freshStoreSalt(dbPath: string): { salt: string } {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string } | undefined;
  raw.close();
  return { salt: row?.value ?? "no-salt-found" };
}
