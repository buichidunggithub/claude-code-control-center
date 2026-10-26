import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import HistoryPage from "@/app/history/page";
import { HistoryView } from "@/components/dashboard/history-view";
import { Shell } from "@/components/dashboard/shell";
import { createAnalysis } from "@/core/analysis";
import { ingestSources, readSource, scanAndIngest, type Store } from "@/core/store";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { ALL_CANARIES, databaseAtVersion, populatedDatabase } from "./analysis-helpers";
import { fixturePath } from "./helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";
import { existsSync } from "node:fs";
import { join } from "node:path";

registerTempStoreCleanup();

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const plain = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const PAGE = { limit: 50, offset: 0 } as const;

function view(dbPath: string, selectedId: number | null = null) {
  const a = createAnalysis(dbPath);
  return html(h(HistoryView, { runs: a.runHistory(PAGE), detail: selectedId === null ? null : a.runDetail({ id: selectedId, ...PAGE }), selectedId }));
}

/** The rows of the first table (the run list), without the surrounding card text. */
const tableBody = (markup: string): string => markup.slice(markup.indexOf("<tbody>"), markup.indexOf("</tbody>"));

/** Rolls back one scan so the history holds a run with no recorded counters. */
async function rolledBack(store: Store): Promise<void> {
  store.db.exec("CREATE TRIGGER block BEFORE INSERT ON source_scan_results BEGIN SELECT RAISE(ABORT, 'x'); END");
  const input = await readSource(store, fixturePath("usage-basic.jsonl"));
  expect(() => ingestSources(store, [input])).toThrow();
  store.db.exec("DROP TRIGGER block");
}

describe("run history view", () => {
  it("explains a missing database and says nothing was created", () => {
    const target = join(tempDir(), "missing", "usage.db");
    const text = plain(view(target));

    expect(text).toContain("No database yet");
    expect(text).toContain("nothing was created");
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("explains an empty history", () => {
    const { store, dbPath } = freshStore();
    store.close();

    expect(plain(view(dbPath))).toContain("No scan has been recorded in this database yet.");
  });

  it("shows an alert with a fixed code for an unusable database", () => {
    const out = view(databaseAtVersion(1));

    expect(out).toContain('role="alert"');
    expect(plain(out)).toContain("SCHEMA_OUTDATED");
  });

  it("lists runs with status, counts and records, and shows stored zeros as 0", async () => {
    const { dbPath } = await populatedDatabase({ config: false });
    const text = plain(view(dbPath));

    expect(text).toContain("Scan runs");
    expect(text).toContain("Completed");
    expect(text).toContain("#1");
    expect(text).toContain("Records inserted");
    expect(tableBody(view(dbPath))).not.toContain("not recorded");
    expect(text).toContain("it is not zero");
  });

  it("shows a figure that was never stored as not recorded, never as 0", async () => {
    const { store, dbPath } = freshStore();
    await scanAndIngest(store, [fixturePath("usage-basic.jsonl")]);
    await rolledBack(store);
    store.close();

    const out = view(dbPath);
    const rows = tableBody(out).split("<tr").slice(1);
    const rolledRow = rows.find((row) => row.includes("#2")) ?? "";
    const okRow = rows.find((row) => row.includes("#1")) ?? "";

    expect(rolledRow).toContain("Failed (rolled back)");
    expect(rolledRow.match(/not recorded/g)?.length).toBe(7);
    expect(okRow).not.toContain("not recorded");
  });

  it("labels partial, all-failed and rolled-back runs distinctly and never as completed", async () => {
    const { store, dbPath, dir } = freshStore();
    await scanAndIngest(store, [fixturePath("usage-basic.jsonl"), join(dir, "missing.jsonl")]);
    await scanAndIngest(store, [join(dir, "missing.jsonl")]);
    await rolledBack(store);
    store.close();

    const out = view(dbPath);
    for (const [id, label] of [[1, "Partial"], [2, "Failed (all sources)"], [3, "Failed (rolled back)"]] as const) {
      const row = tableBody(out).split("<tr").find((r) => r.includes(`#${id}`)) ?? "";
      expect(row).toContain(label);
      expect(row).not.toContain("Completed");
    }
  });

  it("shows the selected run's diagnostics, fixed codes and numbered sources, and marks the selection", async () => {
    const { store, dbPath, dir } = freshStore();
    await scanAndIngest(store, [fixturePath("malformed-lines.jsonl"), join(dir, "missing.jsonl")]);
    store.close();

    const out = view(dbPath, 1);
    const text = plain(out);
    expect(text).toContain("Run #1");
    expect(text).toContain("Source error codes:");
    expect(text).toMatch(/Source error codes: [A-Z_]+: 1/);
    expect(text).toContain("Malformed lines");
    expect(text).toContain("Showing 2 of 2 sources");
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain('aria-current="true"');
  });

  it("says so when the selected run is not stored", async () => {
    const { dbPath } = await populatedDatabase({ config: false });

    expect(plain(view(dbPath, 4242))).toContain("No run with that number is stored.");
  });

  it("explains each non-complete kind in words", async () => {
    const { store, dbPath } = freshStore();
    await rolledBack(store);
    store.close();

    expect(plain(view(dbPath, 1))).toContain("writes were rolled back, so no records came from it");
  });

  it("contains no canary, path, remote asset or script", async () => {
    const { dbPath, base } = await populatedDatabase();
    for (const out of [view(dbPath), view(dbPath, 1)]) {
      for (const canary of ALL_CANARIES) expect(out).not.toContain(canary);
      expect(out).not.toContain(base);
      expect(out).not.toContain(dbPath);
      expect(out).not.toMatch(/https?:\/\//);
      expect(out).not.toMatch(/<script|<img|<link|@import/);
      expect(out).not.toMatch(/\/Users\/|\/private\/var|\/tmp\//);
    }
  });

  it("is in the navigation, marked current only on its own page", () => {
    const own = html(<Shell active="history" title="Run history"><p>x</p></Shell>);
    const other = html(<Shell active="usage" title="Usage"><p>x</p></Shell>);

    expect(own).toMatch(/href="\/history"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/history"/);
    expect(other).toContain('href="/history"');
    expect(other.match(/aria-current/g)).toHaveLength(1);
  });
});

describe("history page route component", () => {
  const saved = process.env[DATABASE_PATH_ENV];
  beforeEach(() => {
    process.env[DATABASE_PATH_ENV] = join(tempDir(), "missing", "usage.db");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
    else process.env[DATABASE_PATH_ENV] = saved;
  });
  const render = async (search: Record<string, string | string[]>) => plain(html(await HistoryPage({ searchParams: Promise.resolve(search) })));

  it("renders an empty state without creating the database", async () => {
    const target = process.env[DATABASE_PATH_ENV] ?? "";

    expect(await render({})).toContain("No database yet");
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("selects a run from the query and ignores invalid selections or paging with a notice", async () => {
    process.env[DATABASE_PATH_ENV] = (await populatedDatabase({ config: false })).dbPath;

    expect(await render({ run: "1" })).toContain("Run #1");
    const invalid: Record<string, string | string[]>[] = [{ run: "abc" }, { run: ["1", "2"] }, { run: "0" }, { limit: "9999" }, { other: "1" }];
    for (const search of invalid) {
      const text = await render(search);
      expect(text).toContain("The request is not valid");
      expect(text).not.toContain("Run #");
      expect(text).toContain("Scan runs");
    }
  });
});
