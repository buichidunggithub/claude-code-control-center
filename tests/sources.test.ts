import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as sourceDetailRoute } from "@/app/api/sources/detail/route";
import { GET as sourcesRoute } from "@/app/api/sources/route";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, createAnalysis, parseSourceDetailQuery, parseSourcesQuery } from "@/core/analysis";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { ALL_CANARIES, databaseAtVersion, populatedDatabase } from "./analysis-helpers";
import { FILE_CANARY, LABEL_CANARY, PATH_CANARY, workspace, type Workspace } from "./sources-helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const PAGE = { limit: PAGE_LIMIT_DEFAULT, offset: 0 } as const;
const detailOf = (ref: string, limit = PAGE_LIMIT_DEFAULT, offset = 0) => ({ ref, limit, offset });
const NO_REF = "0".repeat(32);

/** Source A: new, unchanged, appended, modified. Source B: read twice, then left out of the newest run. */
async function history(): Promise<{ w: Workspace; a: string; b: string }> {
  const w = workspace();
  const a = w.write("a", ["m1"]);
  const b = w.write("b", ["n1", "n2"]);
  await w.ingest([a, b]); // run 1: both new
  await w.ingest([a, b]); // run 2: both unchanged
  await w.ingest([a]); // run 3: only A (unchanged); B is simply not asked for
  return { w, a, b };
}

describe("source coverage service", () => {
  it("reports an empty database as ok with no sources", () => {
    const { store, dbPath } = freshStore();
    store.close();

    expect(createAnalysis(dbPath).sourceCoverage(PAGE)).toEqual({
      state: "ok",
      errorCode: null,
      data: expect.objectContaining({ total: 0, items: [], latestCommittedRun: null }),
    });
  });

  it("reports a missing database as no-database and creates nothing", () => {
    const target = join(tempDir(), "never-created", "usage.db");
    const a = createAnalysis(target);

    expect(a.sourceCoverage(PAGE)).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    expect(a.sourceDetail(detailOf(NO_REF))).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("reports an outdated schema with a fixed code and does not migrate it", () => {
    const old = databaseAtVersion(1);

    expect(createAnalysis(old).sourceCoverage(PAGE)).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
    const raw = new DatabaseSync(old, { readOnly: true });
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    raw.close();
  });

  it("counts outcomes across runs and keeps a counted zero distinct from a missing figure", async () => {
    const { w, a, b } = await history();
    w.write("a", ["m1", "m2"]);
    await w.ingest([a]); // run 4: appended
    w.write("a", ["m9"]);
    await w.ingest([a]); // run 5: modified
    w.store.close();

    const page = createAnalysis(w.dbPath).sourceCoverage(PAGE).data;
    const [first, second] = page?.items ?? [];
    expect(page?.total).toBe(2);
    expect(first?.outcomes).toEqual({ new: 1, unchanged: 2, appended: 1, modified: 1, failed: 0 });
    expect(first?.resultCount).toBe(5);
    expect(second?.outcomes).toEqual({ new: 1, unchanged: 1, appended: 0, modified: 0, failed: 0 });
    expect(second?.resultCount).toBe(2);
    expect(b.length).toBeGreaterThan(0);
  });

  it("does not present absence from the newest run as deletion", async () => {
    const { w, b } = await history();
    w.store.close();

    const page = createAnalysis(w.dbPath).sourceCoverage(PAGE).data;
    const present = page?.items.find((s) => s.inLatestCommittedRun === true);
    const absent = page?.items.find((s) => s.inLatestCommittedRun === false);
    expect(page?.latestCommittedRun).toMatchObject({ runId: 3, kind: "complete" });
    expect(present?.latestResult).toMatchObject({ runId: 3, outcome: "unchanged" });
    // B was last asked for in run 2: its stored records and last-read run are unchanged, and nothing says it is gone.
    expect(absent).toMatchObject({ recordsStored: 2, lastRead: { runId: 2 }, latestResult: { runId: 2, outcome: "unchanged" }, historyIncomplete: false });
    expect(JSON.stringify(page?.items)).not.toMatch(/delet|missing|gone|removed from disk/i); // the caveat note says "without being deleted"; only the data is checked here
    expect(existsSync(b)).toBe(true);
  });

  it("orders sources by most recent observation, then by a deterministic tie-break, and pages them", async () => {
    const w = workspace();
    const files = ["a", "b", "c", "d"].map((n) => w.write(n, [`${n}1`]));
    await w.ingest(files); // all four share one run and one start time
    w.store.close();
    const svc = createAnalysis(w.dbPath);

    const all = svc.sourceCoverage(PAGE).data?.items.map((s) => s.ref) ?? [];
    const again = svc.sourceCoverage(PAGE).data?.items.map((s) => s.ref) ?? [];
    expect(all).toHaveLength(4);
    expect(again).toEqual(all);
    const paged = [0, 2].flatMap((offset) => svc.sourceCoverage({ limit: 2, offset }).data?.items.map((s) => s.ref) ?? []);
    expect(paged).toEqual(all);
    expect(svc.sourceCoverage({ limit: 2, offset: 100 }).data).toMatchObject({ items: [], total: 4 });
  });

  it("breaks an equal-observation tie by the later-stored source first, and ranks recency above storage order", async () => {
    const tied = workspace();
    await tied.ingest(["a", "b", "c", "d"].map((n, i) => tied.write(n, Array.from({ length: i + 1 }, (_, k) => `${n}${k}`)))); // stored 1, 2, 3, 4 records
    tied.store.close();
    const stored = (dbPath: string) => createAnalysis(dbPath).sourceCoverage(PAGE).data?.items.map((s) => s.recordsStored);
    expect(stored(tied.dbPath)).toEqual([4, 3, 2, 1]);

    const recency = workspace();
    const a = recency.write("a", ["a0"]); // 1 record, stored first
    const b = recency.write("b", ["b0", "b1"]); // 2 records, stored second
    await recency.ingest([a, b]);
    await recency.ingest([a]); // a is now the most recently observed even though b was stored later
    recency.store.close();
    expect(stored(recency.dbPath)).toEqual([1, 2]);
  });

  it("ranks by run id when two runs share a start time, so the list agrees with each source's own latest result", async () => {
    const { w } = await history(); // source A last seen in run 3, source B in run 2 (stored later than A)
    w.store.db.exec("UPDATE scan_runs SET started_at = '2026-01-01T00:00:00.000Z'");
    w.store.close();

    const items = createAnalysis(w.dbPath).sourceCoverage(PAGE).data?.items;
    expect(items?.map((s) => s.latestResult?.runId)).toEqual([3, 2]);
  });

  it("reports no comparison (null) when no committed run exists", () => {
    const { store, dbPath } = freshStore();
    store.db.exec("INSERT INTO scan_runs (started_at, finished_at, status, error_code, sources_requested) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', 'failed', 'SQLITE_13', 1)");
    store.db.exec("INSERT INTO source_files (fingerprint, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id) VALUES ('f', 'h', 0, 1, 1, 1)");
    store.close();

    const page = createAnalysis(dbPath).sourceCoverage(PAGE).data;
    expect(page?.latestCommittedRun).toBeNull();
    expect(page?.items[0]).toMatchObject({ inLatestCommittedRun: null, latestResult: null, resultCount: 0, historyIncomplete: true, recordsStored: 0 });
  });

  it("derives a stable, opaque, unique reference that is not any stored identifier", async () => {
    const { w } = await history();
    const raw = new DatabaseSync(w.dbPath, { readOnly: true });
    const stored = (raw.prepare("SELECT fingerprint FROM source_files").all() as { fingerprint: string }[]).map((r) => r.fingerprint);
    const salt = (raw.prepare("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string }).value;
    raw.close();
    w.store.close();
    const svc = createAnalysis(w.dbPath);

    const refs = svc.sourceCoverage(PAGE).data?.items.map((s) => s.ref) ?? [];
    expect(refs).toEqual(svc.sourceCoverage(PAGE).data?.items.map((s) => s.ref));
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) {
      expect(ref).toMatch(/^[0-9a-f]{32}$/);
      for (const fp of stored) expect(fp.includes(ref) || ref.includes(fp.slice(0, 16))).toBe(false);
      expect(salt.includes(ref)).toBe(false);
    }
  });

  it("returns a source's recorded history newest first with per-run counts", async () => {
    const { w, a } = await history();
    w.write("a", ["m1", "m2"]);
    await w.ingest([a]); // run 4: appended
    w.store.close();
    const svc = createAnalysis(w.dbPath);

    const ref = svc.sourceCoverage(PAGE).data?.items[0]?.ref ?? "";
    const detail = svc.sourceDetail(detailOf(ref)).data;
    expect(detail?.history.map((h) => [h.run.runId, h.outcome])).toEqual([[4, "appended"], [3, "unchanged"], [2, "unchanged"], [1, "new"]]);
    expect(detail?.history[0]?.counts).toMatchObject({ recordsInserted: 2, recordsRemoved: 1, recordsRetained: 1, usageRecordsParsed: 2 });
    expect(detail?.history[1]?.counts).toMatchObject({ recordsInserted: 0, recordsRemoved: 0, recordsRetained: 1 });
    expect(detail?.history[3]?.counts).toMatchObject({ recordsInserted: 1, recordsRemoved: 0, recordsRetained: 0 });
    expect(detail?.history[0]?.run).toMatchObject({ kind: "complete" });
    expect(detail?.historyPage).toEqual({ limit: PAGE_LIMIT_DEFAULT, offset: 0, total: 4 });
    expect(detail?.source).toMatchObject({ resultCount: 4, recordsStored: 2, historyIncomplete: false });
  });

  it("pages a source's history", async () => {
    const { w } = await history();
    w.store.close();
    const svc = createAnalysis(w.dbPath);
    const ref = svc.sourceCoverage(PAGE).data?.items[0]?.ref ?? "";

    const pages = [0, 2].map((offset) => svc.sourceDetail(detailOf(ref, 2, offset)).data);
    expect(pages.map((p) => p?.history.map((h) => h.run.runId))).toEqual([[3, 2], [1]]);
    expect(pages.map((p) => p?.historyPage.total)).toEqual([3, 3]);
  });

  it("marks a failed read as not recorded (null counts), never as zero, and keeps the stored records", async () => {
    const { w, a } = await history();
    w.remove(a);
    await w.ingest([a]); // run 4: ENOENT on a source that is already stored, so it is attributed
    w.store.close();
    const svc = createAnalysis(w.dbPath);

    const ref = svc.sourceCoverage(PAGE).data?.items[0]?.ref ?? "";
    const detail = svc.sourceDetail(detailOf(ref)).data;
    expect(detail?.history[0]).toMatchObject({ outcome: "failed", errorCode: "ENOENT", counts: null, run: { kind: "failed" } });
    expect(detail?.source).toMatchObject({ recordsStored: 1, outcomes: { failed: 1 }, lastRead: { runId: 3 }, latestResult: { outcome: "failed", runId: 4 } });
    // A failed read does not move "last read", and a failed run is not complete coverage.
    expect(svc.sourceCoverage(PAGE).data?.latestCommittedRun).toMatchObject({ runId: 4, kind: "failed" });
  });

  it("does not attribute a failed read of a source that was never stored, and says history is a lower bound", async () => {
    const w = workspace();
    const ok = w.write("ok", ["m1"]);
    const ghost = w.write("ghost", ["g1"]);
    w.remove(ghost);
    await w.ingest([ok, ghost]); // partial: ghost fails but was never stored
    w.store.close();
    const svc = createAnalysis(w.dbPath);

    const page = svc.sourceCoverage(PAGE).data;
    expect(page?.total).toBe(1);
    expect(page?.latestCommittedRun).toMatchObject({ kind: "partial" });
    expect(page?.items[0]?.outcomes.failed).toBe(0);
    expect(page?.note).toMatch(/cannot be attributed/);
  });

  it("flags history as incomplete when the first-seen run has no recorded result", async () => {
    const { w } = await history();
    w.store.db.exec("DELETE FROM source_scan_results WHERE scan_run_id = 1");
    w.store.close();

    const page = createAnalysis(w.dbPath).sourceCoverage(PAGE).data;
    expect(page?.items.every((s) => s.historyIncomplete)).toBe(true);
  });

  it("answers an unknown but well-formed reference with source: null", async () => {
    const { w } = await history();
    w.store.close();

    expect(createAnalysis(w.dbPath).sourceDetail(detailOf(NO_REF))).toEqual({
      state: "ok",
      errorCode: null,
      data: expect.objectContaining({ source: null, history: [], historyPage: { limit: PAGE_LIMIT_DEFAULT, offset: 0, total: 0 } }),
    });
  });

  it("fails closed on an outcome this version does not know, without echoing it", async () => {
    const { w } = await history();
    w.store.close();
    const raw = new DatabaseSync(w.dbPath);
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.exec("UPDATE source_scan_results SET outcome = 'CANARY_OUTCOME_TEXT' WHERE id = 1");
    raw.close();
    const svc = createAnalysis(w.dbPath);

    const list = svc.sourceCoverage(PAGE);
    expect(list).toEqual({ state: "unavailable", data: null, errorCode: "QUERY_FAILED" });
    expect(JSON.stringify(list)).not.toContain("CANARY_OUTCOME_TEXT");
  });

  it("replaces a stored error code or time that is not a fixed word or an ISO time", async () => {
    const { w } = await history();
    w.store.close();
    const raw = new DatabaseSync(w.dbPath);
    raw.exec("UPDATE source_scan_results SET error_code = 'boom at /Users/x/CANARY_ERR_PATH'");
    raw.exec("UPDATE scan_runs SET started_at = '/Users/x/CANARY_TIME_PATH'");
    raw.close();
    const svc = createAnalysis(w.dbPath);

    const text = JSON.stringify([svc.sourceCoverage(PAGE), ...(svc.sourceCoverage(PAGE).data?.items ?? []).map((s) => svc.sourceDetail(detailOf(s.ref)))]);
    expect(text).toContain("UNKNOWN_CODE");
    expect(text).not.toMatch(/CANARY_|\/Users\//);
  });
});

describe("source coverage parameters", () => {
  const list = (q: string) => parseSourcesQuery(new URLSearchParams(q));
  const detail = (q: string) => parseSourceDetailQuery(new URLSearchParams(q));
  const REF = "ab".repeat(16);

  it("bounds paging and rejects everything else by parameter name only", () => {
    expect(list("")).toEqual({ ok: true, value: { limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
    expect(list(`limit=${PAGE_LIMIT_MAX}`)).toMatchObject({ ok: true });
    expect(list(`limit=${PAGE_LIMIT_MAX + 1}`)).toEqual({ ok: false, parameter: "limit" });
    expect(list("offset=-1")).toEqual({ ok: false, parameter: "offset" });
    expect(list("ref=x")).toEqual({ ok: false, parameter: "ref" });
  });

  it("accepts only a 32-character lower-case hex reference", () => {
    expect(detail(`ref=${REF}`)).toEqual({ ok: true, value: { ref: REF, limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
    for (const bad of ["", "ref=", `ref=${REF.toUpperCase()}`, "ref=abc", `ref=${REF}0`, `ref=${REF.slice(0, 31)}g`, `ref=${REF}&ref=${REF}`, "ref=../../etc/passwd", "ref=1"]) {
      expect(detail(bad)).toEqual({ ok: false, parameter: "ref" });
    }
    expect(detail(`ref=${REF}&path=/etc`)).toEqual({ ok: false, parameter: "path" });
    expect(detail(`ref=${REF}&limit=0`)).toEqual({ ok: false, parameter: "limit" });
  });
});

describe("source coverage routes", () => {
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
    for (const [path, handler] of [["/api/sources", sourcesRoute], [`/api/sources/detail?ref=${NO_REF}`, sourceDetailRoute]] as const) {
      const response = call(handler, path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    }
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("serves the documented envelope and headers, equal to the service output", async () => {
    const { dbPath } = await populatedDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const response = call(sourcesRoute, "/api/sources?limit=10");
    const body = (await response.json()) as { state: string; data: { items: { ref: string }[] }; errorCode: null };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Object.keys(body).sort()).toEqual(["data", "errorCode", "state"]);
    expect(body).toEqual(JSON.parse(JSON.stringify(createAnalysis(dbPath).sourceCoverage({ limit: 10, offset: 0 }))));
    const ref = body.data.items[0]?.ref ?? "";
    const detail = (await call(sourceDetailRoute, `/api/sources/detail?ref=${ref}`).json()) as { state: string; data: { source: { ref: string } | null } };
    expect(detail.state).toBe("ok");
    expect(detail.data.source?.ref).toBe(ref);
  });

  it("answers 400 naming only the parameter, before opening the database", async () => {
    for (const path of ["/api/sources?limit=9999", "/api/sources?x=1", "/api/sources/detail", "/api/sources/detail?ref=%2e%2e%2fsecret", "/api/sources/detail?ref=1"]) {
      const response = call(path.startsWith("/api/sources/detail") ? sourceDetailRoute : sourcesRoute, path);
      expect(response.status).toBe(400);
      const text = JSON.stringify(await response.json());
      expect(text).toContain("INVALID_PARAMETER");
      expect(text).not.toContain("secret");
    }
    expect(existsSync(join(process.env[DATABASE_PATH_ENV] ?? "", ".."))).toBe(false);
  });

  it("answers 503 with a fixed code for an unusable database", async () => {
    process.env[DATABASE_PATH_ENV] = databaseAtVersion(1);

    const response = call(sourcesRoute, "/api/sources");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
  });
});

describe("source coverage privacy", () => {
  it("exposes no path, label, fingerprint, salt, internal id, canary or database error text", async () => {
    const w = workspace();
    const a = w.write("a", ["m1"]);
    const b = w.write("b", ["n1"]);
    await w.ingest([a, b], LABEL_CANARY);
    w.remove(b);
    await w.ingest([a, b]); // attributed failure
    w.store.db.exec("CREATE TRIGGER t BEFORE INSERT ON usage_records BEGIN SELECT RAISE(ABORT, 'CANARY_DB_ERROR_TEXT /Users/q/secret'); END");
    w.write("a", ["m1", "m2"]);
    await expect(w.ingest([a])).rejects.toThrow(); // a rolled-back run, which must leave no trace in coverage
    w.store.close();
    const raw = new DatabaseSync(w.dbPath, { readOnly: true });
    const fingerprints = (raw.prepare("SELECT fingerprint FROM source_files").all() as { fingerprint: string }[]).map((r) => r.fingerprint);
    const hashes = (raw.prepare("SELECT content_hash FROM source_files").all() as { content_hash: string }[]).map((r) => r.content_hash);
    const salt = (raw.prepare("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string }).value;
    expect((raw.prepare("SELECT label FROM source_files").all() as { label: string }[]).every((r) => r.label === LABEL_CANARY)).toBe(true);
    raw.close();

    const svc = createAnalysis(w.dbPath);
    const items = svc.sourceCoverage({ limit: 200, offset: 0 }).data?.items ?? [];
    const text = JSON.stringify([svc.sourceCoverage({ limit: 200, offset: 0 }), ...items.map((s) => svc.sourceDetail(detailOf(s.ref, 200)))]);

    expect(items).toHaveLength(2);
    for (const secret of [LABEL_CANARY, PATH_CANARY, FILE_CANARY, "CANARY_DB_ERROR_TEXT", salt, w.dbPath, ...fingerprints, ...hashes, ...ALL_CANARIES]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\/Users\/|\/private\/var|\/tmp\/|\.jsonl/);
    expect(text).not.toMatch(/[0-9a-f]{33,}/);
    expect(text).not.toMatch(/"(label|fingerprint|path|id|sourceFileId|source_file_id|contentHash|salt)"/i);
  });

  it("does not write: the database file is byte-identical after reading coverage", async () => {
    const { w } = await history();
    w.store.close();
    const before = readFileSync(w.dbPath);
    const svc = createAnalysis(w.dbPath);
    const ref = svc.sourceCoverage(PAGE).data?.items[0]?.ref ?? "";
    svc.sourceCoverage(PAGE);
    svc.sourceDetail(detailOf(ref));
    svc.sourceDetail(detailOf(NO_REF));

    expect(readFileSync(w.dbPath).equals(before)).toBe(true);
  });
});
