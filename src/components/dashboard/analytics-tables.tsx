import { Card } from "@/components/ui/card";
import type { AnalyticsTools, AnalyticsTrends, DayFacts, FactsSlice } from "@/core/analysis";
import { TEXT_LENGTH_STATES } from "@/core/parse";
import { OffsetPager, ShareBar, UnverifiedHint } from "./analytics-shared";
import { fmt } from "./format";
import { Note } from "./notice";
import { Stat, StatGrid, TableWrap, Td, Th } from "./widgets";

type ToolCalls = NonNullable<AnalyticsTools["toolCalls"]>;

const BUCKET_NOTE: Readonly<Record<string, string>> = {
  other: "a name outside the fixed list",
  unknown: "name missing or unreadable",
};

const GROUP_LABEL = (key: string): string => (key === "1" ? "1 (no repeat)" : key);

/** Per-bucket rows in the API's fixed order, then the id-group sizes. Counts of parsed structure, not execution. */
export function ToolsCard({ toolCalls }: { toolCalls: ToolCalls }) {
  const max = Math.max(...toolCalls.byBucket.map((r) => r.occurrences));
  return (
    <Card title="Tool calls" description="Counts of tool_use blocks found in the parsed source structure. They do not show that a tool ran, succeeded or was useful.">
      <StatGrid>
        <Stat label="Occurrences" value={fmt(toolCalls.occurrences)} hint="Every recorded tool_use block, repeats included." />
        <Stat label="Kept" value={fmt(toolCalls.kept)} hint="One per tool-use id, plus every call with no id." />
        <Stat label="Duplicates" value={fmt(toolCalls.duplicates)} hint="Repeats of an id already kept. Not an error or quality measure." />
        <Stat label="Anonymous" value={fmt(toolCalls.anonymous)} hint="No id recorded. Never merged; counted inside Kept." />
      </StatGrid>
      <div className="mt-4">
        <TableWrap caption="Tool calls by bucket, in the API's fixed order">
          <thead>
            <tr>
              <Th>Bucket</Th>
              <Th num>Occurrences</Th>
              <Th num>Kept</Th>
              <Th num>Duplicates</Th>
              <Th>Share of largest row</Th>
            </tr>
          </thead>
          <tbody>
            {toolCalls.byBucket.map((row) => (
              <tr key={row.bucket}>
                <Td>
                  <code>{row.bucket}</code>
                  {BUCKET_NOTE[row.bucket] ? <span className="text-xs text-neutral-600 dark:text-neutral-400"> — {BUCKET_NOTE[row.bucket]}</span> : null}
                </Td>
                <Td num>{fmt(row.occurrences)}</Td>
                <Td num>{fmt(row.kept)}</Td>
                <Td num>{fmt(row.duplicates)}</Td>
                <Td><ShareBar value={row.occurrences} max={max} /></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
      <div className="mt-4">
        <TableWrap caption="Kept calls that have an id, by how many occurrences share the id">
          <thead>
            <tr>
              <Th>Occurrences sharing one id</Th>
              <Th num>Ids</Th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(toolCalls.groupSizes).map(([size, groups]) => (
              <tr key={size}>
                <Td>{GROUP_LABEL(size)}</Td>
                <Td num>{fmt(groups)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
      <div className="mt-3 space-y-1">
        <Note>A bucket groups tool names: only a fixed list of built-in names is shown by name; every other name is counted under “other”. A repeated id is one kept call and its repeats; calls with no id are separate and are never merged.</Note>
        <UnverifiedHint />
      </div>
    </Card>
  );
}

function SliceCells({ slice }: { slice: FactsSlice }) {
  return (
    <>
      <Td num>{fmt(slice.userEvents)}</Td>
      <Td num>{fmt(slice.userEventsBySidechain.main)}</Td>
      <Td num>{fmt(slice.userEventsBySidechain.sidechain)}</Td>
      <Td num>{fmt(slice.userEventsBySidechain.unknown)}</Td>
      {TEXT_LENGTH_STATES.map((s) => <Td key={s} num>{fmt(slice.sizeStates[s])}</Td>)}
      <Td num>{fmt(slice.toolOccurrences)}</Td>
      <Td num>{fmt(slice.toolKept)}</Td>
      <Td num>{fmt(slice.toolDuplicates)}</Td>
    </>
  );
}

export interface TrendsCardProps {
  readonly trends: AnalyticsTrends;
  readonly base: Readonly<Record<string, string | null | undefined>>;
  readonly session: string | null;
}

export function TrendsCard({ trends, base, session }: TrendsCardProps) {
  const rangeActive = trends.from !== null || trends.to !== null;
  return (
    <Card title="Daily facts (UTC)" description="Each row is one UTC calendar day, newest first. A day with no recorded facts is not listed, and is not zero.">
      <form method="get" action="/analytics" className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        {session === null ? null : <input type="hidden" name="session" value={session} />}
        <label className="flex flex-col gap-1">
          From (UTC day)
          <input name="from" defaultValue={trends.from ?? ""} placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" className="rounded border border-neutral-400 bg-transparent px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          To (UTC day)
          <input name="to" defaultValue={trends.to ?? ""} placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" className="rounded border border-neutral-400 bg-transparent px-2 py-1" />
        </label>
        <button type="submit" className="rounded border border-neutral-500 px-3 py-1">Apply</button>
      </form>
      {trends.items.length === 0 ? (
        <p className="text-sm">{rangeActive ? "No day with recorded facts falls in this range." : "No day with recorded facts."}</p>
      ) : (
        <TableWrap caption="Facts by UTC day">
          <thead>
            <tr>
              <Th>Day (UTC)</Th>
              <Th num>User events</Th>
              <Th num>Main</Th>
              <Th num>Sidechain</Th>
              <Th num>Sidechain unknown</Th>
              {TEXT_LENGTH_STATES.map((s) => <Th key={s} num>Size: {s}</Th>)}
              <Th num>Tool occurrences</Th>
              <Th num>Tool kept</Th>
              <Th num>Tool duplicates</Th>
            </tr>
          </thead>
          <tbody>
            {trends.items.map((day: DayFacts) => (
              <tr key={day.day}>
                <Td><span className="whitespace-nowrap">{day.day}</span></Td>
                <SliceCells slice={day} />
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <OffsetPager path="/analytics" base={base} param="offset" label="Days pagination" limit={trends.limit} offset={trends.offset} total={trends.total} />
      {trends.undated === null ? null : (
        <div className="mt-4">
          <TableWrap caption="Facts with no usable timestamp (not part of any day, and not filtered by the range)">
            <thead>
              <tr>
                <Th>Slice</Th>
                <Th num>User events</Th>
                <Th num>Main</Th>
                <Th num>Sidechain</Th>
                <Th num>Sidechain unknown</Th>
                {TEXT_LENGTH_STATES.map((s) => <Th key={s} num>Size: {s}</Th>)}
                <Th num>Tool occurrences</Th>
                <Th num>Tool kept</Th>
                <Th num>Tool duplicates</Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>No usable timestamp (undated)</Td>
                <SliceCells slice={trends.undated} />
              </tr>
            </tbody>
          </TableWrap>
        </div>
      )}
      <div className="mt-3 space-y-1">
        <Note>Showing {fmt(trends.items.length)} of {fmt(trends.total)} days. Days are UTC, matching the daily usage view.</Note>
        <UnverifiedHint />
      </div>
    </Card>
  );
}
