import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { SizeStateCounts } from "@/core/analysis";
import { PROMPT_LENGTH_THRESHOLDS, TEXT_LENGTH_STATES, type TextLengthState } from "@/core/parse";
import { fmt } from "./format";
import { Note } from "./notice";
import { TableWrap, Td, Th, hrefWith } from "./widgets";

const { EXTRA_SMALL, SMALL, MEDIUM, LARGE } = PROMPT_LENGTH_THRESHOLDS;

/**
 * What each size state means, in the words of the facts schema. `not-read` and `unsupported` are not sizes:
 * they are never shown as, or summed with, a zero length.
 */
export const SIZE_STATE_MEANING: Readonly<Record<TextLengthState, string>> = {
  empty: "Text was read and has zero length",
  xs: `Text was read: 1–${fmt(EXTRA_SMALL)} characters`,
  s: `Text was read: ${fmt(EXTRA_SMALL + 1)}–${fmt(SMALL)} characters`,
  m: `Text was read: ${fmt(SMALL + 1)}–${fmt(MEDIUM)} characters`,
  l: `Text was read: ${fmt(MEDIUM + 1)}–${fmt(LARGE)} characters`,
  xl: `Text was read: more than ${fmt(LARGE)} characters`,
  unsupported: "Content was read but is not supported text (for example a tool result or non-text content); its size is unknown",
  "not-read": "Content was never read (the opt-in was off); its size is unknown, which is not a zero length",
};

export const REF_SHOWN = 8;
export const shortRef = (id: string): string => id.slice(0, REF_SHOWN);

/** The API's fixed validation label and note, shown wherever user-event figures appear. */
export function UnverifiedWarning({ validation, note }: { validation: string; note: string }) {
  return (
    <aside aria-label="Validation warning" className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <p>
        <Badge tone="warn">{validation}</Badge> <strong>Observed source structure, not validated against real transcripts.</strong>
      </p>
      <p className="mt-2">{note}</p>
    </aside>
  );
}

/** A reminder placed beside figures that are not the first to carry the full warning. */
export const UnverifiedHint = () => <Note>Unverified source structure: see the validation warning on this page. Nothing here measures prompts, turns, task success or productivity.</Note>;

/** Decorative share bar (the numbers beside it carry the meaning). */
export function ShareBar({ value, max }: { value: number; max: number }) {
  return (
    <div aria-hidden="true" className="h-2 w-28 rounded bg-neutral-200 dark:bg-neutral-800">
      <div className="h-2 rounded bg-neutral-700 dark:bg-neutral-300" style={{ width: `${max === 0 ? 0 : Math.round((value / max) * 100)}%` }} />
    </div>
  );
}

/** One row per state in the API's order. Every state is listed, with its own meaning. */
export function SizeStateTable({ counts, caption }: { counts: SizeStateCounts; caption: string }) {
  const max = Math.max(...TEXT_LENGTH_STATES.map((s) => counts[s]));
  return (
    <TableWrap caption={caption}>
      <thead>
        <tr>
          <Th>State</Th>
          <Th>Meaning</Th>
          <Th num>Events</Th>
          <Th>Share of largest row</Th>
        </tr>
      </thead>
      <tbody>
        {TEXT_LENGTH_STATES.map((state) => (
          <tr key={state}>
            <Td><code>{state}</code></Td>
            <Td>{SIZE_STATE_MEANING[state]}</Td>
            <Td num>{fmt(counts[state])}</Td>
            <Td><ShareBar value={counts[state]} max={max} /></Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

export interface OffsetPagerProps {
  readonly path: string;
  /** Every query parameter to keep, as strings. */
  readonly base: Readonly<Record<string, string | null | undefined>>;
  /** The query parameter this pager moves. */
  readonly param: string;
  readonly label: string;
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

/** Previous/next links for one offset parameter, so several paged tables can share a page. */
export function OffsetPager({ path, base, param, label, limit, offset, total }: OffsetPagerProps): ReactNode {
  if (total <= limit && offset === 0) return null;
  const move = (to: number) => hrefWith(path, base, { [param]: to === 0 ? null : String(to) });
  return (
    <nav aria-label={label} className="mt-2 flex items-center gap-3 text-sm">
      <span>
        Showing {total === 0 ? 0 : offset + 1}–{Math.min(total, offset + limit)} of {fmt(total)}
      </span>
      {offset > 0 ? <Link className="underline" href={move(Math.max(0, offset - limit))}>Previous</Link> : null}
      {offset + limit < total ? <Link className="underline" href={move(offset + limit)}>Next</Link> : null}
    </nav>
  );
}
