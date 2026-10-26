import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { ApiEnvelope, ConfigSummary, FindingItem, FindingsPage } from "@/core/analysis";
import { ESTIMATE_DISCLAIMER, fmt } from "./format";
import { Gate, Note } from "./notice";
import { Pager, TableWrap, Td, Th } from "./widgets";

const SEVERITY_ORDER = ["high", "medium", "low", "info"] as const;
const SEVERITY_TONE: Readonly<Record<string, BadgeTone>> = { high: "bad", medium: "warn", low: "neutral", info: "neutral" };

export interface ConfigViewProps {
  readonly summary: ApiEnvelope<ConfigSummary>;
  readonly findings: ApiEnvelope<FindingsPage>;
}

function groupFindings(items: readonly FindingItem[]) {
  return SEVERITY_ORDER.map((severity) => {
    const inSeverity = items.filter((f) => f.severity === severity);
    const ruleIds = [...new Set(inSeverity.map((f) => f.ruleId))].sort();
    return { severity, rules: ruleIds.map((ruleId) => ({ ruleId, items: inSeverity.filter((f) => f.ruleId === ruleId) })) };
  }).filter((g) => g.rules.length > 0);
}

function Finding({ f }: { f: FindingItem }) {
  const evidence = Object.entries(f.evidence);
  return (
    <li className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"}>{f.severity}</Badge>
        <Badge>confidence: {f.confidence}</Badge>
        <span className="text-xs text-neutral-600 dark:text-neutral-400">
          finding {f.id} · item {f.sourceId ?? "—"}
          {f.relatedSourceId ? ` · related ${f.relatedSourceId}` : ""}
        </span>
      </div>
      <p className="mt-2">
        <strong>Evidence:</strong>{" "}
        {f.evidenceRedacted ? "withheld (failed the safety check)" : evidence.length === 0 ? "none" : evidence.map(([k, v]) => `${k}=${String(v)}`).join(", ")}
      </p>
      <p className="mt-1">
        <strong>Limitations:</strong> {f.limitations}
      </p>
      <p className="mt-1">
        <strong>For human review:</strong> {f.recommendation}
      </p>
    </li>
  );
}

function FilterForm({ page }: { page: FindingsPage }) {
  return (
    <form method="get" action="/config" className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Severity
        <select name="severity" defaultValue={page.filter.severity ?? ""} className="rounded border border-neutral-400 bg-transparent px-2 py-1">
          <option value="">All ({fmt(Object.values(page.bySeverity).reduce((a, b) => a + b, 0))})</option>
          {SEVERITY_ORDER.filter((s) => page.bySeverity[s]).map((s) => (
            <option key={s} value={s}>{s} ({fmt(page.bySeverity[s] ?? 0)})</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Rule
        <select name="ruleId" defaultValue={page.filter.ruleId ?? ""} className="rounded border border-neutral-400 bg-transparent px-2 py-1">
          <option value="">All rules</option>
          {Object.entries(page.byRule).map(([id, n]) => (
            <option key={id} value={id}>{id} ({fmt(n)})</option>
          ))}
        </select>
      </label>
      <button type="submit" className="rounded border border-neutral-500 px-3 py-1">Filter</button>
    </form>
  );
}

export function ConfigView({ summary, findings }: ConfigViewProps) {
  return (
    <>
      <Card title="Inventory" description="Files found in the roots you explicitly scanned. Found is not loaded: activation is not verified by a static scan.">
        <Gate envelope={summary} section="config">
          {(d) => (
            <>
              <TableWrap caption="Configuration inventory by scope and category">
                <thead>
                  <tr>
                    <Th>Scope</Th>
                    <Th>Category</Th>
                    <Th num>Files</Th>
                    <Th num>Skipped</Th>
                    <Th num>Estimated tokens on disk</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={`${r.scope}:${r.category}`}>
                      <Td>{r.scope}</Td>
                      <Td>{r.category}</Td>
                      <Td num>{fmt(r.files)}</Td>
                      <Td num>{fmt(r.skipped)}</Td>
                      <Td num>{fmt(r.estimatedTokensOnDisk)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              <div className="mt-2 space-y-1">
                <Note>{d.note}</Note>
                <Note>{ESTIMATE_DISCLAIMER}</Note>
                <Note>
                  Activation status of inventoried files:{" "}
                  {Object.entries(d.activation).map(([k, n]) => `${k}: ${fmt(n)}`).join(", ") || "none"}. “Unverified candidate” means present, not known to be loaded.
                </Note>
              </div>
            </>
          )}
        </Gate>
      </Card>

      <Card title="Audit findings" description="Deterministic static checks. Each states its evidence, confidence and limitations; none claims a saving.">
        <Gate envelope={findings} section="config">
          {(page) => {
            const groups = groupFindings(page.items);
            return (
              <div className="space-y-5">
                <FilterForm page={page} />
                <Note>{page.note}</Note>
                {groups.length === 0 ? <p className="text-sm">No findings match this filter.</p> : null}
                {groups.map((g) => (
                  <section key={g.severity} aria-labelledby={`sev-${g.severity}`}>
                    <h3 id={`sev-${g.severity}`} className="text-sm font-semibold uppercase tracking-wide">
                      {g.severity} severity
                    </h3>
                    {g.rules.map((rule) => {
                      const first = rule.items[0];
                      return (
                        <div key={rule.ruleId} className="mt-3">
                          <h4 className="text-sm font-medium">
                            {rule.ruleId} · {first?.ruleTitle ?? "Unknown rule"}{" "}
                            <span className="text-xs text-neutral-600 dark:text-neutral-400">
                              (rule v{first?.ruleVersion ?? "?"}, {fmt(rule.items.length)} shown)
                            </span>
                          </h4>
                          <ul className="mt-2 space-y-2">
                            {rule.items.map((f, i) => (
                              <Finding key={`${f.ruleId}-${f.sourceId ?? "x"}-${f.relatedSourceId ?? "x"}-${i}`} f={f} />
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </section>
                ))}
                <Pager path="/config" base={{ severity: page.filter.severity, ruleId: page.filter.ruleId }} limit={page.limit} offset={page.offset} total={page.total} />
              </div>
            );
          }}
        </Gate>
      </Card>
    </>
  );
}
