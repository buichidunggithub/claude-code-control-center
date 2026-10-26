import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COUNTER_COMPLETENESS, TOKEN_DISCLAIMER } from "@/components/dashboard/format";
import { incompleteScanNote } from "@/components/dashboard/notice";
import { OverviewView } from "@/components/dashboard/overview-view";
import { QualityView } from "@/components/dashboard/quality-view";
import { RecommendationsView } from "@/components/dashboard/recommendations-view";
import { UsageView } from "@/components/dashboard/usage-view";
import { createAnalysis } from "@/core/analysis";
import { openStore, saveConfigInventory, scanAndIngest } from "@/core/store";
import { databaseAtVersion } from "./analysis-helpers";
import { projectRoot, scan, writeTree } from "./config-helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const PG = { sidechain: "include", limit: 200, offset: 0 } as const;
const ALL = { category: null, priority: null, limit: 200, offset: 0 } as const;
const plain = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const count = (text: string, needle: string) => text.split(needle).length - 1;

type Usage = Record<string, unknown>;
const GOOD: Usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
function ev(i: number, o: { id?: string | null; model?: string | null; usage?: Usage; day?: number } = {}): string {
  return JSON.stringify({
    type: "assistant",
    ...(o.id === null ? {} : { uuid: `u-${i}` }),
    sessionId: "s1",
    timestamp: `2026-03-0${o.day ?? 1}T10:00:00.000Z`,
    isSidechain: false,
    message: { ...(o.id === null ? {} : { id: o.id ?? `m${i}` }), role: "assistant", model: o.model === undefined ? "model-alpha" : o.model, content: [], usage: o.usage ?? GOOD },
  });
}
const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

/** A temporary database with the given files ingested in one scan (a path that does not exist makes the scan partial). */
async function dbWith(files: Record<string, string>, extraMissing: string[] = []) {
  const dir = tempDir();
  const { store, dbPath } = freshStore(dir);
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
  const result = await scanAndIngest(store, [...paths, ...extraMissing.map((n) => join(dir, n))]);
  const stored = (store.db.prepare("SELECT COUNT(*) AS n FROM usage_records").get() as { n: number }).n;
  store.close();
  return { dbPath, dir, status: result.status, stored, paths };
}

function pages(dbPath: string, from: string | null = null, to: string | null = null) {
  const a = createAnalysis(dbPath);
  const scan = a.status().data?.usage.latestScan?.status ?? null;
  return {
    overview: plain(renderToStaticMarkup(<OverviewView status={a.status()} summary={a.usageSummary({ sidechain: "include" })} config={a.configSummary()} />)),
    usage: plain(
      renderToStaticMarkup(
        <UsageView sidechain="include" from={from} to={to} models={a.usageByModel({ ...PG, limit: 50 })} days={a.usageByDay({ ...PG, from, to })} sessions={a.usageSessions({ ...PG, limit: 25 })} usageScanStatus={scan} />,
      ),
    ),
    quality: plain(renderToStaticMarkup(<QualityView status={a.status()} quality={a.usageQuality()} config={a.configSummary()} />)),
    recs: plain(renderToStaticMarkup(<RecommendationsView recommendations={a.recommendations(ALL)} usageScanStatus={scan} />)),
  };
}

describe("1. counter completeness", () => {
  const INVALID = [
    ev(1),
    ev(2, { usage: { input_tokens: 10, output_tokens: "not-a-number", cache_creation_input_tokens: 20 } }), // output invalid, cache read missing
    ev(3, { usage: { ...GOOD, cache_creation_input_tokens: null } }), // cache creation null
    ev(10, { id: "c", usage: { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } }),
    ev(11, { id: "c", usage: { input_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } }), // same identity, output missing
  ];

  it("states the real aggregation on Data quality and no longer claims 'never treated as zero'", async () => {
    const { dbPath } = await dbWith({ "a.jsonl": lines(...INVALID) });
    const { quality } = pages(dbPath);
    expect(quality).toContain("contributes nothing to that counter's total (the record itself is still counted)");
    expect(quality).toContain("in a conflicting range a missing, null or invalid counter counts as 0 in the bounds");
    expect(quality).not.toContain("a missing counter counts as 0");
    expect(quality).not.toMatch(/never treated as zero/i);
  });

  it("puts the Overview note inside the settled-totals card, once, and makes no bound or completeness claim", async () => {
    const { dbPath } = await dbWith({ "a.jsonl": lines(...INVALID) });
    const { overview } = pages(dbPath);
    const card = overview.slice(overview.indexOf("Settled totals"), overview.indexOf("Unresolved — not part of settled totals"));
    expect(card).toContain(COUNTER_COMPLETENESS);
    expect(count(overview, COUNTER_COMPLETENESS)).toBe(1);
    expect(COUNTER_COMPLETENESS).not.toMatch(/lower bound|at least|minimum|exact|complete(ly)? /i);
    expect(card.indexOf(COUNTER_COMPLETENESS)).toBeGreaterThan(card.indexOf("Input tokens"));
  });

  it("matches what the code does: the record counts, the invalid counter adds nothing, the missing bound is 0", async () => {
    const { dbPath } = await dbWith({ "a.jsonl": lines(...INVALID) });
    const a = createAnalysis(dbPath);
    const summary = a.usageSummary({ sidechain: "include" }).data;
    expect(summary?.settled.records).toBe(3);
    expect(summary?.settled.outputTokens).toBe(10); // records 1 and 3 only: record 2's output is invalid
    expect(summary?.settled.cacheReadTokens).toBe(200); // record 2's cache read is missing
    expect(summary?.conflicting.lower.outputTokens).toBe(0); // the missing member counts as 0 in the bound
    expect(summary?.conflicting.upper.outputTokens).toBe(9);
    const states = a.usageQuality().data?.tokenFieldStates;
    expect([states?.outputTokens.invalid, states?.outputTokens.missing, states?.cacheReadTokens.missing, states?.cacheCreationTokens.null]).toEqual([1, 1, 1, 1]);
  });

  it("is shown where totals are shown and not beside a no-data notice", async () => {
    const empty = pages(join(tempDir(), "app-data", "usage.db"));
    expect(empty.overview).not.toContain(COUNTER_COMPLETENESS);
    expect(empty.overview).toContain("No database yet");
  });
});

describe("2. partial or failed scan hides stored records: the notice says so", () => {
  const PARTIAL_NOTE = incompleteScanNote("partial") ?? "";
  const FAILED_NOTE = incompleteScanNote("failed") ?? "";

  it("explains both states without inventing a record count", () => {
    expect(PARTIAL_NOTE).toContain("The latest usage scan is partial.");
    expect(FAILED_NOTE).toContain("The latest usage scan is failed.");
    for (const note of [PARTIAL_NOTE, FAILED_NOTE]) {
      expect(note).toContain("may already be stored in the database");
      expect(note).toContain("no usage figures are shown until a scan completes");
      expect(note).not.toMatch(/\d/);
    }
    expect(incompleteScanNote("complete")).toBeNull();
    expect(incompleteScanNote("running")).toBeNull();
    expect(incompleteScanNote(null)).toBeNull();
    expect(incompleteScanNote(undefined)).toBeNull();
  });

  it("appears on Overview, Usage, Data quality and Recommendations after a partial first scan that did store records", async () => {
    const { dbPath, status, stored } = await dbWith({ "ok.jsonl": lines(ev(1), ev(2), ev(3)) }, ["missing.jsonl"]);
    expect(status).toBe("partial");
    expect(stored).toBe(3); // the claim "may already be stored" is true here
    const p = pages(dbPath);
    for (const [name, text] of Object.entries(p)) {
      expect(text, name).toContain(PARTIAL_NOTE);
      expect(count(text, PARTIAL_NOTE), name).toBe(1); // once per page, even where several cards show a no-data notice
    }
  });

  it("appears after a failed scan, and never states a stored-record count", async () => {
    const { dbPath, status } = await dbWith({}, ["missing.jsonl"]);
    expect(status).toBe("failed");
    const p = pages(dbPath);
    for (const [name, text] of Object.entries(p)) {
      expect(text, name).toContain(FAILED_NOTE);
      expect(text, name).not.toMatch(/\d+ (usage )?records? (are |were )?stored/i);
    }
  });

  it("does not appear when no scan was ever recorded, with no database, or when the database is unusable", () => {
    const noScan = join(tempDir(), "app-data", "usage.db");
    openStore(noScan).close();
    const cases: [string, string][] = [["no scan recorded", noScan], ["no database", join(tempDir(), "app-data", "usage.db")], ["unusable database", databaseAtVersion(2)]];
    for (const [name, dbPath] of cases) {
      for (const [page, text] of Object.entries(pages(dbPath))) {
        expect(text, `${name}/${page}`).not.toContain("may already be stored in the database");
      }
    }
  });

  it("does not appear once a scan has completed (the figures are shown instead)", async () => {
    const { dbPath, status } = await dbWith({ "ok.jsonl": lines(ev(1)) });
    expect(status).toBe("complete");
    for (const text of Object.values(pages(dbPath))) expect(text).not.toContain("may already be stored in the database");
  });
});

describe("3. the date range filters the day table only", () => {
  const SCOPE = "The From/To range filters the day table only. The model and session tables cover all dates.";

  it("says so in the filter card and in each table's description, in every data state", async () => {
    const { dbPath } = await dbWith({ "c.jsonl": lines(ev(1, { day: 1 }), ev(2, { day: 1 }), ev(3, { day: 2 }), ev(4, { day: 3, model: "model-beta" })) });
    const populated = pages(dbPath, "2026-03-01", "2026-03-01").usage;
    const empty = pages(join(tempDir(), "app-data", "usage.db")).usage;
    for (const text of [populated, empty]) {
      expect(text).toContain(SCOPE);
      expect(text).toContain("Covers all dates; the From/To range does not apply here.");
      expect(text).toContain("The only table filtered by the From/To range above.");
    }
    expect(count(populated, "does not apply here")).toBe(2); // By model and Sessions
  });

  it("matches the behavior: the day table narrows, model and session tables do not", async () => {
    const { dbPath } = await dbWith({ "c.jsonl": lines(ev(1, { day: 1 }), ev(2, { day: 1 }), ev(3, { day: 2 }), ev(4, { day: 3, model: "model-beta" })) });
    const a = createAnalysis(dbPath);
    const sum = (items: readonly { records: number }[] | undefined) => (items ?? []).reduce((n, i) => n + i.records, 0);
    expect(sum(a.usageByDay({ ...PG, from: "2026-03-01", to: "2026-03-01" }).data?.items)).toBe(2);
    expect(sum(a.usageByModel(PG).data?.items)).toBe(4);
    expect(sum(a.usageSessions(PG).data?.items)).toBe(4);
  });
});

describe("4. the unrecognized-model row is explained without exposing the identifier", () => {
  it("adds a note only when the row appears, and never shows or logs the raw value", async () => {
    const hostile = "home/someone/CANARY_PATH_9c1d";
    const { dbPath } = await dbWith({ "m.jsonl": lines(ev(1), ev(2, { model: hostile }), ev(3, { model: "has spaces" }), ev(4, { model: "mycorp/legit-model" })) });
    const { usage } = pages(dbPath);
    expect(usage).toContain("(unrecognized model name)");
    expect(usage).toContain("groups records whose model identifier did not match the recognized-name policy");
    expect(usage).toContain("Legitimate identifiers (for example from a provider this tool does not list) can be grouped here; it does not mean the model is invalid.");
    expect(usage).not.toMatch(/CANARY|someone|has spaces|mycorp|legit-model/);
    const api = JSON.stringify(createAnalysis(dbPath).usageByModel(PG));
    expect(api).not.toMatch(/CANARY|someone|has spaces|mycorp/);
  });

  it("is absent when every model is recognized", async () => {
    const { dbPath } = await dbWith({ "m.jsonl": lines(ev(1), ev(2, { model: "claude-sonnet-4-5" })) });
    expect(pages(dbPath).usage).not.toContain("(unrecognized model name)");
    expect(pages(dbPath).usage).not.toContain("recognized-name policy");
  });
});

describe("5, 6, 8. Data quality diagnostics", () => {
  const MESSY = `${ev(1)}\n{broken json\n[1,2,3]\n"just a string"\n\n${ev(2)}\n`;
  const USAGE_WITH_EXTRA: Usage = { ...GOOD, speed: "x", iterations: [], fallback_credit: 0 };

  it("5. says the diagnostics describe the latest scan only, and the claim is true", async () => {
    const dir = tempDir();
    const { store, dbPath } = freshStore(dir);
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, MESSY);
    writeFileSync(b, lines(ev(50), ev(51)));
    await scanAndIngest(store, [a, b]);
    const before = createAnalysis(dbPath).usageQuality().data?.latestScan?.skippedLines;
    await scanAndIngest(store, [b]);
    store.close();

    const q = createAnalysis(dbPath).usageQuality().data?.latestScan;
    expect(before?.malformed).toBe(1);
    expect(q?.sources).toBe(1);
    expect(q?.skippedLines.malformed).toBe(0); // source A's issue is no longer reported although its records remain
    const { quality } = pages(dbPath);
    expect(quality).toContain("These diagnostics describe the latest scan only.");
    expect(quality).toContain("may not appear here, although those sources' records stay stored");
    expect(count(quality, "describe the latest scan only")).toBe(1);
  });

  it("5. is not shown beside a no-data notice", () => {
    expect(pages(join(tempDir(), "app-data", "usage.db")).quality).not.toContain("describe the latest scan only");
  });

  it("6. shows non-object and blank line counts from the existing API fields", async () => {
    const { dbPath } = await dbWith({ "a.jsonl": MESSY });
    const skipped = createAnalysis(dbPath).usageQuality().data?.latestScan?.skippedLines;
    expect([skipped?.malformed, skipped?.nonObject, skipped?.blank]).toEqual([1, 2, 1]);
    const { quality } = pages(dbPath);
    expect(quality).toMatch(/Non-object lines 2 Valid JSON that is not an object/);
    expect(quality).toMatch(/Blank lines 1 Empty or whitespace-only lines; skipped\./);
    expect(quality).not.toContain("Empty lines; skipped");
    expect(quality).toMatch(/Malformed lines 1/);
  });

  it("6. shows zeros, not nothing, when there are none", async () => {
    const { dbPath } = await dbWith({ "a.jsonl": lines(ev(1), ev(2)) });
    const { quality } = pages(dbPath);
    expect(quality).toMatch(/Non-object lines 0/);
    expect(quality).toMatch(/Blank lines 0/);
  });

  it("8. labels the key metric as occurrences, not distinct names", async () => {
    const { dbPath } = await dbWith({ "a.jsonl": lines(ev(1, { usage: USAGE_WITH_EXTRA }), ev(2, { usage: USAGE_WITH_EXTRA }), ev(3, { usage: USAGE_WITH_EXTRA }), ev(4, { usage: USAGE_WITH_EXTRA })) });
    expect(createAnalysis(dbPath).usageQuality().data?.latestScan?.unrecognizedUsageKeys).toBe(12); // 4 usage objects x 3 distinct unknown names
    const { quality } = pages(dbPath);
    expect(quality).toMatch(/Unrecognized usage key occurrences 12 Occurrences across all usage objects, not the number of distinct key names\./);
    expect(quality).not.toMatch(/Unrecognized usage keys\b/);
  });
});

describe("M6-B.2.1 wording corrections", () => {
  const PARTIAL = incompleteScanNote("partial") ?? "";
  const FAILED = incompleteScanNote("failed") ?? "";

  /** Usage ingest (optionally with an unreadable file) plus a completed configuration scan, in one temp database. */
  async function usageAndConfig(files: Record<string, string>, missing: string[]) {
    const dir = tempDir();
    const { store, dbPath } = freshStore(dir);
    const paths = Object.entries(files).map(([name, text]) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    });
    const usage = await scanAndIngest(store, [...paths, ...missing.map((n) => join(dir, n))]);
    writeTree(join(dir, "proj"), { "CLAUDE.md": "Project notes.\n" });
    saveConfigInventory(store, await scan([projectRoot(join(dir, "proj"))]));
    const stored = (store.db.prepare("SELECT COUNT(*) AS n FROM usage_records").get() as { n: number }).n;
    store.close();
    return { dbPath, usageStatus: usage.status, stored };
  }

  describe("1. Recommendations discloses a partial or failed usage scan when configuration data exists", () => {
    it("partial usage scan + completed configuration scan: the page has data, says usage is unavailable, and discloses stored records once", async () => {
      const { dbPath, usageStatus, stored } = await usageAndConfig({ "ok.jsonl": lines(ev(1), ev(2), ev(3)) }, ["missing.jsonl"]);
      const a = createAnalysis(dbPath);
      expect(usageStatus).toBe("partial");
      expect(stored).toBe(3); // the disclosure "may already be stored" is true in this state
      expect(a.recommendations(ALL).state).toBe("ok");
      expect(a.recommendations(ALL).data?.availability).toEqual({ usage: false, config: true });

      const { recs } = pages(dbPath);
      expect(recs).toContain("Evidence available: usage no completed scan, configuration yes.");
      expect(count(recs, PARTIAL)).toBe(1);
      expect(recs).toContain("may already be stored in the database");
      expect(recs).not.toMatch(/\d+ (usage )?records? (are |were )?stored/i);
      expect(recs.indexOf(PARTIAL)).toBeGreaterThan(recs.indexOf("Evidence available: usage"));
      expect(recs.indexOf(PARTIAL)).toBeLessThan(recs.indexOf("Rules evaluated")); // inside the evidence card, above the rules
    });

    it("failed usage scan + completed configuration scan", async () => {
      const { dbPath, usageStatus } = await usageAndConfig({}, ["missing.jsonl"]);
      expect(usageStatus).toBe("failed");
      const { recs } = pages(dbPath);
      expect(count(recs, FAILED)).toBe(1);
      expect(recs).toContain("configuration yes");
    });

    it("is consistent with Overview, which shows the same disclosure once in this state", async () => {
      const { dbPath } = await usageAndConfig({ "ok.jsonl": lines(ev(1)) }, ["missing.jsonl"]);
      const p = pages(dbPath);
      expect(count(p.overview, PARTIAL)).toBe(1);
      expect(count(p.recs, PARTIAL)).toBe(1);
    });

    it("is not shown when usage completed, or when usage was never scanned", async () => {
      const complete = await usageAndConfig({ "ok.jsonl": lines(ev(1)) }, []);
      expect(complete.usageStatus).toBe("complete");
      expect(pages(complete.dbPath).recs).not.toContain("may already be stored");
      expect(pages(complete.dbPath).recs).toContain("Evidence available: usage yes, configuration yes.");

      const dir = tempDir();
      const { store, dbPath } = freshStore(dir);
      writeTree(join(dir, "proj"), { "CLAUDE.md": "Notes.\n" });
      saveConfigInventory(store, await scan([projectRoot(join(dir, "proj"))]));
      store.close();
      const configOnly = pages(dbPath).recs;
      expect(configOnly).toContain("Evidence available: usage no completed scan, configuration yes.");
      expect(configOnly).not.toContain("may already be stored");
    });

    it("is not shown when an earlier usage scan completed and a later one was partial (figures are available, so nothing is hidden)", async () => {
      const dir = tempDir();
      const { store, dbPath } = freshStore(dir);
      const ok = join(dir, "ok.jsonl");
      writeFileSync(ok, lines(ev(1), ev(2)));
      expect((await scanAndIngest(store, [ok])).status).toBe("complete");
      expect((await scanAndIngest(store, [ok, join(dir, "missing.jsonl")])).status).toBe("partial");
      writeTree(join(dir, "proj"), { "CLAUDE.md": "Notes.\n" });
      saveConfigInventory(store, await scan([projectRoot(join(dir, "proj"))]));
      store.close();

      const a = createAnalysis(dbPath);
      expect(a.status().data?.usage.latestScan?.status).toBe("partial");
      expect(a.recommendations(ALL).data?.availability.usage).toBe(true);
      const { recs } = pages(dbPath);
      expect(recs).toContain("Evidence available: usage yes, configuration yes.");
      expect(recs).not.toContain("no usage figures are shown until a scan completes");
    });

    it("is shown once, not twice, when neither section has a completed scan (the no-data notice carries it)", async () => {
      const dir = tempDir();
      const { store, dbPath } = freshStore(dir);
      writeFileSync(join(dir, "ok.jsonl"), lines(ev(1)));
      await scanAndIngest(store, [join(dir, "ok.jsonl"), join(dir, "missing.jsonl")]);
      store.close();
      const { recs } = pages(dbPath);
      expect(createAnalysis(dbPath).recommendations(ALL).state).toBe("no-completed-scan");
      expect(count(recs, PARTIAL)).toBe(1);
      expect(recs).not.toContain("Evidence available: usage");
    });

    it("leaves the no-database and unusable-database states unchanged", () => {
      for (const dbPath of [join(tempDir(), "app-data", "usage.db"), databaseAtVersion(2)]) {
        const { recs } = pages(dbPath);
        expect(recs).not.toContain("may already be stored");
        expect(recs).not.toContain("Evidence available: usage");
      }
    });
  });

  describe("2. missing, null and invalid counters all count as 0 in conflicting bounds", () => {
    const base = { input_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 };
    const second: Record<string, Usage> = {
      missing: { ...base },
      null: { ...base, output_tokens: null },
      invalid: { ...base, output_tokens: "not-a-number" },
    };

    it.each(["missing", "null", "invalid"])("a %s member contributes 0 to both bounds", async (state) => {
      const { dbPath } = await dbWith({ "c.jsonl": lines(ev(1, { id: "x", usage: { ...base, output_tokens: 9 } }), ev(2, { id: "x", usage: second[state] ?? {} })) });
      const s = createAnalysis(dbPath).usageSummary({ sidechain: "include" }).data;
      expect(s?.conflicting.groups).toBe(1);
      expect([s?.conflicting.lower.outputTokens, s?.conflicting.upper.outputTokens]).toEqual([0, 9]);
      const states = createAnalysis(dbPath).usageQuality().data?.tokenFieldStates.outputTokens;
      expect(states?.[state as "missing" | "null" | "invalid"]).toBe(1); // the state really is what the test says it is
    });

    it("control: two valid values give a real lower bound, so the zero comes from the invalid state and nothing else", async () => {
      const { dbPath } = await dbWith({ "c.jsonl": lines(ev(1, { id: "x", usage: { ...base, output_tokens: 9 } }), ev(2, { id: "x", usage: { ...base, output_tokens: 4 } })) });
      const s = createAnalysis(dbPath).usageSummary({ sidechain: "include" }).data;
      expect([s?.conflicting.lower.outputTokens, s?.conflicting.upper.outputTokens]).toEqual([4, 9]);
    });

    it("the Data quality wording names all three states", async () => {
      const { dbPath } = await dbWith({ "c.jsonl": lines(ev(1)) });
      const { quality } = pages(dbPath);
      expect(quality).toContain("in a conflicting range a missing, null or invalid counter counts as 0 in the bounds");
      expect(quality).not.toMatch(/a missing counter counts as 0/);
    });
  });

  describe("3. blank lines include whitespace-only lines", () => {
    it("counts an empty line and two whitespace-only lines as blank, and the hint says so", async () => {
      const { dbPath } = await dbWith({ "b.jsonl": `${ev(1)}\n\n   \n\t\n${ev(2)}\n` });
      const skipped = createAnalysis(dbPath).usageQuality().data?.latestScan?.skippedLines;
      expect(skipped).toMatchObject({ blank: 3, malformed: 0, nonObject: 0, oversized: 0 });
      const { quality } = pages(dbPath);
      expect(quality).toMatch(/Blank lines 3 Empty or whitespace-only lines; skipped\./);
      expect(quality).not.toContain("Empty lines; skipped");
    });
  });
});

describe("documentation", () => {
  it("README states the same behaviors", () => {
    const readme = readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    const phrases = [
      COUNTER_COMPLETENESS,
      "The From/To range filters the day table only",
      "may already be stored",
      "describe the latest scan only",
      "Non-object lines",
      "Blank lines (empty or whitespace-only)",
      "a missing, null or invalid counter counts as 0 in the bounds",
      "occurrences",
    ];
    expect(phrases.filter((p) => !readme.includes(p))).toEqual([]); // reports only what is missing
    expect(readme).toContain(TOKEN_DISCLAIMER.slice(0, 60));
  });
});
