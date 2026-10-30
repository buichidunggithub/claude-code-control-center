import { ChartBlock } from "@/components/charts/chart-block";
import { StackedBars } from "@/components/charts/stacked-bars";
import { SERIES_COLORS, type ChartDatum, type ChartSeries } from "@/components/charts/theme";
import type { AnalyticsTools, DayFacts, FactsCoverage, SizeStateCounts } from "@/core/analysis";
import { PROMPT_LENGTH_BUCKETS, TEXT_LENGTH_STATES } from "@/core/parse";

type ToolCalls = NonNullable<AnalyticsTools["toolCalls"]>;

const measured = new Set<string>(PROMPT_LENGTH_BUCKETS);

/** Chronological order: the API lists newest first. Only days that have facts exist; none is invented. */
const chronological = (days: readonly DayFacts[]): readonly DayFacts[] => [...days].reverse();

/** Pure row builders, exported so the data shaping can be tested without drawing. */
export function sizeStateRows(counts: SizeStateCounts): ChartDatum[] {
  return TEXT_LENGTH_STATES.map((state) => ({ name: state, values: { [measured.has(state) ? "measured" : state]: counts[state] } }));
}

/** Keeps the API's bucket order and drops buckets with no occurrence. */
export function toolBucketRows(toolCalls: ToolCalls): ChartDatum[] {
  return toolCalls.byBucket.filter((r) => r.occurrences > 0).map((r) => ({ name: r.bucket, values: { kept: r.kept, duplicates: r.duplicates } }));
}

export function dailyEventRows(days: readonly DayFacts[]): ChartDatum[] {
  return chronological(days)
    .filter((d) => d.userEvents > 0)
    .map((d) => ({ name: d.day, values: { main: d.userEventsBySidechain.main, sidechain: d.userEventsBySidechain.sidechain, unknown: d.userEventsBySidechain.unknown } }));
}

export function dailyToolRows(days: readonly DayFacts[]): ChartDatum[] {
  return chronological(days)
    .filter((d) => d.toolOccurrences > 0)
    .map((d) => ({ name: d.day, values: { kept: d.toolKept, duplicates: d.toolDuplicates } }));
}

const COVERAGE_SERIES: readonly ChartSeries[] = [
  { key: "collected", label: "Collected (current logic)", color: SERIES_COLORS.s1 },
  { key: "outdated", label: "Collected (older logic)", color: SERIES_COLORS.s2 },
  { key: "notCollected", label: "Not collected", color: SERIES_COLORS.muted },
];

/** Stored sources by facts state. "Not collected" is the de-emphasis gray: it is missing data, not a measurement. */
export function CoverageChart({ coverage }: { coverage: FactsCoverage }) {
  if (coverage.sources === 0) return null;
  return (
    <ChartBlock title="Sources by facts state" series={COVERAGE_SERIES} note="Counts of stored sources, not of events.">
      <StackedBars
        orientation="rows"
        label="Stored sources by facts state, one stacked bar"
        data={[{ name: "Sources", values: { collected: coverage.collected, outdated: coverage.outdated, notCollected: coverage.notCollected } }]}
        series={COVERAGE_SERIES}
      />
    </ChartBlock>
  );
}

/** Three kinds, three colors: a measured size, content read but unsupported, and content never read. */
const SIZE_SERIES: readonly ChartSeries[] = [
  { key: "measured", label: "Measured size", color: SERIES_COLORS.s1 },
  { key: "unsupported", label: "Unsupported content (size unknown)", color: SERIES_COLORS.s2 },
  { key: "not-read", label: "Not read (size unknown)", color: SERIES_COLORS.s3 },
];

export function SizeStatesChart({ counts }: { counts: SizeStateCounts }) {
  if (TEXT_LENGTH_STATES.every((s) => counts[s] === 0)) return null;
  const data = sizeStateRows(counts);
  return (
    <ChartBlock title="User events by text size state" series={SIZE_SERIES} note="Unsupported and not-read are different colors from the measured sizes because their size is unknown; neither is a zero length.">
      <StackedBars orientation="rows" label="User events by text size state, bars" data={data} series={SIZE_SERIES} />
    </ChartBlock>
  );
}

const TOOL_SERIES: readonly ChartSeries[] = [
  { key: "kept", label: "Kept", color: SERIES_COLORS.s1 },
  { key: "duplicates", label: "Duplicates", color: SERIES_COLORS.s2 },
];

/** The API's bucket order is kept; buckets with no occurrence are left out of the chart (the table lists them all). */
export function ToolBucketsChart({ toolCalls }: { toolCalls: ToolCalls }) {
  const rows = toolBucketRows(toolCalls);
  if (rows.length === 0) return null;
  const omitted = toolCalls.byBucket.length - rows.length;
  return (
    <ChartBlock
      title="Tool occurrences by bucket"
      series={TOOL_SERIES}
      note={`Parsed tool_use blocks, not executions. ${omitted} bucket${omitted === 1 ? "" : "s"} with no occurrences omitted from the chart.`}
    >
      <StackedBars
        orientation="rows"
        label="Tool occurrences by bucket, kept and duplicate, stacked bars"
        data={rows}
        series={TOOL_SERIES}
      />
    </ChartBlock>
  );
}

const EVENT_SERIES: readonly ChartSeries[] = [
  { key: "main", label: "Main", color: SERIES_COLORS.s1 },
  { key: "sidechain", label: "Sidechain", color: SERIES_COLORS.s2 },
  { key: "unknown", label: "Sidechain unknown", color: SERIES_COLORS.s3 },
];

const DAY_NOTE = "Oldest day on the left. Only days with recorded facts are drawn; a missing day is not a zero. Facts without a usable timestamp are in no day.";

export function DailyUserEventsChart({ days }: { days: readonly DayFacts[] }) {
  const rows = dailyEventRows(days);
  if (rows.length === 0) return null;
  return (
    <ChartBlock title="User events per UTC day" series={EVENT_SERIES} note={DAY_NOTE}>
      <StackedBars
        orientation="columns"
        label="Source-typed user events per UTC day, stacked columns"
        data={rows}
        series={EVENT_SERIES}
        tickStyle="month-day"
      />
    </ChartBlock>
  );
}

export function DailyToolCallsChart({ days }: { days: readonly DayFacts[] }) {
  const rows = dailyToolRows(days);
  if (rows.length === 0) return null;
  return (
    <ChartBlock title="Tool occurrences per UTC day" series={TOOL_SERIES} note={DAY_NOTE}>
      <StackedBars
        orientation="columns"
        label="Tool occurrences per UTC day, kept and duplicate, stacked columns"
        data={rows}
        series={TOOL_SERIES}
        tickStyle="month-day"
      />
    </ChartBlock>
  );
}
