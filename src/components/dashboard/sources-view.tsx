import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { ApiEnvelope, RunRef, SourceCoveragePage, SourceDetailReport, SourceItem, SourceOutcomeName, SourceResultItem } from "@/core/analysis";
import { fmt } from "./format";
import { NotRecorded } from "./history-view";
import { Gate, Note } from "./notice";
import { Pager, Stat, StatGrid, TableWrap, Td, Th, hrefWith } from "./widgets";

const OUTCOMES: readonly SourceOutcomeName[] = ["new", "unchanged", "appended", "modified", "failed"];
const REF_SHOWN = 12;

const KIND_LABEL = { complete: "completed", partial: "partial", failed: "all sources failed", "rolled-back": "rolled back", unfinished: "unfinished" } as const;

const shortRef = (ref: string) => ref.slice(0, REF_SHOWN);
const RunCell = ({ run }: { run: RunRef }) => (
  <>
    <Link className="underline" href={hrefWith("/history", {}, { run: String(run.runId) })}>#{run.runId}</Link> {run.startedAt ?? <NotRecorded />}
  </>
);

export interface SourcesViewProps {
  readonly sources: ApiEnvelope<SourceCoveragePage>;
  readonly detail: ApiEnvelope<SourceDetailReport> | null;
  readonly selectedRef: string | null;
}

function InLatest({ value }: { value: boolean | null }) {
  if (value === null) return <>unknown</>;
  return <>{value ? "has a result" : "no result"}</>;
}

function SourceRow({ item, offset, selected }: { item: SourceItem; offset: number; selected: boolean }) {
  const href = hrefWith("/sources", { offset: offset === 0 ? null : String(offset) }, { source: item.ref });
  return (
    <tr aria-selected={selected} className={selected ? "bg-neutral-100 dark:bg-neutral-900" : undefined}>
      <Td><Link className="font-mono underline" href={href} aria-current={selected ? "true" : undefined}>{shortRef(item.ref)}</Link></Td>
      <Td>{item.latestResult === null ? <NotRecorded /> : item.latestResult.outcome}</Td>
      <Td>{item.latestResult === null ? <NotRecorded /> : <RunCell run={item.latestResult} />}</Td>
      <Td num>{fmt(item.resultCount)}</Td>
      {OUTCOMES.map((o) => <Td key={o} num>{fmt(item.outcomes[o])}</Td>)}
      <Td num>{fmt(item.recordsStored)}</Td>
      <Td><RunCell run={item.firstSeen} /></Td>
      <Td><RunCell run={item.lastRead} /></Td>
      <Td><InLatest value={item.inLatestCommittedRun} />{item.historyIncomplete ? "; history incomplete" : ""}</Td>
    </tr>
  );
}

function ResultRow({ item }: { item: SourceResultItem }) {
  const c = item.counts;
  const cell = (n: number | undefined) => (c === null || n === undefined ? <NotRecorded /> : fmt(n));
  return (
    <tr>
      <Td><RunCell run={item.run} /> ({KIND_LABEL[item.run.kind]})</Td>
      <Td>{item.outcome}</Td>
      <Td>{item.errorCode ?? "none"}</Td>
      <Td num>{cell(c?.recordsInserted)}</Td>
      <Td num>{cell(c?.recordsRemoved)}</Td>
      <Td num>{cell(c?.recordsRetained)}</Td>
      <Td num>{cell(c?.skippedLines.malformed)}</Td>
      <Td num>{cell(c?.skippedLines.nonObject)}</Td>
      <Td num>{cell(c?.eventsWithoutUsage)}</Td>
      <Td>{c === null ? <NotRecorded /> : item.anonymousIdentityUncertain ? "flagged" : "no"}</Td>
    </tr>
  );
}

function SourceDetail({ detail }: { detail: SourceDetailReport }) {
  const s = detail.source;
  if (s === null) return <p className="text-sm">No source with that reference is stored.</p>;
  return (
    <div className="space-y-3">
      <StatGrid>
        <Stat label="Results recorded" value={fmt(s.resultCount)} hint="Attributed results only; a lower bound." />
        <Stat label="Records stored now" value={fmt(s.recordsStored)} hint="Current state, not a history figure." />
        <Stat label="Newest committed run" value={<InLatest value={s.inLatestCommittedRun} />} hint="No result is not a deletion." />
        <Stat label="History" value={s.historyIncomplete ? "incomplete" : "no gap found"} hint="Checks only the first-seen and last-read runs." />
      </StatGrid>
      {detail.history.length === 0 ? (
        <Note>No results are recorded for this source.</Note>
      ) : (
        <TableWrap caption="Recorded history of the selected source">
          <thead>
            <tr>
              <Th>Run</Th>
              <Th>Outcome</Th>
              <Th>Error code</Th>
              <Th num>Inserted</Th>
              <Th num>Removed</Th>
              <Th num>Retained</Th>
              <Th num>Malformed lines</Th>
              <Th num>Non-object lines</Th>
              <Th num>Events without usage</Th>
              <Th>Identity uncertain</Th>
            </tr>
          </thead>
          <tbody>{detail.history.map((h, i) => <ResultRow key={`${h.run.runId}-${detail.historyPage.offset + i}`} item={h} />)}</tbody>
        </TableWrap>
      )}
      <Note>
        Showing {fmt(detail.history.length)} of {fmt(detail.historyPage.total)} recorded results, newest first (starting at {fmt(detail.historyPage.offset + 1)}). A failed read has no line or record figures: they are not recorded, not zero.
      </Note>
    </div>
  );
}

export function SourcesView({ sources, detail, selectedRef }: SourcesViewProps) {
  return (
    <>
      <Card title="Observed sources" description="Most recently observed first. Observed history does not show that a source still exists or that coverage is complete.">
        <Gate envelope={sources} section="database">
          {(page) =>
            page.total === 0 ? (
              <p className="text-sm">No source has been recorded in this database yet.</p>
            ) : (
              <>
                <Note>
                  {page.latestCommittedRun === null
                    ? "No committed run exists to compare against."
                    : `Newest committed run: #${page.latestCommittedRun.runId} (${KIND_LABEL[page.latestCommittedRun.kind]}).`}
                </Note>
                <TableWrap caption="Observed sources">
                  <thead>
                    <tr>
                      <Th>Source</Th>
                      <Th>Latest outcome</Th>
                      <Th>Latest result</Th>
                      <Th num>Results</Th>
                      {OUTCOMES.map((o) => <Th key={o} num>{o}</Th>)}
                      <Th num>Records stored</Th>
                      <Th>First seen</Th>
                      <Th>Last read</Th>
                      <Th>Newest committed run</Th>
                    </tr>
                  </thead>
                  <tbody>{page.items.map((item) => <SourceRow key={item.ref} item={item} offset={page.offset} selected={item.ref === selectedRef} />)}</tbody>
                </TableWrap>
                <Pager path="/sources" base={{}} limit={page.limit} offset={page.offset} total={page.total} />
                <div className="mt-2"><Note>{page.note}</Note></div>
              </>
            )
          }
        </Gate>
      </Card>
      {selectedRef === null ? null : (
        <Card title={`Source ${shortRef(selectedRef)}`} description="Recorded history of the selected source, newest first.">
          {detail === null ? null : <Gate envelope={detail} section="database">{(d) => <SourceDetail detail={d} />}</Gate>}
        </Card>
      )}
    </>
  );
}
