import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type {
  AnalyticsSessionDetail,
  AnalyticsSessions,
  AnalyticsSummary,
  AnalyticsTools,
  AnalyticsTrends,
  ApiEnvelope,
  FactsCoverage,
} from "@/core/analysis";
import { CoverageChart, SizeStatesChart } from "./analytics-charts";
import { SessionDetailCard, SessionsCard } from "./analytics-sessions";
import { SizeStateTable, UnverifiedWarning } from "./analytics-shared";
import { ToolsCard, TrendsCard } from "./analytics-tables";
import { fmt } from "./format";
import { Gate, Note, StateNotice } from "./notice";
import { Stat, StatGrid } from "./widgets";

export interface AnalyticsViewProps {
  readonly summary: ApiEnvelope<AnalyticsSummary>;
  readonly tools: ApiEnvelope<AnalyticsTools>;
  readonly trends: ApiEnvelope<AnalyticsTrends>;
  readonly sessions: ApiEnvelope<AnalyticsSessions>;
  /** null when no session is selected. */
  readonly detail: ApiEnvelope<AnalyticsSessionDetail> | null;
  readonly selectedSession: string | null;
  /** Every current query parameter, as strings, so each link keeps the others. */
  readonly base: Readonly<Record<string, string | null | undefined>>;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** Only a fixed-looking code word may reach the page; anything else is replaced, never echoed. */
function safeEnvelope<T>(envelope: ApiEnvelope<T>): ApiEnvelope<T> {
  const code = envelope.errorCode;
  return code === null || SAFE_CODE.test(code) ? envelope : { ...envelope, errorCode: "UNKNOWN" };
}

type CoverageKind = "no-sources" | "none-collected" | "partial" | "complete";

function coverageKind(summary: AnalyticsSummary): CoverageKind {
  const c = summary.coverage;
  if (c.sources === 0) return "no-sources";
  if (summary.state === "none-collected") return "none-collected";
  return c.complete === true ? "complete" : "partial";
}

const KIND: Readonly<Record<CoverageKind, { tone: BadgeTone; label: string; text: (c: FactsCoverage) => string }>> = {
  "no-sources": {
    tone: "neutral",
    label: "No sources",
    text: () => "This database stores no sources, so there are no facts. Nothing below is shown as zero because nothing has been measured.",
  },
  "none-collected": {
    tone: "warn",
    label: "Facts not collected",
    text: (c) =>
      `${fmt(c.sources)} stored ${c.sources === 1 ? "source has" : "sources have"} no event facts collected yet, so no figures are shown. Facts are collected for a source when it is named in an ingest run after the facts were introduced; this page never runs ingest.`,
  },
  partial: {
    tone: "warn",
    label: "Partial coverage",
    text: (c) =>
      `Facts are collected for ${fmt(c.collected + c.outdated)} of ${fmt(c.sources)} stored sources. Every figure below covers only those sources; the ${fmt(c.notCollected)} not collected ${c.notCollected === 1 ? "is" : "are"} missing, not zero.`,
  },
  complete: {
    tone: "good",
    label: "Complete for stored sources",
    text: () => "Facts are collected for every stored source by the current logic. This does not mean all Claude Code activity is covered: only the sources this database has seen.",
  },
};

function CoverageCard({ summary }: { summary: AnalyticsSummary }) {
  const c = summary.coverage;
  const kind = KIND[coverageKind(summary)];
  return (
    <Card title="Facts coverage" description="Which stored sources have event facts. Read this before any figure below.">
      <p className="text-sm">
        <Badge tone={kind.tone}>{kind.label}</Badge> {kind.text(c)}
      </p>
      <div className="mt-3">
        <StatGrid>
          <Stat label="Stored sources" value={fmt(c.sources)} />
          <Stat label="Collected (current)" value={fmt(c.collected)} hint={`Facts logic version ${c.currentFactsVersion}.`} />
          <Stat label="Collected (older logic)" value={fmt(c.outdated)} hint="Included in the figures." />
          <Stat label="Not collected" value={fmt(c.notCollected)} hint="Excluded from the figures; not zero." />
        </StatGrid>
      </div>
      <div className="mt-3">
        <CoverageChart coverage={c} />
      </div>
      {c.outdated > 0 ? (
        <div className="mt-2">
          <Note>{fmt(c.outdated)} {c.outdated === 1 ? "source was" : "sources were"} collected by an older facts logic; naming them in a later ingest run refreshes them.</Note>
        </div>
      ) : null}
    </Card>
  );
}

function UserEventsCard({ summary }: { summary: AnalyticsSummary }) {
  const events = summary.userEvents;
  if (events === null) return null;
  return (
    <Card title="User events" description="Events whose source type is “user”. This is observed structure: it is not a count of prompts or turns.">
      <div className="mb-3">
        <UnverifiedWarning validation={summary.validation} note={summary.note} />
      </div>
      <StatGrid>
        <Stat label="User events" value={fmt(events.total)} hint="Source-typed events." />
        <Stat label="Main" value={fmt(events.bySidechain.main)} hint="Flagged not sidechain." />
        <Stat label="Sidechain" value={fmt(events.bySidechain.sidechain)} hint="Flagged sidechain." />
        <Stat label="Sidechain unknown" value={fmt(events.bySidechain.unknown)} hint="Not flagged either way." />
      </StatGrid>
      {events.undated > 0 ? (
        <div className="mt-2">
          <Note>{fmt(events.undated)} {events.undated === 1 ? "event has" : "events have"} no usable timestamp and appears in no day.</Note>
        </div>
      ) : null}
      <h3 className="mt-4 text-sm font-semibold">Text size states</h3>
      <div className="mt-2">
        <SizeStatesChart counts={events.sizeStates} />
      </div>
      <div className="mt-3">
        <SizeStateTable counts={events.sizeStates} caption="User events by text size state" />
      </div>
      <div className="mt-2">
        <Note>
          Size is an optional heuristic. “not-read” and “unsupported” mean no size is known: they are separate from “empty”, which is a measured zero length, and are never counted as zero.
        </Note>
      </div>
    </Card>
  );
}

function SchemaUpgradeNote() {
  return (
    <div role="note" className="rounded-lg border border-neutral-400 p-4 text-sm">
      <p className="font-semibold">How to upgrade</p>
      <p className="mt-1">
        Run <code>pnpm ingest run --db &lt;absolute database path&gt; …</code> once, naming a transcript file you choose (see the README), to upgrade this database. This page never runs ingest or migrations.
      </p>
    </div>
  );
}

export function AnalyticsView({ summary, tools, trends, sessions, detail, selectedSession, base }: AnalyticsViewProps) {
  if (summary.state !== "ok" || summary.data === null) return <AnalyticsUnavailable summary={safeEnvelope(summary)} />;
  const s = summary.data;
  return (
    <>
      <CoverageCard summary={s} />
      {s.state === "none-collected" ? null : (
        <>
          <UserEventsCard summary={s} />
          <Gate envelope={safeEnvelope(tools)} section="usage">{(t) => (t.toolCalls === null ? null : <ToolsCard toolCalls={t.toolCalls} />)}</Gate>
          <Gate envelope={safeEnvelope(trends)} section="usage">{(t) => <TrendsCard trends={t} base={base} session={selectedSession} />}</Gate>
          <Gate envelope={safeEnvelope(sessions)} section="usage">{(p) => <SessionsCard sessions={p} base={base} />}</Gate>
          {selectedSession === null || detail === null ? null : <SessionDetailCard detail={safeEnvelope(detail)} base={base} selected={selectedSession} />}
        </>
      )}
    </>
  );
}

/** Shown instead of the sections when the summary itself is unavailable; adds the upgrade steps for an old schema. */
export function AnalyticsUnavailable({ summary }: { summary: ApiEnvelope<AnalyticsSummary> }) {
  return (
    <>
      <StateNotice envelope={summary} section="usage" />
      {summary.errorCode === "SCHEMA_OUTDATED" ? <SchemaUpgradeNote /> : null}
    </>
  );
}
