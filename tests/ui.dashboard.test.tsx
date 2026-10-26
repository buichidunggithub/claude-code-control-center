import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigView } from "@/components/dashboard/config-view";
import { TOKEN_DISCLAIMER } from "@/components/dashboard/format";
import { OverviewView } from "@/components/dashboard/overview-view";
import { QualityView } from "@/components/dashboard/quality-view";
import { Shell } from "@/components/dashboard/shell";
import { UsageView } from "@/components/dashboard/usage-view";
import { createAnalysis } from "@/core/analysis";
import { openStore } from "@/core/store";
import OverviewPage from "@/app/page";
import QualityPage from "@/app/quality/page";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { ALL_CANARIES, databaseAtVersion, populatedDatabase } from "./analysis-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

registerTempStoreCleanup();

const PAGE = { limit: 200, offset: 0 } as const;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
/** Visible text of a rendered page: tags removed, entities decoded, whitespace collapsed. */
const plain = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function views(dbPath: string) {
  const a = createAnalysis(dbPath);
  return {
    overview: html(h(OverviewView, { status: a.status(), summary: a.usageSummary({ sidechain: "include" }), config: a.configSummary() })),
    usage: html(
      h(UsageView, {
        sidechain: "include",
        from: null,
        to: null,
        models: a.usageByModel({ sidechain: "include", ...PAGE }),
        days: a.usageByDay({ sidechain: "include", ...PAGE, from: null, to: null }),
        sessions: a.usageSessions({ sidechain: "include", limit: 25, offset: 0 }),
      }),
    ),
    config: html(h(ConfigView, { summary: a.configSummary(), findings: a.configFindings({ severity: null, ruleId: null, ...PAGE }) })),
    quality: html(h(QualityView, { status: a.status(), quality: a.usageQuality(), config: a.configSummary() })),
  };
}

describe("empty states", () => {
  it("explain a missing database, say nothing was created, and show no figures", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    const v = views(dbPath);

    expect(v.overview).toContain("No database yet");
    expect(v.overview).toContain("nothing was created");
    expect(v.overview).toContain("CLAUDE_CONTROL_DB_PATH");
    for (const page of Object.values(v)) {
      expect(page).not.toMatch(/Settled records|<td/);
      expect(page).not.toMatch(/Showing \d|\d+ findings/);
    }
    expect(v.usage).toContain("pnpm ingest preview");
    expect(v.usage).toContain("pnpm ingest run --db");
    expect(v.usage).not.toContain("scanAndIngest");
    expect(v.config).toContain("pnpm config:scan");
    expect(v.config).toContain("never searches for configuration");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("distinguishes a database without completed scans from a missing one", () => {
    const dbPath = join(tempDir(), "app-data", "usage.db");
    openStore(dbPath).close();
    const v = views(dbPath);

    expect(v.overview).toContain("No scan recorded");
    expect(v.overview).toContain("No completed usage scan");
    expect(v.overview).not.toContain("No database yet");
    expect(v.config).toContain("No completed configuration scan");
  });

  it("renders an alert for an unusable database with its code and no internals", () => {
    const v = views(databaseAtVersion(2));
    expect(v.overview).toContain('role="alert"');
    expect(v.overview).toContain("SCHEMA_OUTDATED");
    expect(v.overview).toContain("never migrates");
  });
});

describe("populated synthetic data", () => {
  it("overview separates settled totals from unresolved events and labels the counters", async () => {
    const { dbPath } = await populatedDatabase();
    const { overview } = views(dbPath);

    expect(overview).toContain("Settled totals");
    expect(overview).toContain("Unresolved — not part of settled totals");
    expect(overview).toContain("Conflicting groups");
    expect(overview).toContain("Ambiguous records");
    expect(plain(overview)).toContain(TOKEN_DISCLAIMER);
    expect(overview).toContain("Usage scan");
    expect(overview).toContain("complete");
  });

  it("usage page shows units, UTC days, sidechain semantics and opaque sessions", async () => {
    const { dbPath } = await populatedDatabase();
    const { usage } = views(dbPath);

    expect(usage).toContain("model-alpha");
    expect(usage).toContain("Day (UTC)");
    expect(usage).toContain("2026-01-10");
    expect(usage).toContain("Exclude sidechain");
    expect(usage).toContain("(no model recorded)");
    expect(plain(usage)).toContain(TOKEN_DISCLAIMER);
    expect(usage).toMatch(/aria-hidden="true"/);
    expect(usage).toContain("<caption");
  });

  it("config page groups findings by severity and rule, with versions, evidence and limitations", async () => {
    const { dbPath } = await populatedDatabase();
    const { config } = views(dbPath);

    expect(config).toMatch(/medium severity/);
    expect(config).toMatch(/CFG-[A-Z]+-\d{3} · /);
    expect(config).toMatch(/rule v1/);
    expect(config).toContain("Limitations:");
    expect(config).toContain("For human review:");
    expect(config).toContain("confidence:");
    expect(config).toContain('name="severity"');
    expect(config).toContain("bytes / 4");
  });

  it("never claims that inventoried files are loaded or active", async () => {
    const { dbPath } = await populatedDatabase();
    const { config, overview } = views(dbPath);
    const text = `${config} ${overview}`.replace(/<[^>]+>/g, " ");

    expect(text).toContain("Found is not loaded");
    expect(text).toContain("not shown to be loaded");
    const NEGATED = /\b(not|never|none|no|nor|unverified|unknown|cannot|without|found is)\b/i;
    const sentences = text.split(/[.:]\s+/).filter((t) => /\b(loaded|active|in effect)\b/i.test(t));
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) expect(sentence).toMatch(NEGATED);
    for (const sentence of text.split(/[.:]\s+/).filter((t) => /\bsav(e|es|ed|ing|ings)\b/i.test(t))) expect(sentence).toMatch(NEGATED);
  });

  it("quality page shows accounting states, counter states and scan errors", async () => {
    const { dbPath } = await populatedDatabase();
    const { quality } = views(dbPath);

    for (const state of ["accepted", "duplicate", "conflicting", "ambiguous"]) expect(quality).toContain(`<td class="border-b border-neutral-200 px-2 py-1.5 align-top dark:border-neutral-800 ">${state}</td>`);
    expect(quality).toContain("Missing");
    expect(quality).toContain("Invalid");
    expect(plain(quality)).toContain("contributes nothing to that counter's total (the record itself is still counted)");
    expect(plain(quality)).not.toContain("never treated as zero");
    expect(quality).toContain("Malformed lines");
    expect(quality).toContain("Skipped files by code");
    expect(quality).toContain("Identity-uncertain sources");
    expect(quality).toContain("A rewrite flagged the source and anonymous records are still stored. Flagged in the latest scan run: ");
    expect(quality).toContain("neither creates nor clears it; it clears only when no anonymous record remains");
  });

  it("contains no canary, absolute path or remote asset in any page", async () => {
    const { dbPath, base } = await populatedDatabase();
    for (const page of Object.values(views(dbPath))) {
      for (const canary of ALL_CANARIES) expect(page).not.toContain(canary);
      expect(page).not.toContain(base);
      expect(page).not.toMatch(/https?:\/\//);
      expect(page).not.toMatch(/<script|<img|<link|@import/);
    }
  });
});

describe("shell and pages", () => {
  it("marks the active section and labels the navigation", () => {
    const out = html(<Shell active="usage" title="Usage"><p>x</p></Shell>);
    expect(out).toContain('aria-label="Sections"');
    expect(out).toMatch(/href="\/usage"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/usage"/);
    expect(out.match(/aria-current/g)).toHaveLength(1);
    expect(out).toContain("<h1");
    expect(out).toContain("read-only");
  });

  describe("route components read only the configured database", () => {
    const saved = process.env[DATABASE_PATH_ENV];
    beforeEach(() => {
      process.env[DATABASE_PATH_ENV] = join(tempDir(), "missing", "usage.db");
    });
    afterEach(() => {
      if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
      else process.env[DATABASE_PATH_ENV] = saved;
    });

    it("render empty states without creating the database", () => {
      const target = process.env[DATABASE_PATH_ENV] ?? "";
      expect(html(h(OverviewPage))).toContain("No database yet");
      expect(html(h(QualityPage))).toContain("No database yet");
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(target, ".."))).toBe(false);
    });

    it("render populated data from the configured synthetic database", async () => {
      process.env[DATABASE_PATH_ENV] = (await populatedDatabase()).dbPath;
      expect(html(h(OverviewPage))).toContain("Settled totals");
    });
  });
});


describe("token completeness disclosure", () => {
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
  const KEY_PHRASES = [
    "usage records found in the ingested transcripts",
    "accepted by the accounting pipeline",
    "repeats of one message are counted once",
    "conflicting or ambiguous records are kept out and shown separately",
    "Transcripts may not capture every API call",
    "may differ from Claude Code's own cumulative counters",
    "not billing totals, complete session totals or exact API cost",
    "no pricing is applied",
  ];

  it("states what the totals are and are not, without quantifying anything missing", () => {
    for (const phrase of KEY_PHRASES) expect(TOKEN_DISCLAIMER).toContain(phrase);
    expect(TOKEN_DISCLAIMER).not.toMatch(/\d/); // no figure, so no percentage of "missing" usage is implied
    expect(TOKEN_DISCLAIMER).not.toMatch(/cost-state|defect|bug|undercount|missing \w+ usage|%/i);
    expect(TOKEN_DISCLAIMER).not.toMatch(/\b(exact|complete|total) (billing|cost)\b(?!.*\bnot\b)/i);
  });

  it("appears once on Overview, inside the settled-totals card that shows the numbers", async () => {
    const { dbPath } = await populatedDatabase();
    const text = plain(views(dbPath).overview);
    expect(occurrences(text, TOKEN_DISCLAIMER)).toBe(1);
    const card = text.slice(text.indexOf("Settled totals"), text.indexOf("Unresolved — not part of settled totals"));
    expect(card).toContain(TOKEN_DISCLAIMER);
    expect(card).toContain("Input tokens");
  });

  it("appears once on Usage, above the model, day and session tables", async () => {
    const { dbPath } = await populatedDatabase();
    const out = views(dbPath).usage;
    const text = plain(out);
    expect(occurrences(text, TOKEN_DISCLAIMER)).toBe(1);
    expect(text.indexOf(TOKEN_DISCLAIMER)).toBeLessThan(text.indexOf("Settled tokens by model"));
    expect(text.indexOf(TOKEN_DISCLAIMER)).toBeLessThan(text.indexOf("By model"));
    expect(text).toContain("Only settled (accepted) records are listed");
  });

  it("uses the same wording on both pages", async () => {
    const { dbPath } = await populatedDatabase();
    const v = views(dbPath);
    const pick = (page: string) => plain(page).match(/Token totals count usage records[^]*?no pricing is applied\./)?.[0];
    expect(pick(v.overview)).toBe(TOKEN_DISCLAIMER);
    expect(pick(v.usage)).toBe(TOKEN_DISCLAIMER);
  });

  describe("on the Usage page in every data state (its scope card is always shown)", () => {
    const states: [string, () => string][] = [
      ["no database", () => join(tempDir(), "app-data", "usage.db")],
      ["no completed scan", () => {
        const dbPath = join(tempDir(), "app-data", "usage.db");
        openStore(dbPath).close();
        return dbPath;
      }],
      ["an unusable database", () => databaseAtVersion(2)],
    ];
    it.each(states)("%s", (_name, make) => {
      const out = views(make()).usage;
      expect(plain(out)).toContain(TOKEN_DISCLAIMER);
      expect(out).not.toMatch(/<td/); // no figures are shown, only the explanation
    });
  });

  it("on Overview, appears only where token totals are shown (not beside a no-data notice)", () => {
    const missing = views(join(tempDir(), "app-data", "usage.db")).overview;
    expect(plain(missing)).toContain("No database yet");
    expect(plain(missing)).not.toContain("Settled totals");
    expect(plain(missing)).not.toContain(TOKEN_DISCLAIMER);
  });

  it("does not mention cost-state or any comparison figure in the UI, and leaves the totals untouched", async () => {
    const { dbPath } = await populatedDatabase();
    const a = createAnalysis(dbPath);
    const settled = a.usageSummary({ sidechain: "include" }).data?.settled;
    const v = views(dbPath);
    expect(plain(v.overview + v.usage)).not.toMatch(/cost-state|cumulative counter value|underreport/i);
    expect(plain(v.overview)).toContain(`Input tokens ${settled?.inputTokens}`);
  });

  it("is mirrored in the README with the same sentences", () => {
    const readme = readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    for (const phrase of KEY_PHRASES) expect(readme).toContain(phrase);
    expect(readme).toContain("no percentage of \"missing\" usage is claimed anywhere");
  });
});
