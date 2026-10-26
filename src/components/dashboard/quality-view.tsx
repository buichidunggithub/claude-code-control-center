import { Card } from "@/components/ui/card";
import type { ApiEnvelope, ConfigSummary, StatusReport, UsageQuality } from "@/core/analysis";
import { TOKEN_LABELS, TOKEN_ORDER, fmt } from "./format";
import { Gate, Note } from "./notice";
import { ScanLine } from "./overview-view";
import { Stat, StatGrid, TableWrap, Td, Th } from "./widgets";

const STATE_HELP = {
  accepted: "Counted in settled totals",
  duplicate: "Identical repeat; excluded",
  conflicting: "Same identity, different counters; reported as a range",
  ambiguous: "No reliable identity; reported under two interpretations",
} as const;

const Codes = ({ codes }: { codes: Readonly<Record<string, number>> }) =>
  Object.keys(codes).length === 0 ? <>none</> : <>{Object.entries(codes).map(([k, n]) => `${k}: ${fmt(n)}`).join(", ")}</>;

export interface QualityViewProps {
  readonly status: ApiEnvelope<StatusReport>;
  readonly quality: ApiEnvelope<UsageQuality>;
  readonly config: ApiEnvelope<ConfigSummary>;
}

export function QualityView({ status, quality, config }: QualityViewProps) {
  return (
    <>
      <Card title="Scan status and errors" description="Only fixed error codes are shown; messages are never recorded.">
        <Gate envelope={status} section="database">
          {(s) => (
            <StatGrid>
              <ScanLine label="Usage scan" scan={s.usage.latestScan} />
              <ScanLine label="Configuration scan" scan={s.config.latestScan} />
              <Stat label="Usage sources failed" value={s.usage.latestScan ? fmt(s.usage.latestScan.sourcesFailed) : "—"} />
              <Stat label="Config roots unavailable" value={s.config.latestScan ? fmt(s.config.latestScan.rootsUnavailable) : "—"} />
            </StatGrid>
          )}
        </Gate>
      </Card>

      <Gate envelope={quality} section="usage" usageScanStatus={status.data?.usage.latestScan?.status}>
        {(q) => (
          <>
            <Card title="Accounting states" description="Every stored usage record is in exactly one state. Only accepted records are settled.">
              <TableWrap caption="Usage records by accounting state">
                <thead>
                  <tr>
                    <Th>State</Th>
                    <Th num>Records</Th>
                    <Th>Meaning</Th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(STATE_HELP) as (keyof typeof STATE_HELP)[]).map((k) => (
                    <tr key={k}>
                      <Td>{k}</Td>
                      <Td num>{fmt(q.stateCounts[k])}</Td>
                      <Td>{STATE_HELP[k]}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>

            <Card title="Token counters: missing, null, invalid" description="Counted here per counter, over all stored records. In token totals a missing, null or invalid counter contributes nothing to that counter's total (the record itself is still counted); in a conflicting range a missing, null or invalid counter counts as 0 in the bounds.">
              <TableWrap caption="Counter states across all usage records">
                <thead>
                  <tr>
                    <Th>Counter</Th>
                    <Th num>Value</Th>
                    <Th num>Missing</Th>
                    <Th num>Null</Th>
                    <Th num>Invalid</Th>
                  </tr>
                </thead>
                <tbody>
                  {TOKEN_ORDER.map((f) => (
                    <tr key={f}>
                      <Td>{TOKEN_LABELS[f]}</Td>
                      <Td num>{fmt(q.tokenFieldStates[f].value)}</Td>
                      <Td num>{fmt(q.tokenFieldStates[f].missing)}</Td>
                      <Td num>{fmt(q.tokenFieldStates[f].null)}</Td>
                      <Td num>{fmt(q.tokenFieldStates[f].invalid)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>

            <Card title="Latest usage scan diagnostics">
              {q.latestScan === null ? (
                <p className="text-sm">No scan diagnostics recorded.</p>
              ) : (
                <>
                  <StatGrid>
                    <Stat label="Sources" value={fmt(q.latestScan.sources)} />
                    <Stat label="Malformed lines" value={fmt(q.latestScan.skippedLines.malformed)} />
                    <Stat label="Non-object lines" value={fmt(q.latestScan.skippedLines.nonObject)} hint="Valid JSON that is not an object (an array or a string, for example); skipped." />
                    <Stat label="Blank lines" value={fmt(q.latestScan.skippedLines.blank)} hint="Empty or whitespace-only lines; skipped." />
                    <Stat label="Oversized lines" value={fmt(q.latestScan.skippedLines.oversized)} />
                    <Stat label="Malformed usage objects" value={fmt(q.latestScan.skippedLines.usageObjectsMalformed)} />
                    <Stat label="Events without usage" value={fmt(q.latestScan.eventsWithoutUsage)} />
                    <Stat label="Unusable timestamps" value={fmt(q.latestScan.unusableTimestamps)} />
                    <Stat label="Unrecognized usage key occurrences" value={fmt(q.latestScan.unrecognizedUsageKeys)} hint="Occurrences across all usage objects, not the number of distinct key names." />
                    <Stat
                      label="Identity-uncertain sources"
                      value={fmt(q.identityUncertainSources)}
                      hint={`A rewrite flagged the source and anonymous records are still stored. Flagged in the latest scan run: ${fmt(q.latestScan.anonymousIdentityUncertainSources)}.`}
                    />
                  </StatGrid>
                  <div className="mt-2 space-y-1">
                    <Note>
                      These diagnostics describe the latest scan only. Skipped-line and parsing issues from earlier scans of sources the latest scan did not include may not appear here, although those sources&apos; records stay stored.
                    </Note>
                    <Note>
                      A source is identity-uncertain when a successful rewrite flagged it and anonymous records are still stored for it. An unchanged re-read, an append, a failed source or a failed scan neither creates nor clears it; it clears only when no anonymous record remains.
                    </Note>
                    <Note>Source outcomes: <Codes codes={q.latestScan.outcomes} />.</Note>
                    <Note>Source error codes: <Codes codes={q.latestScan.errorCodes} />.</Note>
                  </div>
                </>
              )}
            </Card>
          </>
        )}
      </Gate>

      <Card title="Configuration scan quality">
        <Gate envelope={config} section="config">
          {(c) => (
            <div className="space-y-1">
              <Note>Skipped files by code: <Codes codes={c.skippedByCode} />.</Note>
              <Note>Import edges by status: <Codes codes={c.importsByStatus} />.</Note>
              <Note>{c.note}</Note>
            </div>
          )}
        </Gate>
      </Card>
    </>
  );
}
