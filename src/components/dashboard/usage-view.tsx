import Link from "next/link";
import { Card } from "@/components/ui/card";
import { UNRECOGNIZED_MODEL_LABEL } from "@/core/recommend";
import { PAGE_LIMIT_DEFAULT, type ApiEnvelope, type DayBreakdown, type ModelBreakdown, type SessionBreakdown, type SidechainMode } from "@/core/analysis";
import { TOKEN_DISCLAIMER, fmt } from "./format";
import { Gate, Note } from "./notice";
import { TokensByDay, TokensByModel } from "./usage-charts";
import { Pager, TableWrap, Td, Th, TokenRows, hrefWith } from "./widgets";

export interface UsageViewProps {
  readonly sidechain: SidechainMode;
  readonly from: string | null;
  readonly to: string | null;
  readonly models: ApiEnvelope<ModelBreakdown>;
  readonly days: ApiEnvelope<DayBreakdown>;
  readonly sessions: ApiEnvelope<SessionBreakdown>;
  /** Status of the latest usage scan, used only to explain a hidden partial or failed scan (shown once, on the first card). */
  readonly usageScanStatus?: string | null;
}

function PageNote({ shown, total, unit, order }: { shown: number; total: number; unit: string; order: string }) {
  return (
    <div className="mt-2">
      <Note>
        {shown < total ? `Showing the first page: ${fmt(shown)} of ${fmt(total)} ${unit}, ` : `Showing all ${fmt(total)} ${unit}, `}
        {order}.
      </Note>
    </div>
  );
}

const NO_MODEL = "(no model recorded)";
const NO_SESSION = "(no session id)";

export function UsageView({ sidechain, from, to, models, days, sessions, usageScanStatus }: UsageViewProps) {
  const base = { sidechain: sidechain === "include" ? null : sidechain, from, to };
  return (
    <>
      <Card title="Scope" description="Sidechain events are sub-agent turns. Records whose sidechain flag is unknown are kept in both modes.">
        <p className="text-sm">
          Showing: <strong>{sidechain === "include" ? "all settled records, sidechain included" : "sidechain records excluded"}</strong>.{" "}
          <Link className="underline" href={hrefWith("/usage", base, { sidechain: sidechain === "include" ? "exclude" : null })}>
            {sidechain === "include" ? "Exclude sidechain" : "Include sidechain"}
          </Link>
        </p>
        <form method="get" action="/usage" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          {sidechain === "exclude" ? <input type="hidden" name="sidechain" value="exclude" /> : null}
          <label className="flex flex-col gap-1">
            From (UTC day)
            <input name="from" defaultValue={from ?? ""} placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" className="rounded border border-neutral-400 bg-transparent px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            To (UTC day)
            <input name="to" defaultValue={to ?? ""} placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" className="rounded border border-neutral-400 bg-transparent px-2 py-1" />
          </label>
          <button type="submit" className="rounded border border-neutral-500 px-3 py-1">Apply</button>
        </form>
        <div className="mt-2">
          <Note>The From/To range filters the day table only. The model and session tables cover all dates.</Note>
        </div>
        <div className="mt-2">
          <Note>{TOKEN_DISCLAIMER} Only settled (accepted) records are listed; unresolved events appear under Overview and Data quality.</Note>
        </div>
      </Card>

      <Card title="By model" description="Covers all dates; the From/To range does not apply here.">
        <Gate envelope={models} section="usage" usageScanStatus={usageScanStatus}>
          {(d) =>
            d.items.length === 0 ? (
              <p className="text-sm">No settled records.</p>
            ) : (
              <>
                <TokensByModel items={d.items} />
                <div className="mt-3" />
                <TokenRows caption="Settled tokens by model" keyLabel="Model" rows={d.items.map((i) => ({ ...i, key: i.key ?? NO_MODEL }))} />
                <PageNote shown={d.items.length} total={d.total} unit="models" order="alphabetical by model name" />
                {d.items.some((i) => i.key === UNRECOGNIZED_MODEL_LABEL) ? (
                  <div className="mt-2">
                    <Note>
                      “{UNRECOGNIZED_MODEL_LABEL}” groups records whose model identifier did not match the recognized-name policy. Legitimate identifiers (for example from a provider this tool does not list) can be grouped here; it does not mean the model is invalid.
                    </Note>
                  </div>
                ) : null}
              </>
            )
          }
        </Gate>
      </Card>

      <Card title="By day (UTC)" description="The only table filtered by the From/To range above.">
        <Gate envelope={days} section="usage">
          {(d) => (
            <>
              {d.items.length === 0 ? null : <TokensByDay items={d.items} />}
              {d.items.length === 0 ? null : <div className="mt-3" />}
              {d.items.length === 0 ? <p className="text-sm">No settled records in this range.</p> : <TokenRows caption="Settled tokens by UTC day" keyLabel="Day (UTC)" rows={d.items.map((i) => ({ ...i, key: i.key ?? "" }))} />}
              <Pager path="/usage" base={{ ...base, limit: d.limit === PAGE_LIMIT_DEFAULT ? null : String(d.limit) }} limit={d.limit} offset={d.offset} total={d.total} />
              {d.items.length === 0 ? null : (
                <div className="mt-2">
                  <Note>Newest day first, {fmt(d.limit)} days per page.</Note>
                </div>
              )}
              {d.undated ? (
                <div className="mt-2">
                  <Note>
                    {fmt(d.undated.records)} settled record(s) have no usable timestamp and are not assigned to any day (not filtered by the range).
                  </Note>
                </div>
              ) : null}
            </>
          )}
        </Gate>
      </Card>

      <Card title="Sessions" description="Covers all dates; the From/To range does not apply here. Session ids are opaque salted fingerprints, not Claude session ids.">
        <Gate envelope={sessions} section="usage">
          {(d) =>
            d.items.length === 0 ? (
              <p className="text-sm">No settled records.</p>
            ) : (
              <>
                <TableWrap caption="Settled tokens by session">
                  <thead>
                    <tr>
                      <Th>Session (opaque)</Th>
                      <Th num>Records</Th>
                      <Th num>Tokens (sum of four counters)</Th>
                      <Th>First</Th>
                      <Th>Last</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((s, i) => (
                      <tr key={s.id ?? `none-${i}`}>
                        <Td>{s.id ?? NO_SESSION}</Td>
                        <Td num>{fmt(s.records)}</Td>
                        <Td num>{fmt(Object.values(s.tokens).reduce((a, b) => a + b, 0))}</Td>
                        <Td>{s.firstTimestamp ?? "—"}</Td>
                        <Td>{s.lastTimestamp ?? "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                <PageNote shown={d.items.length} total={d.total} unit="sessions" order="ordered by opaque id, not by usage; this is not a top-N and larger sessions may be on pages not shown here" />
              </>
            )
          }
        </Gate>
      </Card>
    </>
  );
}
