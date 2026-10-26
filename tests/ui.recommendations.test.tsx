import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RecommendationsPage from "@/app/recommendations/page";
import { RecommendationsView } from "@/components/dashboard/recommendations-view";
import { createAnalysis, type RecommendationsQuery } from "@/core/analysis";
import { openStore } from "@/core/store";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { ALL_CANARIES, databaseAtVersion } from "./analysis-helpers";
import { submitForm, toRaw, type SearchParams } from "./form-helpers";
import { richDatabase } from "./recommend-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ReactElement } from "react";

registerTempStoreCleanup();

const ALL: RecommendationsQuery = { category: null, priority: null, limit: 200, offset: 0 };
const render = (element: ReactElement) => renderToStaticMarkup(element);
const view = (dbPath: string, q: RecommendationsQuery = ALL) => render(<RecommendationsView recommendations={createAnalysis(dbPath).recommendations(q)} />);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("recommendations view", () => {
  it("explains a missing database and creates nothing", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    const out = view(dbPath);
    expect(out).toContain("No database yet");
    expect(out).toContain("pnpm ingest preview");
    expect(out).not.toContain("scanAndIngest");
    expect(out).not.toMatch(/priority:|Rules evaluated/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("explains an initialized database without completed scans", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    openStore(dbPath).close();
    const out = view(dbPath);
    expect(out).toContain("No completed scan");
    expect(out).toContain("pnpm config:scan");
    expect(out).not.toContain("No database yet");
  });

  it("renders an alert for an unusable database", () => {
    const out = view(databaseAtVersion(2));
    expect(out).toContain('role="alert"');
    expect(out).toContain("SCHEMA_OUTDATED");
  });

  it("says when scans exist but no recommendation is supported, and shows what each rule needs", async () => {
    const { dbPath } = await richDatabase({ events: 10, config: false });
    const out = view(dbPath);
    expect(out).toContain("No recommendation is supported by the current evidence");
    expect(out).toContain("Insufficient evidence");
    expect(out).toContain("Rules evaluated");
    expect(out).toContain("Evidence required");
    expect(out).not.toContain("priority:");
  });

  it("shows each recommendation with facts, inferences, evidence, confidence, impact, limitations and the human step", async () => {
    const { dbPath } = await richDatabase();
    const out = view(dbPath);

    for (const heading of ["What the data shows", "What is inferred (not established)", "Evidence", "Limitations", "For human review:", "Audit findings:"]) expect(out).toContain(heading);
    expect(out).toMatch(/Confidence \((high|medium|low|unknown)\):/);
    expect(out).toMatch(/Expected impact \((unknown|limited)\):/);
    expect(out).toContain("priority: medium");
    expect(out).toContain("needs review");
    expect(out).toContain("informational");
    expect(out).toContain("REC-CFG-DUP");
    expect(out).toContain("REC-USE-MODELS");
    expect(out).toMatch(/rule v1/);
    expect(out).toContain("Nothing has been changed, applied or executed");
  });

  it("offers no apply or fix controls and implies nothing was executed", async () => {
    const { dbPath } = await richDatabase();
    const out = view(dbPath);
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toContain('type="submit"');
    expect(out).not.toMatch(/<form[^>]*method="post"/i);
    expect(out).not.toMatch(/>\s*(Apply|Fix|Delete|Remove|Optimi[sz]e|Run)\b/);
    const sentences = text(out).split(/(?<=[.;])\s+/).filter((s) => /\b(applied|executed|fixed|removed|deleted)\b/i.test(s));
    for (const s of sentences) expect(s).toMatch(/\b(no|not|nothing|never|without|yours)\b/i);
  });

  it("makes no claim that an inventoried item is loaded or that anything will be saved", async () => {
    const { dbPath } = await richDatabase();
    const sentences = text(view(dbPath)).split(/(?<=[.;])\s+/);
    for (const s of sentences.filter((t) => /\b(loaded|active|in effect)\b/i.test(t))) expect(s).toMatch(/\b(not|no|never|unknown|unverified|nor|without|cannot|if you need)\b/i);
    for (const s of sentences.filter((t) => /\bsav(e|es|ed|ing|ings)\b|\bcheaper\b|\bfaster\b/i.test(t))) expect(s).toMatch(/\b(no|not|never|none|nor|nothing|unmeasured|without)\b/i);
  });

  it("has no canary, absolute path or remote asset", async () => {
    const { dbPath, base } = await richDatabase();
    const out = view(dbPath);
    for (const canary of ALL_CANARIES) expect(out).not.toContain(canary);
    expect(out).not.toContain(base);
    expect(out).not.toMatch(/https?:\/\/|<script|<img|<link/);
  });

  it("has a category/priority filter that narrows the list and reports no match clearly", async () => {
    const { dbPath } = await richDatabase();
    const quality = view(dbPath, { ...ALL, category: "data-quality" });
    expect(quality).toContain("No recommendation matches this filter");
    const insight = text(view(dbPath, { ...ALL, category: "usage-insight" }));
    expect(insight).toContain("REC-USE-MODELS · rule v3");
    expect(insight).not.toMatch(/REC-CFG-DUP · rule v/);
  });
});

describe("legend and scope", () => {
  const LEGEND = "How to read this page";
  const occurrences = (markup: string, needle: string) => markup.split(needle).length - 1;

  it("explains priority, confidence and impact in plain terms, visibly and compactly", async () => {
    const { dbPath } = await richDatabase();
    const out = view(dbPath);
    const legend = text(out.slice(out.indexOf(LEGEND), out.indexOf("Evidence available")));

    expect(legend).toContain("Priority is the suggested order in which to look at things. It is not harm, risk or expected savings.");
    expect(legend).toContain("Confidence is confidence that the observation is accurate as measured, not confidence that acting on it will help.");
    expect(legend).toContain("Impact is qualitative.");
    expect(legend).toContain("nothing here shows a token or cost saving");
    expect(legend.length).toBeLessThan(1200);
    expect(out.indexOf(LEGEND)).toBeLessThan(out.indexOf("priority: "));
  });

  describe("is rendered exactly once in every state of the page", () => {
    const cases: [string, () => Promise<string> | string, RegExp][] = [
      ["no database", () => join(tempDir(), "app-data", "usage.db"), /No database yet/],
      ["no completed scan", () => {
        const dbPath = join(tempDir(), "app-data", "usage.db");
        openStore(dbPath).close();
        return dbPath;
      }, /No completed scan/],
      ["an unusable database", () => databaseAtVersion(2), /SCHEMA_OUTDATED/],
      ["scans but no recommendation", async () => (await richDatabase({ events: 10, config: false })).dbPath, /No recommendation is supported/],
      ["a filter with no match", async () => (await richDatabase()).dbPath, /No recommendation matches this filter/],
      ["recommendations present", async () => (await richDatabase()).dbPath, /priority: /],
    ];

    it.each(cases)("%s", async (name, makeDb, expected) => {
      const dbPath = await makeDb();
      const q = name === "a filter with no match" ? { ...ALL, category: "data-quality" as const } : ALL;
      const out = view(dbPath, q);
      expect(occurrences(out, LEGEND)).toBe(1);
      expect(out).toMatch(expected);
      expect(text(out)).toContain("It is not harm, risk or expected savings.");
      expect(text(out)).toContain("Nothing has been changed, applied or executed");
      expect(out.indexOf(LEGEND)).toBeLessThan(out.search(expected));
    });

    it("keeps the unavailable-state alert alongside the legend", () => {
      const out = view(databaseAtVersion(2));
      expect(out).toContain('role="alert"');
      expect(occurrences(out, LEGEND)).toBe(1);
    });
  });

  it("states the sidechain scope in the legend, and by state in each recommendation, citing the metrics", async () => {
    const { dbPath } = await richDatabase();
    const out = text(view(dbPath));
    expect(out).toContain("usage figures cover all events, sidechain (sub-agent) events included. Each recommendation states how many sidechain records are settled and how many are unresolved; the Usage page's sidechain filter does not apply.");
    expect(out).toContain("Scope: all settled events, sidechain (sub-agent) events included: 0 settled sidechain records are counted here, and 0 unresolved sidechain records are excluded");
    expect(out).toContain("settledSidechainRecords=0");
    expect(out).toContain("unresolvedSidechainRecords=0");
    expect(out).not.toMatch(/all events, including \d+ sidechain/);
  });

  it("shows model names only as validated identifiers", async () => {
    const { dbPath } = await richDatabase();
    const out = text(view(dbPath));
    expect(out).toMatch(/model-alpha: \d+ records/);
    expect(out).not.toContain("(unrecognized model name)");
  });
});

describe("recommendations page and its form", () => {
  const saved = process.env[DATABASE_PATH_ENV];
  beforeEach(async () => {
    process.env[DATABASE_PATH_ENV] = (await richDatabase()).dbPath;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
    else process.env[DATABASE_PATH_ENV] = saved;
  });

  const page = async (query: SearchParams = {}) => render(await RecommendationsPage({ searchParams: Promise.resolve(query) }));

  it("renders inside the shell with the Recommendations nav entry active", async () => {
    const out = await page();
    expect(out).toContain("<h1");
    expect(out).toMatch(/href="\/recommendations"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/recommendations"/);
  });

  it("stays usable when a browser submits the form with 'All' selected", async () => {
    const params = submitForm(await page(), "/recommendations");
    expect(Object.fromEntries(params)).toEqual({ category: "", priority: "" });
    const out = await page(toRaw(params));
    expect(out).not.toContain("filter is not valid");
    expect(out).toContain("REC-CFG-DUP");
  });

  it("applies a real selection and keeps the dashboard on an invalid one", async () => {
    const narrowed = await page(toRaw(submitForm(await page(), "/recommendations", { priority: "info" })));
    expect(text(narrowed)).toContain("REC-USE-MODELS · rule v3");
    expect(text(narrowed)).not.toMatch(/REC-CFG-DUP · rule v/);

    const invalid = await page({ category: "savings" });
    expect(invalid).toContain("filter is not valid");
    expect(text(invalid)).toMatch(/REC-CFG-DUP · rule v/);
    expect(invalid).toContain('aria-label="Sections"');
  });
});
