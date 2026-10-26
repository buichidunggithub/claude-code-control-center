import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { ApiEnvelope, RunCounts, RunDetailReport, RunHistoryPage, RunItem, RunKind } from "@/core/analysis";
import { fmt } from "./format";
import { Gate, Note } from "./notice";
import { Pager, Stat, StatGrid, TableWrap, Td, Th, hrefWith } from "./widgets";

const KIND_LABEL: Readonly<Record<RunKind, string>> = {
  complete: "Completed",
  partial: "Partial",
  failed: "Failed (all sources)",
  "rolled-back": "Failed (rolled back)",
  unfinished: "Unfinished",
};

const KIND_HELP: Readonly<Record<RunKind, string>> = {
  complete: "Every source was read and committed.",
  partial: "Some sources failed. Records from the sources that could be read were committed.",
  failed: "Every source failed to read. The run was recorded; it stored no records.",
  "rolled-back": "The scan failed as a whole and its writes were rolled back, so no records came from it. Per-outcome counts were never recorded.",
  unfinished: "The run never reached a final status. Counts were never recorded.",
};

const SOURCE_COLUMNS = ["new", "unchanged", "appended", "modified", "failed"] as const;

/** A metric the run never stored. Shown as text so it cannot be read as a zero. */
export const NotRecorded = () => <span className="text-neutral-600 dark:text-neutral-400">not recorded</span>;

const sourceCount = (counts: RunCounts | null, key: (typeof SOURCE_COLUMNS)[number]) => (counts === null ? <NotRecorded /> : fmt(counts.sources[key]));
const time = (value: string | null) => value ?? <NotRecorded />;

export interface HistoryViewProps {
  readonly runs: ApiEnvelope<RunHistoryPage>;
  readonly detail: ApiEnvelope<RunDetailReport> | null;
  readonly selectedId: number | null;
}

function RunRow({ run, offset, selected }: { run: RunItem; offset: number; selected: boolean }) {
  const href = hrefWith("/history", { offset: offset === 0 ? null : String(offset) }, { run: String(run.id) });
  return (
    <tr aria-selected={selected} className={selected ? "bg-neutral-100 dark:bg-neutral-900" : undefined}>
      <Td><Link className="underline" href={href} aria-current={selected ? "true" : undefined}>#{run.id}</Link></Td>
      <Td>{KIND_LABEL[run.kind]}{run.errorCode ? ` (${run.errorCode})` : ""}</Td>
      <Td>{time(run.startedAt)}</Td>
      <Td>{time(run.finishedAt)}</Td>
      <Td num>{fmt(run.sourcesRequested)}</Td>
      {SOURCE_COLUMNS.map((k) => <Td key={k} num>{sourceCount(run.counts, k)}</Td>)}
      <Td num>{run.counts === null ? <NotRecorded /> : fmt(run.counts.recordsInserted)}</Td>
      <Td num>{run.counts === null ? <NotRecorded /> : fmt(run.counts.recordsRemoved)}</Td>
    </tr>
  );
}

function RunDetail({ detail }: { detail: RunDetailReport }) {
  const run = detail.run;
  if (run === null) return <p className="text-sm">No run with that number is stored.</p>;
  const codes = Object.entries(detail.sourceErrorCodes);
  return (
    <div className="space-y-3">
      <StatGrid>
        <Stat label="Status" value={KIND_LABEL[run.kind]} hint={KIND_HELP[run.kind]} />
        <Stat label="Run-level error code" value={run.errorCode ?? "none"} />
        <Stat label="Sources requested" value={fmt(run.sourcesRequested)} />
        <Stat label="Identity-uncertain sources" value={fmt(detail.anonymousIdentityUncertainSources)} />
      </StatGrid>
      <Note>Source error codes: {codes.length === 0 ? "none" : codes.map(([k, n]) => `${k}: ${fmt(n)}`).join(", ")}.</Note>
      {detail.sources.length === 0 ? (
        <Note>No per-source results are stored for this run.</Note>
      ) : (
        <TableWrap caption="Source results of the selected run">
          <thead>
            <tr>
              <Th num>Source</Th>
              <Th>Outcome</Th>
              <Th>Error code</Th>
              <Th num>Inserted</Th>
              <Th num>Removed</Th>
              <Th num>Retained</Th>
              <Th num>Malformed lines</Th>
              <Th num>Blank lines</Th>
              <Th num>Oversized lines</Th>
              <Th num>Non-object lines</Th>
              <Th num>Malformed usage objects</Th>
              <Th num>Events without usage</Th>
              <Th num>Unusable timestamps</Th>
            </tr>
          </thead>
          <tbody>
            {detail.sources.map((s) => (
              <tr key={s.ordinal}>
                <Td num>{s.ordinal}</Td>
                <Td>{s.outcome}</Td>
                <Td>{s.errorCode ?? "none"}</Td>
                <Td num>{fmt(s.recordsInserted)}</Td>
                <Td num>{fmt(s.recordsRemoved)}</Td>
                <Td num>{fmt(s.recordsRetained)}</Td>
                <Td num>{fmt(s.skippedLines.malformed)}</Td>
                <Td num>{fmt(s.skippedLines.blank)}</Td>
                <Td num>{fmt(s.skippedLines.oversized)}</Td>
                <Td num>{fmt(s.skippedLines.nonObject)}</Td>
                <Td num>{fmt(s.skippedLines.usageObjectsMalformed)}</Td>
                <Td num>{fmt(s.eventsWithoutUsage)}</Td>
                <Td num>{fmt(s.unusableTimestamps)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <Note>
        Showing {fmt(detail.sources.length)} of {fmt(detail.sourcePage.total)} sources (starting at {fmt(detail.sourcePage.offset + 1)}). Sources are numbered by position in the run; paths and names are never stored in the history.
      </Note>
    </div>
  );
}

export function HistoryView({ runs, detail, selectedId }: HistoryViewProps) {
  return (
    <>
      <Card title="Scan runs" description="Newest first. Not recorded means the run never stored that figure; it is not zero.">
        <Gate envelope={runs} section="database">
          {(page) =>
            page.total === 0 ? (
              <p className="text-sm">No scan has been recorded in this database yet.</p>
            ) : (
              <>
                <TableWrap caption="Recorded scan runs">
                  <thead>
                    <tr>
                      <Th>Run</Th>
                      <Th>Status</Th>
                      <Th>Started (UTC)</Th>
                      <Th>Finished (UTC)</Th>
                      <Th num>Sources requested</Th>
                      <Th num>New</Th>
                      <Th num>Unchanged</Th>
                      <Th num>Appended</Th>
                      <Th num>Modified</Th>
                      <Th num>Failed</Th>
                      <Th num>Records inserted</Th>
                      <Th num>Records removed</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((run) => <RunRow key={run.id} run={run} offset={page.offset} selected={run.id === selectedId} />)}
                  </tbody>
                </TableWrap>
                <Pager path="/history" base={{}} limit={page.limit} offset={page.offset} total={page.total} />
                <div className="mt-2"><Note>{page.note}</Note></div>
              </>
            )
          }
        </Gate>
      </Card>
      {selectedId === null ? null : (
        <Card title={`Run #${selectedId}`} description="Diagnostics and fixed error codes of the selected run.">
          {detail === null ? null : <Gate envelope={detail} section="database">{(d) => <RunDetail detail={d} />}</Gate>}
        </Card>
      )}
    </>
  );
}
