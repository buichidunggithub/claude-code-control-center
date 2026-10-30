import type { AccountingState, TokenFieldName } from "@/core/parse/types";
import { ChartBlock } from "@/components/charts/chart-block";
import { StackedBars } from "@/components/charts/stacked-bars";
import { SERIES_COLORS, type ChartDatum, type ChartSeries } from "@/components/charts/theme";
import { TOKEN_LABELS, TOKEN_ORDER } from "./format";

/** A token counter keeps one color on every chart (color follows the entity, not its rank). */
const TOKEN_COLOR: Readonly<Record<TokenFieldName, string>> = {
  inputTokens: SERIES_COLORS.s1,
  outputTokens: SERIES_COLORS.s2,
  cacheReadTokens: SERIES_COLORS.s3,
  cacheCreationTokens: SERIES_COLORS.s4,
};

export const TOKEN_SERIES: readonly ChartSeries[] = TOKEN_ORDER.map((f) => ({ key: f, label: TOKEN_LABELS[f], color: TOKEN_COLOR[f] }));

type Tokens = Readonly<Record<TokenFieldName, number>>;

const NO_MODEL = "(no model recorded)";
const toValues = (tokens: Tokens): Record<string, number> => Object.fromEntries(TOKEN_ORDER.map((f) => [f, tokens[f]]));
const hasTokens = (tokens: Tokens): boolean => TOKEN_ORDER.some((f) => tokens[f] > 0);

/** Chronological, only days with settled records and a date. The API lists newest first. */
export function tokenDayRows(items: readonly { key: string | null; tokens: Tokens }[]): ChartDatum[] {
  const dated = items.flatMap((i) => (i.key !== null && hasTokens(i.tokens) ? [{ name: i.key, values: toValues(i.tokens) }] : []));
  return [...dated].reverse();
}

export function tokenModelRows(items: readonly { key: string | null; tokens: Tokens }[]): ChartDatum[] {
  return items.filter((i) => hasTokens(i.tokens)).map((i) => ({ name: i.key ?? NO_MODEL, values: toValues(i.tokens) }));
}

/** Part-to-whole of the settled totals: one stacked bar. Settled records only; nothing unresolved is included. */
export function TokenComposition({ settled }: { settled: Tokens }) {
  if (!hasTokens(settled)) return null;
  return (
    <ChartBlock title="Settled tokens by counter" series={TOKEN_SERIES} note="Accepted records only; conflicting and ambiguous usage is not drawn.">
      <StackedBars orientation="rows" label="Settled tokens by counter, one stacked bar" data={[{ name: "Settled", values: toValues(settled) }]} series={TOKEN_SERIES} />
    </ChartBlock>
  );
}

/** Chronological, one column per day that has settled records. Days with no records are not drawn and are not zero. */
export function TokensByDay({ items }: { items: readonly { key: string | null; tokens: Tokens }[] }) {
  const data = tokenDayRows(items);
  if (data.length === 0) return null;
  return (
    <ChartBlock title="Settled tokens by UTC day" series={TOKEN_SERIES} note="Oldest day on the left. Only days with settled records are drawn; a missing day is not a zero.">
      <StackedBars orientation="columns" label="Settled tokens by UTC day, stacked columns" data={data} series={TOKEN_SERIES} tickStyle="month-day" />
    </ChartBlock>
  );
}

export function TokensByModel({ items }: { items: readonly { key: string | null; tokens: Tokens }[] }) {
  const data = tokenModelRows(items);
  if (data.length === 0) return null;
  return (
    <ChartBlock title="Settled tokens by model" series={TOKEN_SERIES} note="Alphabetical by model name; this page of models only.">
      <StackedBars orientation="rows" label="Settled tokens by model, stacked bars" data={data} series={TOKEN_SERIES} />
    </ChartBlock>
  );
}

const STATE_SERIES: readonly ChartSeries[] = [{ key: "records", label: "Usage records", color: SERIES_COLORS.s1 }];
const STATE_ORDER: readonly AccountingState[] = ["accepted", "duplicate", "conflicting", "ambiguous"];

/** Nominal categories, one series: a single color, not a value ramp. */
export function AccountingStatesChart({ counts }: { counts: Readonly<Record<AccountingState, number>> }) {
  if (STATE_ORDER.every((k) => counts[k] === 0)) return null;
  const data: ChartDatum[] = STATE_ORDER.map((k) => ({ name: k, values: { records: counts[k] } }));
  return (
    <ChartBlock title="Usage records by accounting state" series={STATE_SERIES} note="Every stored record is in exactly one state; only accepted records are settled.">
      <StackedBars orientation="rows" label="Usage records by accounting state, bars" data={data} series={STATE_SERIES} />
    </ChartBlock>
  );
}
