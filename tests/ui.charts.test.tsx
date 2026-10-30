import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StackedBars } from "@/components/charts/stacked-bars";
import { SERIES_COLORS, type ChartSeries } from "@/components/charts/theme";
import { AnalyticsView, type AnalyticsViewProps } from "@/components/dashboard/analytics-view";
import { CoverageChart, DailyToolCallsChart, DailyUserEventsChart, SizeStatesChart, ToolBucketsChart, dailyEventRows, dailyToolRows, sizeStateRows, toolBucketRows } from "@/components/dashboard/analytics-charts";
import { AccountingStatesChart, TOKEN_SERIES, TokenComposition, TokensByDay, TokensByModel, tokenDayRows, tokenModelRows } from "@/components/dashboard/usage-charts";
import { FACT_CANARIES } from "./facts-helpers";
import { coverage, noFacts, notOk, ok, sessionsOf, sizes, slice, summaryOf, toolsOf, trendsOf } from "./analytics-ui-helpers";

const html = (element: ReactElement) => renderToStaticMarkup(element);
const plain = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tokens = (i: number, o: number, r: number, c: number) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheCreationTokens: c });
const ZERO = tokens(0, 0, 0, 0);
const legendOf = (markup: string): string[] => [...markup.matchAll(/<li[^>]*><span aria-hidden="true"[^>]*><\/span>([^<]+)<\/li>/g)].map((m) => (m[1] ?? "").trim());

describe("StackedBars (server render)", () => {
  // Recharts draws its svg only in the browser, after measuring: the server renders a correctly sized, labelled
  // frame (no layout shift). The drawn chart is checked in a real browser; the data shaping is tested below.
  const series: readonly ChartSeries[] = [{ key: "a", label: "A", color: SERIES_COLORS.s1 }, { key: "b", label: "B", color: SERIES_COLORS.s2 }];
  const data = [{ name: "one", values: { a: 3, b: 1 } }, { name: "two", values: { a: 0, b: 2 } }];

  it("reserves the chart height and labels the group for assistive technology", () => {
    const rows = html(h(StackedBars, { data, series, orientation: "rows", label: "Example rows" }));
    expect(rows).toContain('role="group" aria-label="Example rows"');
    expect(rows).toContain("height:90px"); // 2 rows * 30 + 30 axis band
    const columns = html(h(StackedBars, { data, series, orientation: "columns", label: "Example columns" }));
    expect(columns).toContain('aria-label="Example columns"');
    expect(columns).toContain("height:240px");
    expect(rows + columns).not.toMatch(/CANARY|undefined|NaN|\[object/);
  });

  it("takes its series colors from the theme tokens, never raw hex", () => {
    expect(Object.values(SERIES_COLORS).every((c) => c.startsWith("var(--chart-"))).toBe(true);
  });
});

describe("token charts", () => {
  it("keeps one color per token counter, in a fixed order, everywhere", () => {
    expect(TOKEN_SERIES.map((s) => [s.label, s.color])).toEqual([
      ["Input", "var(--chart-1)"], ["Output", "var(--chart-2)"], ["Cache read", "var(--chart-3)"], ["Cache creation", "var(--chart-4)"],
    ]);
    const out = html(h(TokenComposition, { settled: tokens(10, 20, 30, 40) }));
    expect(legendOf(out)).toEqual(["Input", "Output", "Cache read", "Cache creation"]);
    expect(plain(out)).toContain("conflicting and ambiguous usage is not drawn");
    expect(plain(out)).toContain("The same figures are in the table below");
  });

  it("draws nothing when there is nothing to draw, instead of an empty chart", () => {
    expect(html(h(TokenComposition, { settled: ZERO }))).toBe("");
    expect(html(h(TokensByModel, { items: [] }))).toBe("");
    expect(html(h(TokensByDay, { items: [] }))).toBe("");
    expect(html(h(AccountingStatesChart, { counts: { accepted: 0, duplicate: 0, conflicting: 0, ambiguous: 0 } }))).toBe("");
  });

  it("leaves undated and all-zero days out of the by-day chart and says a missing day is not a zero", () => {
    expect(html(h(TokensByDay, { items: [{ key: null, tokens: tokens(5, 5, 5, 5) }] }))).toBe("");
    const items = [{ key: "2026-02-01", tokens: tokens(1, 1, 1, 1) }, { key: "2026-01-11", tokens: ZERO }, { key: null, tokens: tokens(9, 9, 9, 9) }, { key: "2026-01-10", tokens: tokens(2, 2, 2, 2) }];
    expect(plain(html(h(TokensByDay, { items })))).toContain("a missing day is not a zero");
    const rows = tokenDayRows(items);
    expect(rows.map((r) => r.name)).toEqual(["2026-01-10", "2026-02-01"]); // oldest first; zero and undated days dropped
    expect(rows[0]?.values).toEqual({ inputTokens: 2, outputTokens: 2, cacheReadTokens: 2, cacheCreationTokens: 2 });
  });

  it("names a model with no recorded model plainly and drops all-zero rows", () => {
    expect(tokenModelRows([{ key: null, tokens: tokens(1, 0, 0, 0) }, { key: "model-alpha", tokens: tokens(2, 3, 4, 5) }, { key: "model-beta", tokens: ZERO }]).map((r) => r.name)).toEqual(["(no model recorded)", "model-alpha"]);
  });

  it("charts accounting states with a single series and no legend box", () => {
    const out = html(h(AccountingStatesChart, { counts: { accepted: 7, duplicate: 1, conflicting: 2, ambiguous: 2 } }));
    expect(out).not.toContain("Chart legend");
    expect(plain(out)).toContain("only accepted records are settled");
  });
});

describe("event-facts charts", () => {
  it("coverage: three states, the not-collected one in the de-emphasis gray, and nothing for no sources", () => {
    const out = html(h(CoverageChart, { coverage: coverage({ sources: 5, collected: 2, notCollected: 3, complete: false }) }));
    expect(legendOf(out)).toEqual(["Collected (current logic)", "Collected (older logic)", "Not collected"]);
    expect(out).toContain(SERIES_COLORS.muted);
    expect(html(h(CoverageChart, { coverage: coverage({ sources: 0, collected: 0, notCollected: 0, complete: null }) }))).toBe("");
  });

  it("size states: unsupported and not-read are separate legend entries and colors from measured sizes", () => {
    const out = html(h(SizeStatesChart, { counts: sizes({ xs: 3, unsupported: 2, "not-read": 4 }) }));
    expect(legendOf(out)).toEqual(["Measured size", "Unsupported content (size unknown)", "Not read (size unknown)"]);
    expect(plain(out)).toContain("neither is a zero length");
    for (const color of ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]) expect(out).toContain(color);
    expect(html(h(SizeStatesChart, { counts: sizes() }))).toBe("");
    // Every state keeps its own row, in the API's order, and lands in its own series: a measured size, or its own kind.
    const rows = sizeStateRows(sizes({ empty: 1, xs: 3, unsupported: 2, "not-read": 4 }));
    expect(rows.map((r) => r.name)).toEqual(["empty", "xs", "s", "m", "l", "xl", "unsupported", "not-read"]);
    expect(rows.map((r) => Object.keys(r.values)[0])).toEqual(["measured", "measured", "measured", "measured", "measured", "measured", "unsupported", "not-read"]);
    expect(rows[0]?.values).toEqual({ measured: 1 }); // `empty` is a measured zero length, drawn as its own count
    expect(rows[7]?.values).toEqual({ "not-read": 4 });
  });

  it("tools: omits buckets with no occurrence, says so, and never describes executions", () => {
    const tools = toolsOf().toolCalls;
    if (tools === null) throw new Error("fixture");
    const out = html(h(ToolBucketsChart, { toolCalls: tools }));
    expect(legendOf(out)).toEqual(["Kept", "Duplicates"]);
    expect(plain(out)).toContain("Parsed tool_use blocks, not executions. 10 buckets with no occurrences omitted from the chart.");
    expect(toolBucketRows(tools).map((r) => r.name)).toEqual(["Read", "Bash", "other", "unknown"]); // the API's order, zero rows dropped
    expect(toolBucketRows(tools)[0]?.values).toEqual({ kept: 4, duplicates: 1 });
    expect(html(h(ToolBucketsChart, { toolCalls: { ...tools, byBucket: tools.byBucket.map((r) => ({ ...r, occurrences: 0, kept: 0, duplicates: 0 })) } }))).toBe("");
  });

  it("daily charts: oldest first, only days with facts, no invented days", () => {
    const days = trendsOf().items; // newest first: 2026-04-01, 2026-01-10
    const events = html(h(DailyUserEventsChart, { days }));
    expect(legendOf(events)).toEqual(["Main", "Sidechain", "Sidechain unknown"]);
    expect(dailyEventRows(days).map((r) => r.name)).toEqual(["2026-01-10", "2026-04-01"]); // oldest first
    expect(dailyEventRows(days)[1]?.values).toEqual({ main: 1, sidechain: 1, unknown: 2 });
    expect(dailyToolRows(days).map((r) => r.name)).toEqual(["2026-04-01"]); // the other day has no tool occurrences
    expect(plain(events)).toContain("a missing day is not a zero");
    expect(plain(events)).toContain("Facts without a usable timestamp are in no day");

    const toolsOnly = html(h(DailyToolCallsChart, { days: [{ day: "2026-03-03", ...slice({ toolOccurrences: 0, toolKept: 0, toolDuplicates: 0 }) }] }));
    expect(toolsOnly).toBe("");
    expect(html(h(DailyUserEventsChart, { days: [] }))).toBe("");
  });
});

describe("charts on the analytics page", () => {
  const props: AnalyticsViewProps = { summary: ok(summaryOf()), tools: ok(toolsOf()), trends: ok(trendsOf()), sessions: ok(sessionsOf()), detail: null, selectedSession: null, base: {} };
  const view = (over: Partial<AnalyticsViewProps> = {}) => html(h(AnalyticsView, { ...props, ...over }));

  it("adds five charts beside the tables and keeps every table", () => {
    const out = view();
    expect((out.match(/<figure/g) ?? []).length).toBe(5);
    expect((out.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((out.match(/<caption/g) ?? []).length).toBe((out.match(/<table/g) ?? []).length);
    expect(plain(out)).toContain("unverified-source-structure");
  });

  it("draws no metric chart, and no zero, when facts are not collected or the database is unavailable", () => {
    // Sources exist but no facts: only the coverage chart (4 sources, 0 collected) is shown, never a metric.
    const none = view({ summary: ok(noFacts(coverage({ sources: 4, collected: 0, notCollected: 4, complete: false }))) });
    expect(none.match(/<figure/g)).toHaveLength(1);
    expect(plain(none)).toContain("Sources by facts state");
    for (const title of ["User events by text size state", "Tool occurrences by bucket", "per UTC day"]) expect(none).not.toContain(title);
    // No sources at all: nothing to draw.
    expect(view({ summary: ok(noFacts(coverage({ sources: 0, collected: 0, notCollected: 0, complete: null }))) })).not.toContain("<figure");
    expect(view({ summary: notOk("unavailable", "SCHEMA_OUTDATED") })).not.toContain("<figure");
    expect(view({ summary: notOk("no-database", "DATABASE_NOT_FOUND") })).not.toContain("<figure");
  });

  it("shows the coverage chart only from the coverage block, with partial coverage visible", () => {
    const out = view({ summary: ok(summaryOf({}, coverage({ sources: 5, collected: 2, notCollected: 3, complete: false }))) });
    expect(plain(out)).toContain("Sources by facts state");
    expect(plain(out)).toContain("Not collected");
  });

  it("carries no token, productivity or identifier text in any chart", () => {
    const figures = [...view().matchAll(/<figure[\s\S]*?<\/figure>/g)].map((m) => plain(m[0])).join(" ");
    expect(figures).not.toMatch(/settled|cache (read|creation)|input tokens|output tokens|billing|productiv|success(ful)?\b/i);
    for (const canary of FACT_CANARIES) expect(figures).not.toContain(canary);
    expect(figures).not.toMatch(/[0-9a-f]{9,}|toolu_|mcp__|sess-/);
  });
});
