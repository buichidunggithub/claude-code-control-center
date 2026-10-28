import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { AnalyticsSessionDetail, AnalyticsSessions, ApiEnvelope, SessionFactsItem } from "@/core/analysis";
import { OffsetPager, SizeStateTable, UnverifiedHint, shortRef } from "./analytics-shared";
import { fmt } from "./format";
import { Gate, Note } from "./notice";
import { Stat, StatGrid, TableWrap, Td, Th, hrefWith } from "./widgets";

const NO_SESSION = "(no session id recorded)";
const REF_NOTE =
  "A session reference is an opaque, shortened value derived with a local secret. It is not a Claude session id, and it does not identify a user, device or project.";

const noTime = <span>not recorded</span>;

function SessionRow({ item, base }: { item: SessionFactsItem; base: Readonly<Record<string, string | null | undefined>> }) {
  return (
    <tr>
      <Td>
        {item.id === null ? (
          NO_SESSION
        ) : (
          <Link className="font-mono underline" href={hrefWith("/analytics", base, { session: item.id, doffset: null })}>
            {shortRef(item.id)}
          </Link>
        )}
      </Td>
      <Td num>{fmt(item.userEvents)}</Td>
      <Td num>{fmt(item.toolOccurrences)}</Td>
      <Td num>{fmt(item.toolKept)}</Td>
      <Td>{item.firstTimestamp ?? noTime}</Td>
      <Td>{item.lastTimestamp ?? noTime}</Td>
    </tr>
  );
}

export interface SessionsCardProps {
  readonly sessions: AnalyticsSessions;
  readonly base: Readonly<Record<string, string | null | undefined>>;
}

export function SessionsCard({ sessions, base }: SessionsCardProps) {
  return (
    <Card title="Sessions" description="Sessions that have recorded facts, most recent activity first. Select a reference for its detail.">
      {sessions.items.length === 0 ? (
        <p className="text-sm">No session has recorded facts.</p>
      ) : (
        <TableWrap caption="Sessions with recorded facts">
          <thead>
            <tr>
              <Th>Session reference</Th>
              <Th num>User events</Th>
              <Th num>Tool occurrences</Th>
              <Th num>Tool kept</Th>
              <Th>First timestamp</Th>
              <Th>Last timestamp</Th>
            </tr>
          </thead>
          <tbody>{sessions.items.map((item) => <SessionRow key={item.id ?? "none"} item={item} base={base} />)}</tbody>
        </TableWrap>
      )}
      <OffsetPager path="/analytics" base={base} param="soffset" label="Sessions pagination" limit={sessions.limit} offset={sessions.offset} total={sessions.total} />
      <div className="mt-3 space-y-1">
        <Note>Showing {fmt(sessions.items.length)} of {fmt(sessions.total)} sessions. {REF_NOTE}</Note>
        <UnverifiedHint />
      </div>
    </Card>
  );
}

function DetailBody({ detail, base, selected }: { detail: AnalyticsSessionDetail; base: Readonly<Record<string, string | null | undefined>>; selected: string }) {
  const s = detail.session;
  if (s === null || detail.sizeStates === null || detail.toolBuckets === null) {
    return (
      <p className="text-sm">
        No session with reference <code>{shortRef(selected)}</code> has recorded facts, or the reference is ambiguous. Nothing is shown for it.
      </p>
    );
  }
  const buckets = detail.toolBuckets.filter((row) => row.occurrences > 0);
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="User events" value={fmt(s.userEvents)} hint="Source-typed user events." />
        <Stat label="Tool occurrences" value={fmt(s.toolOccurrences)} />
        <Stat label="Tool kept" value={fmt(s.toolKept)} />
        <Stat label="Tool duplicates" value={fmt(s.toolOccurrences - s.toolKept)} />
      </StatGrid>
      <SizeStateTable counts={detail.sizeStates} caption="Text size states of the user events in this session" />
      {buckets.length === 0 ? (
        <Note>This session has no recorded tool calls.</Note>
      ) : (
        <TableWrap caption="Tool calls of this session by bucket">
          <thead>
            <tr>
              <Th>Bucket</Th>
              <Th num>Occurrences</Th>
              <Th num>Kept</Th>
              <Th num>Duplicates</Th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((row) => (
              <tr key={row.bucket}>
                <Td><code>{row.bucket}</code></Td>
                <Td num>{fmt(row.occurrences)}</Td>
                <Td num>{fmt(row.kept)}</Td>
                <Td num>{fmt(row.duplicates)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {detail.days.length === 0 ? (
        <Note>No dated facts for this session.</Note>
      ) : (
        <TableWrap caption="Days (UTC) of this session, newest first">
          <thead>
            <tr>
              <Th>Day (UTC)</Th>
              <Th num>User events</Th>
              <Th num>Tool occurrences</Th>
              <Th num>Tool kept</Th>
              <Th num>Tool duplicates</Th>
            </tr>
          </thead>
          <tbody>
            {detail.days.map((d) => (
              <tr key={d.day}>
                <Td><span className="whitespace-nowrap">{d.day}</span></Td>
                <Td num>{fmt(d.userEvents)}</Td>
                <Td num>{fmt(d.toolOccurrences)}</Td>
                <Td num>{fmt(d.toolKept)}</Td>
                <Td num>{fmt(d.toolDuplicates)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <OffsetPager path="/analytics" base={base} param="doffset" label="Session days pagination" limit={detail.daysPage.limit} offset={detail.daysPage.offset} total={detail.daysPage.total} />
      <Note>Showing {fmt(detail.days.length)} of {fmt(detail.daysPage.total)} days. Facts with no usable timestamp are in no day.</Note>
    </div>
  );
}

export interface SessionDetailCardProps {
  readonly detail: ApiEnvelope<AnalyticsSessionDetail>;
  readonly base: Readonly<Record<string, string | null | undefined>>;
  readonly selected: string;
}

export function SessionDetailCard({ detail, base, selected }: SessionDetailCardProps) {
  return (
    <Card title={`Session ${shortRef(selected)}`} description="Recorded facts of the selected session. The reference is opaque and is not a Claude session id.">
      <Gate envelope={detail} section="usage">{(d) => <DetailBody detail={d} base={base} selected={selected} />}</Gate>
      <div className="mt-3"><UnverifiedHint /></div>
    </Card>
  );
}
