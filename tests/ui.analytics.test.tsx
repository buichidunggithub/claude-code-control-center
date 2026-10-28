import { existsSync } from "node:fs";
import { join } from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import AnalyticsPage from "@/app/analytics/page";
import AnalyticsError from "@/app/analytics/error";
import Loading from "@/app/analytics/loading";
import { AnalyticsView, type AnalyticsViewProps } from "@/components/dashboard/analytics-view";
import { NAV } from "@/components/dashboard/shell";
import { TOOL_BUCKETS } from "@/core/parse";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { factsDatabase, saltOf, sessionRef, withRawDatabase } from "./analytics-helpers";
import { REF_A, REF_B, baseOf, coverage, detailOf, noFacts, notOk, ok, sessionItem, sessionsOf, sizes, slice, summaryOf, toolsOf, trendsOf } from "./analytics-ui-helpers";
import { ALL_CANARIES, databaseAtVersion } from "./analysis-helpers";
import { FACT_CANARIES } from "./facts-helpers";
import { submitForm, toRaw, type SearchParams } from "./form-helpers";
import { freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const html = (element: ReactElement) => renderToStaticMarkup(element);
const plain = (markup: string): string =>
  markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

const DEFAULT_PROPS: AnalyticsViewProps = {
  summary: ok(summaryOf()), tools: ok(toolsOf()), trends: ok(trendsOf()), sessions: ok(sessionsOf()), detail: null, selectedSession: null, base: {},
};
const view = (over: Partial<AnalyticsViewProps> = {}) => html(h(AnalyticsView, { ...DEFAULT_PROPS, ...over }));
const page = async (query: SearchParams = {}) => html(await AnalyticsPage({ searchParams: Promise.resolve(query) }));

/** The text of the table row containing `needle` (rows have no attributes in this UI). */
const rowText = (markup: string, needle: string): string => {
  const row = markup.split("<tr>").find((r) => r.includes(needle));
  if (row === undefined) throw new Error(`no row containing ${needle}`);
  return plain(row.slice(0, row.indexOf("</tr>"))).trim();
};

/** Plain-text rows of the table whose accessible caption is `caption`, header row first. */
const tableRows = (markup: string, caption: string): string[] => {
  const start = markup.indexOf(`<caption class="sr-only">${caption}</caption>`);
  if (start < 0) throw new Error(`no table captioned ${caption}`);
  const table = markup.slice(start, markup.indexOf("</table>", start));
  return table.split("<tr").slice(1).map((row) => plain(row.slice(row.indexOf(">") + 1, row.indexOf("</tr>"))).trim());
};

const saved = process.env[DATABASE_PATH_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
  else process.env[DATABASE_PATH_ENV] = saved;
});

describe("database and scan states", () => {
  it("explains a missing database, says nothing was created, and shows no figures", async () => {
    const target = join(tempDir(), "missing", "usage.db");
    process.env[DATABASE_PATH_ENV] = target;
    const out = await page();
    const text = plain(out);

    expect(text).toContain("No database yet");
    expect(text).toContain("nothing was created");
    expect(out).not.toContain("<table");
    expect(text).not.toContain("Facts coverage");
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("explains a database with no completed scan", async () => {
    const { store, dbPath } = freshStore();
    store.close();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page();

    expect(plain(out)).toContain("No completed usage scan");
    expect(out).not.toContain("<table");
  });

  it("says how to upgrade an old schema without offering to do it", async () => {
    process.env[DATABASE_PATH_ENV] = databaseAtVersion(3);
    const out = await page();
    const text = plain(out);

    expect(out).toContain('role="alert"');
    expect(text).toContain("SCHEMA_OUTDATED");
    expect(text).toContain("pnpm ingest run --db <absolute database path>");
    expect(text).toContain("never runs ingest or migrations");
    expect(out).not.toContain("<button");
    expect(out).not.toContain("<form");
  });

  it("renders the same upgrade guidance from a synthetic unavailable envelope", () => {
    const out = view({ summary: notOk("unavailable", "SCHEMA_OUTDATED") });
    expect(plain(out)).toContain("How to upgrade");
    expect(out).not.toContain("<table");
  });

  it.each([["no-database", "DATABASE_NOT_FOUND", "No database yet"], ["no-completed-scan", null, "No completed usage scan"]] as const)(
    "renders %s from a synthetic envelope",
    (state, code, title) => {
      const out = view({ summary: notOk(state, code) });
      expect(plain(out)).toContain(title);
      expect(plain(out)).not.toContain("Facts coverage");
    },
  );
});

describe("coverage", () => {
  it("comes first on the page, before any figure", () => {
    const text = plain(view());
    expect(text.indexOf("Facts coverage")).toBeGreaterThan(-1);
    expect(text.indexOf("Facts coverage")).toBeLessThan(text.indexOf("User events"));
    expect(text.indexOf("Facts coverage")).toBeLessThan(text.indexOf("Tool calls"));
  });

  it("says there are no sources, and shows no figure as zero", () => {
    const out = view({ summary: ok(noFacts(coverage({ sources: 0, collected: 0, notCollected: 0, complete: null }))) });
    const text = plain(out);

    expect(text).toContain("No sources");
    expect(text).toContain("nothing has been measured");
    expect(out).not.toContain("<table");
    expect(text).not.toContain("Text size states");
    expect(text).not.toContain("Daily facts");
  });

  it("says sources exist but no facts are collected, with real counts and no metric sections", () => {
    const out = view({ summary: ok(noFacts(coverage({ sources: 4, collected: 0, notCollected: 4, complete: false }))) });
    const text = plain(out);

    expect(text).toContain("Facts not collected");
    expect(text).toContain("4 stored sources have no event facts collected yet");
    expect(text).toContain("this page never runs ingest");
    expect(text).not.toContain("Text size states");
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<button");
  });

  it("flags partial coverage and says missing sources are not zero", () => {
    const out = view({ summary: ok(summaryOf({}, coverage({ sources: 5, collected: 2, notCollected: 3, complete: false }))) });
    const text = plain(out);

    expect(text).toContain("Partial coverage");
    expect(text).toContain("Facts are collected for 2 of 5 stored sources");
    expect(text).toContain("the 3 not collected are missing, not zero");
    expect(text).toContain("Not collected 3");
  });

  it("reports complete coverage without claiming all activity is covered", () => {
    const text = plain(view());
    expect(text).toContain("Complete for stored sources");
    expect(text).toContain("does not mean all Claude Code activity is covered");
    expect(text).not.toContain("Partial coverage");
  });

  it("reports facts collected by an older logic, as the API can", () => {
    const text = plain(view({ summary: ok(summaryOf({}, coverage({ sources: 3, collected: 1, outdated: 2, notCollected: 0, complete: false }))) }));
    expect(text).toContain("Collected (older logic) 2");
    expect(text).toContain("2 sources were collected by an older facts logic");
    expect(text).toContain("Facts are collected for 3 of 3 stored sources");
  });
});

describe("user events", () => {
  it("shows the unverified label and the API note, beside the user-event figures", () => {
    const out = view();
    const text = plain(out);
    const card = out.slice(out.indexOf("User events</h2>"), out.indexOf("Text size states"));

    expect(card).toContain('aria-label="Validation warning"');
    expect(plain(card)).toContain("unverified-source-structure");
    expect(plain(card)).toContain("not yet validated against real Claude Code transcripts");
    expect(plain(card)).toContain("not a verified prompt or turn");
    expect(text).toContain("it is not a count of prompts or turns");
  });

  it("lists every size state, keeping not-read and unsupported apart from empty and from zero", () => {
    const out = view({ summary: ok(summaryOf({ userEvents: { total: 9, bySidechain: { sidechain: 0, main: 0, unknown: 9 }, sizeStates: sizes({ "not-read": 5, unsupported: 3, xs: 1 }), undated: 0 } })) });

    expect(rowText(out, "<code>not-read</code>")).toMatch(/^not-read Content was never read .* which is not a zero length 5/);
    expect(rowText(out, "<code>unsupported</code>")).toMatch(/^unsupported Content was read but is not supported text .* 3/);
    expect(rowText(out, "<code>empty</code>")).toMatch(/^empty Text was read and has zero length 0/);
    expect(rowText(out, "<code>xs</code>")).toContain("1–50 characters");
    expect(rowText(out, "<code>xl</code>")).toContain("more than 5,000 characters");
    const order = [...out.matchAll(/<td[^>]*><code>([\w-]+)<\/code><\/td>/g)].map((m) => m[1]).slice(0, 8);
    expect(order).toEqual(["empty", "xs", "s", "m", "l", "xl", "unsupported", "not-read"]);
    expect(plain(out)).toContain("never counted as zero");
  });

  it("splits events by sidechain state and discloses undated events", () => {
    const out = view({ summary: ok(summaryOf({ userEvents: { total: 12, bySidechain: { sidechain: 1, main: 2, unknown: 9 }, sizeStates: sizes({ xs: 12 }), undated: 3 } })) });
    const text = plain(out);

    expect(text).toContain("Main 2");
    expect(text).toContain("Sidechain 1");
    expect(text).toContain("Sidechain unknown 9");
    expect(text).toContain("3 events have no usable timestamp and appears in no day");
  });

  it("does not call these events retries, successes or productivity, and says they are not prompts or turns", () => {
    const negation = "Nothing here measures prompts, turns, task success or productivity.";
    const own = plain(view({ summary: ok(summaryOf({ note: "" })) }));
    expect(own).toContain(negation);
    expect(own.replaceAll(negation, "")).not.toMatch(/\b(retr(y|ies)|productiv\w+|effective\w*|successful)\b/i);
    expect(own).toContain("it is not a count of prompts or turns");
  });
});

describe("tool calls", () => {
  it("renders occurrences, kept, duplicates and anonymous exactly as the API reports them", () => {
    const out = view();
    const text = plain(out);

    expect(text).toContain("Occurrences 11");
    expect(text).toContain("Kept 9");
    expect(text).toContain("Duplicates 2");
    expect(text).toContain("Anonymous 1");
    expect(text).toContain("counted inside Kept");
  });

  it("lists the buckets in the API's fixed order with their own counts, zeros included", () => {
    const out = view();
    const names = [...out.matchAll(/<td[^>]*><code>([\w-]+)<\/code>/g)].map((m) => m[1]);
    // The first 8 code cells belong to the size-state table.
    expect(names.slice(8, 8 + TOOL_BUCKETS.length)).toEqual([...TOOL_BUCKETS]);
    expect(rowText(out, "<code>Read</code>")).toMatch(/^Read 5 4 1/);
    expect(rowText(out, "<code>Bash</code>")).toMatch(/^Bash 3 3 0/);
    expect(rowText(out, "<code>WebFetch</code>")).toMatch(/^WebFetch 0 0 0/);
    expect(rowText(out, "<code>other</code>")).toMatch(/^other — a name outside the fixed list 2 1 1/);
    expect(rowText(out, "<code>unknown</code>")).toMatch(/^unknown — name missing or unreadable 1 1 0/);
  });

  it("shows group sizes apart from anonymous calls", () => {
    const rows = tableRows(view(), "Kept calls that have an id, by how many occurrences share the id");
    expect(rows).toEqual([
      "Occurrences sharing one id Ids", "1 (no repeat) 6", "2 2", "3 0", "4 0", "5 0", "6 0", "7 0", "8 0", "9 0", "10+ 1",
    ]);
    expect(plain(view())).toContain("calls with no id are separate and are never merged");
  });

  it("states that counts describe parsed structure, not execution, success or quality", () => {
    const text = plain(view());
    expect(text).toContain("They do not show that a tool ran, succeeded or was useful");
    expect(text).toContain("Not an error or quality measure");
  });

  it("omits the section when the API holds no tool facts", () => {
    expect(plain(view({ tools: ok({ ...toolsOf(), toolCalls: null }) }))).not.toContain("Tool calls by bucket");
  });
});

describe("trends", () => {
  it("lists UTC days newest first with their own figures and a size column per state", () => {
    const out = view();
    const text = plain(out);

    expect(text).toContain("Daily facts (UTC)");
    expect(out.indexOf("2026-04-01")).toBeLessThan(out.indexOf("2026-01-10"));
    expect(rowText(out, "2026-04-01")).toBe("2026-04-01 4 1 1 2 0 1 0 0 0 0 0 3 5 4 1");
    expect(rowText(out, "2026-01-10")).toBe("2026-01-10 2 1 1 2 0 0 0 0 0 0 2 0 0 0 0");
    expect(text).toContain("A day with no recorded facts is not listed, and is not zero");
    expect(text).toContain("Showing 2 of 2 days");
  });

  it("shows the undated slice separately, when present, and not as a day", () => {
    const out = view({ trends: ok(trendsOf({ undated: slice({ userEvents: 7, sizeStates: sizes({ "not-read": 7 }), toolOccurrences: 0, toolKept: 0, toolDuplicates: 0 }) })) });
    const text = plain(out);

    expect(text).toContain("No usable timestamp (undated)");
    expect(rowText(out, "No usable timestamp")).toContain("7 1 1 2 0 0 0 0 0 0 0 7 0 0 0");
    expect(text).toContain("not part of any day, and not filtered by the range");
    expect(plain(view())).not.toContain("undated");
  });

  it("says when a range matches no day, instead of showing zeros", () => {
    const out = view({ trends: ok(trendsOf({ from: "2030-01-01", total: 0, items: [] })) });
    expect(plain(out)).toContain("No day with recorded facts falls in this range.");
    expect(out).not.toContain("Facts by UTC day");
  });

  it("pages with the API's offset and keeps the other parameters", () => {
    const out = view({ trends: ok(trendsOf({ total: 120, limit: 50, offset: 50, from: "2026-01-01" })), base: { from: "2026-01-01", offset: "50", session: REF_A } });
    expect(out).toMatch(/href="\/analytics\?from=2026-01-01&amp;session=0123456789abcdef"[^>]*>Previous/);
    expect(out).toMatch(/href="\/analytics\?from=2026-01-01&amp;offset=100&amp;session=0123456789abcdef"[^>]*>Next/);
    expect(plain(out)).toContain("Showing 51–100 of 120");
  });

  it("has a GET filter form that submits blank dates like a browser", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const params = submitForm(await page(), "/analytics");
    expect(Object.fromEntries(params)).toEqual({ from: "", to: "" });

    const ranged = await page(toRaw(submitForm(await page(), "/analytics", { from: "2026-04-01", to: "2026-04-01" })));
    const days = ranged.slice(ranged.indexOf("Daily facts"), ranged.indexOf("Sessions</h2>"));
    expect(days).toContain("2026-04-01");
    expect(days).not.toContain("2026-01-10");
    expect(ranged).not.toContain("The request is not valid");
  });
});

describe("sessions", () => {
  it("shows shortened opaque references that link to the full reference, and a row for facts with no session", () => {
    const out = view({ sessions: ok(sessionsOf({ total: 3, items: [sessionItem(REF_A), sessionItem(null, { userEvents: 1, toolOccurrences: 0, toolKept: 0, firstTimestamp: null, lastTimestamp: null }), sessionItem(REF_B)] })) });

    expect(out).toContain(">01234567</a>");
    expect(out).not.toContain(`>${REF_A}<`);
    expect(out).toContain(`href="/analytics?session=${REF_A}"`);
    expect(rowText(out, "(no session id recorded)")).toBe("(no session id recorded) 1 0 0 not recorded not recorded");
    expect(plain(out)).toContain("not a Claude session id, and it does not identify a user, device or project");
  });

  it("pages sessions with its own parameter and keeps the rest", () => {
    const out = view({ sessions: ok(sessionsOf({ total: 120, limit: 50, offset: 50 })), base: { soffset: "50", from: "2026-01-01" } });
    expect(out).toMatch(/href="\/analytics\?from=2026-01-01"[^>]*>Previous/);
    expect(out).toMatch(/href="\/analytics\?soffset=100&amp;from=2026-01-01"[^>]*>Next/);
    expect(plain(out)).toContain("Showing 51–100 of 120");
  });

  it("shows a selected session with size states, tool buckets and its paged days", () => {
    const out = view({ detail: ok(detailOf({ daysPage: { limit: 1, offset: 1, total: 3 } })), selectedSession: REF_A, base: { session: REF_A, doffset: "1" } });
    const text = plain(out);

    expect(text).toContain("Session 01234567");
    expect(out.indexOf("Session 01234567")).toBeGreaterThan(out.indexOf("Sessions</h2>"));
    expect(tableRows(out, "Text size states of the user events in this session")).toHaveLength(9);
    expect(text).toContain("Tool calls of this session by bucket");
    expect(text).toContain("Showing 1 of 3 days");
    expect(out).toMatch(/href="\/analytics\?session=0123456789abcdef"[^>]*>Previous/);
    expect(out).toMatch(/href="\/analytics\?session=0123456789abcdef&amp;doffset=2"[^>]*>Next/);
  });

  it("shows a not-found state for an unknown or ambiguous reference", () => {
    const out = view({ detail: ok(detailOf({ session: null, sizeStates: null, toolBuckets: null, days: [], daysPage: { limit: 50, offset: 0, total: 0 } })), selectedSession: REF_B });
    const text = plain(out);

    expect(text).toContain("No session with reference fedcba98 has recorded facts, or the reference is ambiguous");
    expect(text).not.toContain("Tool calls of this session");
  });

  it("walks list, detail and not-found through the real page", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const ref = sessionRef(saltOf(dbPath), "sess-F");

    const listing = await page();
    expect(listing).toContain(`href="/analytics?session=${ref}"`);

    const selected = await page({ session: ref });
    expect(plain(selected)).toContain(`Session ${ref.slice(0, 8)}`);
    expect(plain(selected)).toContain("Days (UTC) of this session, newest first");

    const unknown = await page({ session: "f".repeat(16) });
    expect(plain(unknown)).toContain("No session with reference ffffffff has recorded facts");
    expect(unknown).not.toContain('role="alert"');
  });

  it("pages sessions through the real page with bounded results", async () => {
    const many = `${Array.from({ length: 60 }, (_, i) => JSON.stringify({ type: "user", sessionId: `many-${i}`, timestamp: "2026-06-01T00:00:00.000Z", message: { content: "x" } })).join("\n")}\n`;
    const { dbPath } = await factsDatabase({ basic: false, extra: [["many.jsonl", many]] });
    process.env[DATABASE_PATH_ENV] = dbPath;

    const first = await page();
    const second = await page({ soffset: "50" });
    const sessionsOf = (markup: string) => markup.slice(markup.indexOf("Sessions</h2>"));
    const count = (markup: string) => (sessionsOf(markup).match(/class="font-mono underline"/g) ?? []).length;
    expect(count(first)).toBe(50);
    expect(count(second)).toBe(11);
    expect(plain(second)).toContain("Showing 51–61 of 61");
    expect(second).toMatch(/Previous/);
  });
});

describe("invalid requests", () => {
  it.each([
    [{ from: "2026-02-30" }, "from"],
    [{ to: "nope" }, "to"],
    [{ offset: "-1" }, "offset"],
    [{ soffset: "abc" }, "soffset"],
    [{ session: "sess-F" }, "session"],
    [{ session: "0123456789abcdef", doffset: "x" }, "doffset"],
    [{ limit: "5" }, "unknown"],
    [{ from: ["2026-01-01", "2026-01-02"] }, "from"],
  ] as const)("names only the parameter for %j and still renders a usable page", async (query, parameter) => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page(query as SearchParams);

    expect(out).toContain('role="alert"');
    expect(plain(out)).toContain(`parameter: ${parameter}`);
    expect(plain(out)).toContain("Facts coverage");
    for (const value of Object.values(query).flat()) expect(plain(out)).not.toContain(`parameter: ${value}`);
  });
});

describe("failures", () => {
  it("renders a fixed code only, never database error text, for a failed query", async () => {
    const { dbPath } = await factsDatabase();
    withRawDatabase(dbPath, (db) => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.exec("UPDATE source_user_events SET size_state = 'CANARY_BAD_STATE /Users/x/secret' WHERE id = 1");
    });
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page();

    expect(out).toContain('role="alert"');
    expect(plain(out)).toContain("QUERY_FAILED");
    expect(out).not.toMatch(/CANARY|secret|\/Users\/|SQLITE|Error:|\bat \w+ \(/);
  });

  it("replaces a code that does not look like a fixed code word", () => {
    const hostile = "boom at /Users/x/CANARY_ERR_PATH\n    at Object.<anonymous> (file.ts:1:1)";
    for (const props of [{ summary: notOk<never>("unavailable", hostile) }, { tools: notOk<never>("unavailable", hostile) }, { trends: notOk<never>("unavailable", hostile) }, { sessions: notOk<never>("unavailable", hostile) }]) {
      const out = view(props);
      expect(out).not.toMatch(/CANARY_ERR|\/Users\/|file\.ts|Object\./);
      expect(plain(out)).toContain("UNKNOWN");
    }
    const detail = view({ detail: notOk<never>("unavailable", hostile), selectedSession: REF_A });
    expect(detail).not.toMatch(/CANARY_ERR|\/Users\/|file\.ts/);
  });

  it("shows the request-error boundary without reading the error", () => {
    const error = Object.assign(new Error("SELECT secret FROM x /Users/y/CANARY_THROWN"), { digest: "abc123digest" });
    const out = html(h(AnalyticsError as (props: { error: Error }) => ReactElement, { error } as never));
    expect(out).toContain('role="alert"');
    expect(plain(out)).toContain("No details are shown here");
    expect(out).not.toMatch(/SELECT|CANARY|\/Users\/|abc123digest/);
  });

  it("shows an explicit loading state", () => {
    const out = html(h(Loading));
    expect(out).toContain('role="status"');
    expect(plain(out)).toContain("Loading event facts");
  });
});

describe("independence from token accounting", () => {
  it("shows no token figure or settled total, and says the facts are independent of them", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page();
    const text = plain(out);

    expect(text).not.toMatch(/settled|cache (read|creation)|input tokens|output tokens|billing|cost/i);
    expect(text).toContain("independent of token accounting");
    expect(text).toContain("Facts coverage");
  });
});

describe("controls and accessibility", () => {
  it("offers no control for ingest, backfill, opt-in, deletion or labelling", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page({ session: sessionRef(saltOf(dbPath), "sess-F") });

    expect([...out.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Apply"]);
    const forms = out.match(/<form\b[^>]*>/g) ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="get"');
    expect(forms[0]).toContain('action="/analytics"');
    expect(out).not.toMatch(/type="(checkbox|radio|file)"|<select|<textarea|method="post"/i);
    expect(plain(out)).not.toMatch(/\b(backfill|delete source|project label)\b/i);
  });

  it("uses one h1, section headings, captioned tables with column headers, and labelled controls", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page({ session: sessionRef(saltOf(dbPath), "sess-F") });

    expect(out.match(/<h1\b/g)).toHaveLength(1);
    expect([...out.matchAll(/<h2[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Facts coverage", "User events", "Tool calls", "Daily facts (UTC)", "Sessions", expect.stringMatching(/^Session [0-9a-f]{8}$/)]);
    const tables = out.match(/<table\b/g)?.length ?? 0;
    expect(tables).toBeGreaterThan(5);
    expect(out.match(/<caption class="sr-only">/g)).toHaveLength(tables);
    expect(out.match(/<th scope="col"/g)?.length ?? 0).toBeGreaterThan(tables);
    expect(out).toContain('aria-label="Validation warning"');
    expect(out).toContain('aria-label="Sections"');
    expect(out).toMatch(/<label[^>]*>\s*From \(UTC day\)/);
    expect(out).toMatch(/<label[^>]*>\s*To \(UTC day\)/);
    expect(out.match(/role="region" aria-label="[^"]+"/g)?.length).toBe(tables);
  });

  it("is in the navigation and marked current only on its own page", async () => {
    expect(NAV.map((n) => n.href)).toContain("/analytics");
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const out = await page();
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0]).toContain('href="/analytics"');
  });
});

describe("privacy of the rendered page", () => {
  it("leaks no canary, path, raw id, fingerprint, salt or internal name, with the opt-in on and off", async () => {
    for (const optIn of [true, false]) {
      const { dbPath, base, salt } = await factsDatabase({ optIn });
      process.env[DATABASE_PATH_ENV] = dbPath;
      const ref = sessionRef(salt, "sess-F");
      for (const query of [{}, { session: ref }, { session: "f".repeat(16) }, { soffset: "1" }] as SearchParams[]) {
        const out = await page(query);
        for (const secret of [...FACT_CANARIES, ...ALL_CANARIES, "CANARY", "sess-F", "sess-A", "toolu_", "mcp__", "<odd>", "msg_", "secret.txt", "a.jsonl", "b.jsonl", "usage-basic", base, dbPath, salt]) {
          expect(out, secret).not.toContain(secret);
        }
        expect(out).not.toMatch(/tool_id_fp|session_fp|size_state|source_files|tool_calls|source_user_events|fingerprint/);
        expect(out).not.toMatch(/\/Users\/|\/private\/var|\/tmp\//);
        // The only long hex strings are full opaque references inside link targets, never shown as text.
        expect(plain(out)).not.toMatch(/[0-9a-f]{9,}/);
        for (const hex of out.match(/[0-9a-f]{17,}/g) ?? []) throw new Error(`long hex string rendered: ${hex.length} chars`);
      }
    }
  });

  it("renders the synthetic views with no raw identifiers either", () => {
    const out = view({ detail: ok(detailOf()), selectedSession: REF_A });
    expect(plain(out)).not.toContain(REF_A);
    expect(baseOf(coverage()).note).toBeDefined();
  });
});
