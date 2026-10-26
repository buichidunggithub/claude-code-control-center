import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { ApiEnvelope, ConfigSummary, StatusReport, UsageSummary } from "@/core/analysis";
import { COUNTER_COMPLETENESS, TOKEN_DISCLAIMER, TOKEN_LABELS, TOKEN_ORDER, fmt } from "./format";
import { Gate, Note, StateNotice } from "./notice";
import { Stat, StatGrid, TableWrap, Td, Th } from "./widgets";

const SCAN_TONE: Readonly<Record<string, BadgeTone>> = { complete: "good", partial: "warn", failed: "bad", running: "neutral" };

export function ScanLine({ label, scan }: { label: string; scan: { status: string; errorCode: string | null; startedAt: string; finishedAt: string | null } | null }) {
  if (!scan) return <Stat label={label} value="No scan recorded" hint="A scan has not run, or has not been recorded." />;
  return (
    <Stat
      label={label}
      value={<Badge tone={SCAN_TONE[scan.status] ?? "neutral"}>{scan.status}</Badge>}
      hint={
        <>
          Started {scan.startedAt}
          {scan.finishedAt ? `, finished ${scan.finishedAt}` : ", not finished"}
          {scan.errorCode ? ` · error code ${scan.errorCode}` : ""}
        </>
      }
    />
  );
}

function Totals({ summary }: { summary: UsageSummary }) {
  const { settled, conflicting, ambiguous } = summary;
  return (
    <div className="space-y-6">
      <Card title="Settled totals" description="Accepted records only: each has a reliable identity and no competing counters.">
        <StatGrid>
          <Stat label="Settled records" value={fmt(settled.records)} />
          {TOKEN_ORDER.map((f) => (
            <Stat key={f} label={`${TOKEN_LABELS[f]} tokens`} value={fmt(settled[f])} />
          ))}
        </StatGrid>
        <div className="mt-2">
          <Note>{TOKEN_DISCLAIMER}</Note>
          <div className="mt-1">
            <Note>{COUNTER_COMPLETENESS}</Note>
          </div>
        </div>
      </Card>
      <Card
        title="Unresolved — not part of settled totals"
        description="These events cannot be turned into one number without an assumption, so they are shown as ranges and alternatives, never added to the settled totals."
      >
        <StatGrid>
          <Stat label="Conflicting groups" value={fmt(conflicting.groups)} hint="Same identity, different counters" />
          <Stat label="Ambiguous records" value={fmt(ambiguous.records)} hint="No reliable identity" />
          <Stat label="Duplicates excluded" value={fmt(summary.duplicates)} hint="Identical repeats of accepted records" />
        </StatGrid>
        <div className="mt-4">
          <TableWrap caption="Unresolved token ranges">
            <thead>
              <tr>
                <Th>Counter</Th>
                <Th num>Conflicting: lower</Th>
                <Th num>Conflicting: upper</Th>
                <Th num>Ambiguous: if repeats</Th>
                <Th num>Ambiguous: if distinct</Th>
              </tr>
            </thead>
            <tbody>
              {TOKEN_ORDER.map((f) => (
                <tr key={f}>
                  <Td>{TOKEN_LABELS[f]}</Td>
                  <Td num>{fmt(conflicting.lower[f])}</Td>
                  <Td num>{fmt(conflicting.upper[f])}</Td>
                  <Td num>{fmt(ambiguous.ifRepeats[f])}</Td>
                  <Td num>{fmt(ambiguous.ifDistinct[f])}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </Card>
    </div>
  );
}

export function OverviewView({ status, summary, config }: { status: ApiEnvelope<StatusReport>; summary: ApiEnvelope<UsageSummary>; config: ApiEnvelope<ConfigSummary> }) {
  if (status.state !== "ok" || status.data === null) return <StateNotice envelope={status} section="database" />;
  const s = status.data;
  return (
    <>
      <Card title="Latest scans" description="What was last recorded. Nothing here implies a scan is running or has run since.">
        <StatGrid>
          <ScanLine label="Usage scan" scan={s.usage.latestScan} />
          <ScanLine label="Configuration scan" scan={s.config.latestScan} />
          <Stat label="Completed usage scans" value={fmt(s.usage.completedScans)} />
          <Stat label="Database schema" value={`v${s.schemaVersion}`} />
        </StatGrid>
      </Card>
      <Gate envelope={summary} section="usage" usageScanStatus={s.usage.latestScan?.status}>
        {(data) => <Totals summary={data} />}
      </Gate>
      <Card title="Configuration at a glance">
        <Gate envelope={config} section="config">
          {(data) => (
            <>
              <StatGrid>
                <Stat label="Files inventoried" value={fmt(data.rows.reduce((n, r) => n + r.files, 0))} hint="Present on disk, not shown to be loaded" />
                <Stat label="Skipped" value={fmt(data.rows.reduce((n, r) => n + r.skipped, 0))} />
                <Stat label="Findings" value={fmt(data.scan?.findingsCount ?? 0)} />
              </StatGrid>
              <div className="mt-2">
                <Note>{data.note}</Note>
              </div>
            </>
          )}
        </Gate>
      </Card>
    </>
  );
}
