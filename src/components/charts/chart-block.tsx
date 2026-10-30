import type { ReactNode } from "react";
import type { ChartSeries } from "./theme";

/** A swatch and text in the text color: identity comes from the mark beside the words, never from colored words. */
export function ChartLegend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul aria-label="Chart legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-700 dark:text-neutral-300">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export interface ChartBlockProps {
  readonly title: string;
  /** What is drawn and anything the chart leaves out (for example omitted zero rows). */
  readonly note?: ReactNode;
  /** Two or more series always get a legend; a single series is named by the title. */
  readonly series: readonly ChartSeries[];
  readonly children: ReactNode;
}

export function ChartBlock({ title, note, series, children }: ChartBlockProps) {
  return (
    <figure className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      {series.length > 1 ? <div className="mt-1"><ChartLegend series={series} /></div> : null}
      <div className="mt-2">{children}</div>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{note ? <>{note} </> : null}The same figures are in the table below.</p>
    </figure>
  );
}
