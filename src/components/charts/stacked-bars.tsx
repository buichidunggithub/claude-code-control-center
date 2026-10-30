"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHROME, compact, full, type ChartDatum, type ChartSeries } from "./theme";

/** Fixed specs shared by every chart: thin marks, a 2px surface gap between fills, 4px rounded data ends. */
const MAX_BAR_PX = 24;
const GAP_PX = 2;
const END_RADIUS = 4;
const ROW_PX = 30;
const AXIS_BAND_PX = 30;
const COLUMN_CHART_PX = 240;
const MAX_LABEL_PX = 168;
const CHAR_PX = 6.6;
/** Used for the server render and the first paint, before the container has been measured. */
const FIRST_PAINT_WIDTH = 640;

export interface StackedBarsProps {
  readonly data: readonly ChartDatum[];
  readonly series: readonly ChartSeries[];
  /** `columns`: categories along x (time). `rows`: categories down y, bars grow rightwards (names, buckets). */
  readonly orientation: "columns" | "rows";
  /** Shown to assistive technology; the same figures are always available in a table. */
  readonly label: string;
  /**
   * Category tick text; the tooltip always shows the full name. A string, not a function, because this component
   * receives its props from server components. `month-day` turns YYYY-MM-DD into MM-DD.
   */
  readonly tickStyle?: "plain" | "month-day";
}

interface TooltipProps {
  readonly active?: boolean;
  readonly label?: string | number;
  readonly payload?: readonly { readonly dataKey?: string | number; readonly value?: number | string }[];
  readonly series: readonly ChartSeries[];
}

function ChartTooltip({ active, label, payload, series }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const lines = series.flatMap((s) => {
    const hit = payload.find((p) => p.dataKey === s.key);
    const value = typeof hit?.value === "number" ? hit.value : 0;
    return value > 0 ? [{ s, value }] : [];
  });
  if (lines.length === 0) return null;
  const total = lines.reduce((n, l) => n + l.value, 0);
  return (
    <div className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900" style={{ color: CHROME.text }}>
      <p className="font-medium">{String(label)}</p>
      <ul className="mt-1 space-y-0.5">
        {lines.map(({ s, value }) => (
          <li key={s.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span className="ml-auto pl-3 tabular-nums">{full(value)}</span>
          </li>
        ))}
      </ul>
      {lines.length > 1 ? <p className="mt-1 border-t border-neutral-200 pt-1 tabular-nums dark:border-neutral-700">Total {full(total)}</p> : null}
    </div>
  );
}

function radiusFor(isLast: boolean, orientation: StackedBarsProps["orientation"]): [number, number, number, number] {
  if (!isLast) return [0, 0, 0, 0];
  return orientation === "columns" ? [END_RADIUS, END_RADIUS, 0, 0] : [0, END_RADIUS, END_RADIUS, 0];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function StackedBars({ data, series, orientation, label, tickStyle = "plain" }: StackedBarsProps) {
  const tickText = (name: string): string => (tickStyle === "month-day" && ISO_DAY.test(name) ? name.slice(5) : name);
  const rows = data.map((d) => ({ name: d.name, ...d.values }));
  const labelWidth = Math.min(MAX_LABEL_PX, Math.ceil(Math.max(...data.map((d) => tickText(d.name).length), 4) * CHAR_PX) + 8);
  const height = orientation === "rows" ? data.length * ROW_PX + AXIS_BAND_PX : COLUMN_CHART_PX;
  const text = { fill: CHROME.textMuted, fontSize: 11 };
  const grid = <CartesianGrid stroke={CHROME.grid} strokeWidth={1} horizontal={orientation === "columns"} vertical={orientation === "rows"} />;
  const tooltip = <Tooltip cursor={{ fill: CHROME.grid, opacity: 0.45 }} content={<ChartTooltip series={series} />} />;

  return (
    <div role="group" aria-label={label} className="w-full">
      <ResponsiveContainer width="100%" height={height} initialDimension={{ width: FIRST_PAINT_WIDTH, height }}>
        <BarChart
          data={rows}
          layout={orientation === "rows" ? "vertical" : "horizontal"}
          margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
          barCategoryGap={orientation === "rows" ? 6 : "20%"}
          accessibilityLayer
        >
          {grid}
          {orientation === "rows" ? (
            <>
              <XAxis type="number" tickFormatter={compact} tick={text} axisLine={{ stroke: CHROME.axis }} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={labelWidth} tick={text} tickFormatter={tickText} axisLine={{ stroke: CHROME.axis }} tickLine={false} interval={0} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" tick={text} tickFormatter={tickText} axisLine={{ stroke: CHROME.axis }} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
              <YAxis type="number" tickFormatter={compact} tick={text} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
            </>
          )}
          {tooltip}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="stack"
              fill={s.color}
              stroke={CHROME.surface}
              strokeWidth={GAP_PX}
              maxBarSize={MAX_BAR_PX}
              radius={radiusFor(i === series.length - 1, orientation)}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
