/**
 * Chart colors by role. Values are CSS custom properties (defined for light and dark in globals.css), so the same
 * chart code renders on either surface. The four series colors are categorical slots 1-4 of the validated palette,
 * assigned in fixed order and never cycled: a chart with more categories than slots folds them or becomes a table.
 */
export const SERIES_COLORS = {
  s1: "var(--chart-1)",
  s2: "var(--chart-2)",
  s3: "var(--chart-3)",
  s4: "var(--chart-4)",
  /** The de-emphasis gray: "not collected", "context", never a status. */
  muted: "var(--chart-muted-series)",
} as const;

export const CHROME = {
  surface: "var(--chart-surface)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  textMuted: "var(--chart-text-muted)",
  text: "var(--chart-text)",
} as const;

/** One stacked or grouped series. `color` is a SERIES_COLORS value; it follows the entity, not its position. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

/** One category (a day, a model, a bucket) with a value per series key. Absent or zero keys draw nothing. */
export interface ChartDatum {
  readonly name: string;
  readonly values: Readonly<Record<string, number>>;
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat("en-US");

export const compact = (n: number): string => COMPACT.format(n);
export const full = (n: number): string => FULL.format(n);
