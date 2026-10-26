import Link from "next/link";
import type { ReactNode } from "react";
import type { TokenTotals } from "@/core/analysis";
import { TOKEN_LABELS, TOKEN_ORDER, fmt, sumTokens } from "./format";

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <dt className="text-xs text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{hint}</dd> : null}
    </div>
  );
}

export const StatGrid = ({ children }: { children: ReactNode }) => <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</dl>;

/** Horizontal table wrapper so wide tables scroll inside the card at phone widths. */
export function TableWrap({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export const Th = ({ children, num }: { children: ReactNode; num?: boolean }) => (
  <th scope="col" className={`whitespace-nowrap border-b border-neutral-300 px-2 py-1.5 text-xs font-medium dark:border-neutral-700 ${num ? "text-right" : ""}`}>
    {children}
  </th>
);

export const Td = ({ children, num }: { children: ReactNode; num?: boolean }) => (
  <td className={`border-b border-neutral-200 px-2 py-1.5 align-top dark:border-neutral-800 ${num ? "text-right" : ""}`}>{children}</td>
);

/** Token table: one row per group, the four counters plus a CSS bar of their sum (decorative). */
export function TokenRows({ rows, keyLabel, caption }: { rows: readonly { key: string; records: number; tokens: TokenTotals }[]; keyLabel: string; caption: string }) {
  const max = Math.max(1, ...rows.map((r) => sumTokens(r.tokens)));
  return (
    <TableWrap caption={caption}>
      <thead>
        <tr>
          <Th>{keyLabel}</Th>
          <Th num>Records</Th>
          {TOKEN_ORDER.map((f) => (
            <Th key={f} num>{TOKEN_LABELS[f]}</Th>
          ))}
          <Th>Share of largest row</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <Td>{r.key}</Td>
            <Td num>{fmt(r.records)}</Td>
            {TOKEN_ORDER.map((f) => (
              <Td key={f} num>{fmt(r.tokens[f])}</Td>
            ))}
            <Td>
              <div aria-hidden="true" className="h-2 w-28 rounded bg-neutral-200 dark:bg-neutral-800">
                <div className="h-2 rounded bg-neutral-700 dark:bg-neutral-300" style={{ width: `${Math.round((sumTokens(r.tokens) / max) * 100)}%` }} />
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

export function hrefWith(path: string, base: Record<string, string | null | undefined>, patch: Record<string, string | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v !== null && v !== undefined && v !== "") params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function Pager({ path, base, limit, offset, total }: { path: string; base: Record<string, string | null | undefined>; limit: number; offset: number; total: number }) {
  if (total <= limit && offset === 0) return null;
  const prev = Math.max(0, offset - limit);
  return (
    <nav aria-label="Pagination" className="mt-2 flex items-center gap-3 text-sm">
      <span>
        Showing {total === 0 ? 0 : offset + 1}–{Math.min(total, offset + limit)} of {fmt(total)}
      </span>
      {offset > 0 ? <Link className="underline" href={hrefWith(path, base, { offset: prev === 0 ? null : String(prev) })}>Previous</Link> : null}
      {offset + limit < total ? <Link className="underline" href={hrefWith(path, base, { offset: String(offset + limit) })}>Next</Link> : null}
    </nav>
  );
}
