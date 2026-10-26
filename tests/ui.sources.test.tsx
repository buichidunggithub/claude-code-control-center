import { existsSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SourcesPage from "@/app/sources/page";
import { Shell } from "@/components/dashboard/shell";
import { SourcesView } from "@/components/dashboard/sources-view";
import { createAnalysis } from "@/core/analysis";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { ALL_CANARIES, databaseAtVersion, populatedDatabase } from "./analysis-helpers";
import { FILE_CANARY, LABEL_CANARY, PATH_CANARY, workspace, type Workspace } from "./sources-helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const plain = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const PAGE = { limit: 50, offset: 0 } as const;
const tableBody = (markup: string): string => markup.slice(markup.indexOf("<tbody>"), markup.indexOf("</tbody>"));

function view(dbPath: string, selectedRef: string | null = null): string {
  const a = createAnalysis(dbPath);
  return html(h(SourcesView, { sources: a.sourceCoverage(PAGE), detail: selectedRef === null ? null : a.sourceDetail({ ref: selectedRef, ...PAGE }), selectedRef }));
}

const firstRef = (dbPath: string): string => createAnalysis(dbPath).sourceCoverage(PAGE).data?.items[0]?.ref ?? "";

async function twoSources(): Promise<{ w: Workspace; a: string; b: string }> {
  const w = workspace();
  const a = w.write("a", ["m1"]);
  const b = w.write("b", ["n1"]);
  await w.ingest([a, b], LABEL_CANARY);
  await w.ingest([a]); // b is not asked for
  return { w, a, b };
}

describe("source coverage view", () => {
  it("explains a missing database and says nothing was created", () => {
    const target = join(tempDir(), "missing", "usage.db");
    const text = plain(view(target));

    expect(text).toContain("No database yet");
    expect(text).toContain("nothing was created");
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("explains an empty database", () => {
    const { store, dbPath } = freshStore();
    store.close();

    expect(plain(view(dbPath))).toContain("No source has been recorded in this database yet.");
  });

  it("shows an alert with a fixed code for an unusable database", () => {
    const out = view(databaseAtVersion(1));

    expect(out).toContain('role="alert"');
    expect(plain(out)).toContain("SCHEMA_OUTDATED");
  });

  it("lists sources by opaque reference with outcomes, counts and run links, and the caveat", async () => {
    const { w } = await twoSources();
    w.store.close();
    const out = view(w.dbPath);
    const text = plain(out);

    expect(text).toContain("Observed sources");
    expect(text).toContain("Newest committed run: #2 (completed).");
    expect(out).toMatch(/href="\/history\?run=1"/);
    expect(out).toMatch(/href="\/sources\?source=[0-9a-f]{32}"/);
    expect(text).toContain("not all Claude Code activity");
    expect(text).toContain("does not show that a source still exists or that coverage is complete");
    expect(text).toContain("has a result");
    expect(text).toContain("no result");
  });

  it("never states or implies deletion or complete coverage except in negated caveats", async () => {
    const { w } = await twoSources();
    w.store.close();
    const text = plain(view(w.dbPath, firstRef(w.dbPath)));

    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences.filter((s) => /\b(delet\w*|gone|missing|removed from disk|complete coverage|all (claude code )?activity)\b/i.test(s))) {
      expect(sentence).toMatch(/\b(not|no|never|without|nor)\b/i);
    }
    expect(text).not.toMatch(/\b(source|file) (was|is|has been) (deleted|removed)\b/i);
  });

  it("shows a failed read's figures as not recorded and a counted zero as 0", async () => {
    const { w, a } = await twoSources();
    w.remove(a);
    await w.ingest([a]);
    w.store.close();
    const out = view(w.dbPath, firstRef(w.dbPath));
    const text = plain(out);

    expect(text).toContain("Recorded history of the selected source");
    const history = out.slice(out.lastIndexOf("<tbody>"), out.lastIndexOf("</tbody>")).split("<tr").slice(1);
    const failedRow = history.find((row) => row.includes(">failed<")) ?? "";
    const unchangedRow = history.find((row) => row.includes(">unchanged<")) ?? "";
    expect(failedRow.match(/not recorded/g)?.length).toBe(7); // six figures and the identity flag
    expect(failedRow).toContain("ENOENT");
    expect(unchangedRow).not.toContain("not recorded");
    expect(unchangedRow).toMatch(/text-right">0</);
  });

  it("marks a known history gap as incomplete", async () => {
    const { w } = await twoSources();
    w.store.db.exec("DELETE FROM source_scan_results WHERE scan_run_id = 1");
    w.store.close();

    expect(plain(view(w.dbPath))).toContain("history incomplete");
    expect(plain(view(w.dbPath, firstRef(w.dbPath)))).toContain("incomplete");
  });

  it("says so when the selected source is not stored, and marks the selection otherwise", async () => {
    const { w } = await twoSources();
    w.store.close();

    expect(plain(view(w.dbPath, "0".repeat(32)))).toContain("No source with that reference is stored.");
    const selected = view(w.dbPath, firstRef(w.dbPath));
    expect(selected).toContain('aria-selected="true"');
    expect(selected).toContain('aria-current="true"');
    expect(tableBody(selected)).toContain("aria-selected");
  });

  it("contains no path, label, canary, fingerprint, remote asset or script", async () => {
    const { w } = await twoSources();
    w.store.close();
    for (const out of [view(w.dbPath), view(w.dbPath, firstRef(w.dbPath))]) {
      for (const secret of [PATH_CANARY, FILE_CANARY, LABEL_CANARY, w.dbPath, ...ALL_CANARIES]) expect(out).not.toContain(secret);
      expect(out).not.toMatch(/https?:\/\//);
      expect(out).not.toMatch(/<script|<img|<link|@import/);
      expect(out).not.toMatch(/\/Users\/|\/private\/var|\/tmp\//);
      expect(out).not.toMatch(/[0-9a-f]{33,}/);
    }
  });

  it("is in the navigation, marked current only on its own page", () => {
    const own = html(<Shell active="sources" title="Source coverage"><p>x</p></Shell>);
    const other = html(<Shell active="history" title="Run history"><p>x</p></Shell>);

    expect(own).toMatch(/href="\/sources"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/sources"/);
    expect(other).toContain('href="/sources"');
    expect(other.match(/aria-current/g)).toHaveLength(1);
  });
});

describe("sources page route component", () => {
  const saved = process.env[DATABASE_PATH_ENV];
  beforeEach(() => {
    process.env[DATABASE_PATH_ENV] = join(tempDir(), "missing", "usage.db");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
    else process.env[DATABASE_PATH_ENV] = saved;
  });
  const render = async (search: Record<string, string | string[]>) => plain(html(await SourcesPage({ searchParams: Promise.resolve(search) })));

  it("renders an empty state without creating the database", async () => {
    expect(await render({})).toContain("No database yet");
    expect(existsSync(join(process.env[DATABASE_PATH_ENV] ?? "", ".."))).toBe(false);
  });

  it("selects a source from the query and rejects malformed selections or paging with a notice", async () => {
    const { dbPath } = await populatedDatabase({ config: false });
    process.env[DATABASE_PATH_ENV] = dbPath;
    const ref = firstRef(dbPath);

    expect(await render({ source: ref })).toContain(`Source ${ref.slice(0, 12)}`);
    const invalid: Record<string, string | string[]>[] = [{ source: "abc" }, { source: [ref, ref] }, { source: ref.toUpperCase() }, { limit: "9999" }, { other: "1" }];
    for (const search of invalid) {
      const text = await render(search);
      expect(text).toContain("The request is not valid");
      expect(text).not.toContain("Recorded history of the selected source");
      expect(text).toContain("Observed sources");
    }
  });
});
