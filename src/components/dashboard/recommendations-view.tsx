import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { RECOMMENDATIONS_NOTE, type ApiEnvelope, type RecommendationsPage } from "@/core/analysis";
import { CATEGORIES, PRIORITIES, REASON_TEXT, type Recommendation, type RuleEvaluation } from "@/core/recommend";
import { fmt } from "./format";
import { Gate, Note, incompleteScanNote } from "./notice";
import { Pager, TableWrap, Td, Th } from "./widgets";

const PRIORITY_TONE: Readonly<Record<string, BadgeTone>> = { high: "bad", medium: "warn", low: "neutral", info: "neutral" };
const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  "configuration-hygiene": "Configuration hygiene",
  "context-efficiency": "Context efficiency",
  "usage-insight": "Usage insight",
  "data-quality": "Data quality",
};
const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  generated: "Generated",
  "not-triggered": "Not triggered",
  "insufficient-evidence": "Insufficient evidence",
};

const List = ({ items }: { items: readonly string[] }) => (
  <ul className="mt-1 list-disc space-y-0.5 pl-5">
    {items.map((t, i) => (
      <li key={`${i}-${t.slice(0, 24)}`}>{t}</li>
    ))}
  </ul>
);

function RecommendationCard({ r }: { r: Recommendation }) {
  return (
    <li className="rounded-md border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={PRIORITY_TONE[r.priority] ?? "neutral"}>priority: {r.priority}</Badge>
        <Badge>{CATEGORY_LABEL[r.category] ?? r.category}</Badge>
        <Badge>{r.status === "needs-review" ? "needs review" : "informational"}</Badge>
        <Badge>confidence: {r.confidence.level}</Badge>
        <span className="text-xs text-neutral-600 dark:text-neutral-400">
          {r.id} · rule v{r.ruleVersion}
        </span>
      </div>
      <h3 className="mt-2 text-base font-semibold">{r.title}</h3>
      <p className="mt-1">{r.explanation}</p>

      <h4 className="mt-3 font-medium">What the data shows</h4>
      <List items={r.facts} />
      {r.inferences.length > 0 ? (
        <>
          <h4 className="mt-3 font-medium">What is inferred (not established)</h4>
          <List items={r.inferences} />
        </>
      ) : null}

      <h4 className="mt-3 font-medium">Evidence</h4>
      <p className="mt-1">
        {r.evidence.metrics.map((m) => `${m.name}=${fmt(m.value)}`).join(", ") || "none"}
      </p>
      {r.evidence.findingIds.length > 0 ? <p className="mt-1">Audit findings: {r.evidence.findingIds.join(", ")}</p> : null}

      <p className="mt-3">
        <strong>Confidence ({r.confidence.level}):</strong> {r.confidence.rationale}
      </p>
      <p className="mt-1">
        <strong>Expected impact ({r.impact.level}):</strong> {r.impact.statement}
      </p>
      <h4 className="mt-3 font-medium">Limitations</h4>
      <List items={r.limitations} />
      {r.assumptions.length > 0 ? (
        <>
          <h4 className="mt-3 font-medium">Assumptions</h4>
          <List items={r.assumptions} />
        </>
      ) : null}
      <p className="mt-3">
        <strong>For human review:</strong> {r.nextStep}
      </p>
    </li>
  );
}

function RulesTable({ rules }: { rules: readonly RuleEvaluation[] }) {
  return (
    <TableWrap caption="Recommendation rules evaluated">
      <thead>
        <tr>
          <Th>Rule</Th>
          <Th>Outcome</Th>
          <Th>Why</Th>
          <Th>Evidence required</Th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.ruleId}>
            <Td>
              {r.ruleId} v{r.ruleVersion}
              <br />
              <span className="text-xs text-neutral-600 dark:text-neutral-400">{r.title}</span>
            </Td>
            <Td>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</Td>
            <Td>{REASON_TEXT[r.reason] ?? r.reason}</Td>
            <Td>{r.evidenceRequirement}</Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function FilterForm({ page }: { page: RecommendationsPage }) {
  const total = (counts: Readonly<Record<string, number>>) => Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <form method="get" action="/recommendations" className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Category
        <select name="category" defaultValue={page.filter.category ?? ""} className="rounded border border-neutral-400 bg-transparent px-2 py-1">
          <option value="">All ({fmt(total(page.byCategory))})</option>
          {CATEGORIES.filter((c) => page.byCategory[c]).map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]} ({fmt(page.byCategory[c] ?? 0)})</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Priority
        <select name="priority" defaultValue={page.filter.priority ?? ""} className="rounded border border-neutral-400 bg-transparent px-2 py-1">
          <option value="">All ({fmt(total(page.byPriority))})</option>
          {PRIORITIES.filter((p) => page.byPriority[p]).map((p) => (
            <option key={p} value={p}>{p} ({fmt(page.byPriority[p] ?? 0)})</option>
          ))}
        </select>
      </label>
      <button type="submit" className="rounded border border-neutral-500 px-3 py-1">Filter</button>
    </form>
  );
}

/** Always rendered, once, whatever the data state: it explains how to read every recommendation field. */
function Legend() {
  return (
    <Card title="How to read this page">
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="inline font-medium">Priority</dt>
          <dd className="inline"> is the suggested order in which to look at things. It is not harm, risk or expected savings.</dd>
        </div>
        <div>
          <dt className="inline font-medium">Confidence</dt>
          <dd className="inline"> is confidence that the observation is accurate as measured, not confidence that acting on it will help.</dd>
        </div>
        <div>
          <dt className="inline font-medium">Impact</dt>
          <dd className="inline"> is qualitative. “Unknown” means no effect is established; nothing here shows a token or cost saving.</dd>
        </div>
      </dl>
      <div className="mt-2 space-y-1">
        <Note>{RECOMMENDATIONS_NOTE}</Note>
        <Note>
          Scope: usage figures cover all events, sidechain (sub-agent) events included. Each recommendation states how many sidechain records are settled and how many are unresolved; the Usage page&apos;s sidechain filter does not apply.
        </Note>
      </div>
    </Card>
  );
}

export function RecommendationsView({ recommendations, usageScanStatus }: { recommendations: ApiEnvelope<RecommendationsPage>; usageScanStatus?: string | null }) {
  return (
    <>
      <Legend />
      <Gate envelope={recommendations} section="any" usageScanStatus={usageScanStatus}>
        {(page) => (
          <>
            <Card title="Evidence available">
              <Note>
                Evidence available: usage {page.availability.usage ? "yes" : "no completed scan"}, configuration {page.availability.config ? "yes" : "no completed scan"}. A rule that lacks its evidence produces nothing rather than a generic suggestion.
              </Note>
              {/* Usage can be unavailable while the page still has data (for example a completed configuration scan). Shown once, only here. */}
              {page.availability.usage ? null : incompleteScanNote(usageScanStatus) ? (
                <div className="mt-2">
                  <Note>{incompleteScanNote(usageScanStatus)}</Note>
                </div>
              ) : null}
            </Card>

            <Card title="Recommendations">
              <div className="space-y-4">
                {page.total === 0 && page.filter.category === null && page.filter.priority === null ? (
                  <p className="text-sm">No recommendation is supported by the current evidence. See the rule table below for what each rule needs.</p>
                ) : (
                  <>
                    <FilterForm page={page} />
                    {page.items.length === 0 ? <p className="text-sm">No recommendation matches this filter.</p> : null}
                    <ul className="space-y-3">
                      {page.items.map((r) => (
                        <RecommendationCard key={r.id} r={r} />
                      ))}
                    </ul>
                    <Pager path="/recommendations" base={{ category: page.filter.category, priority: page.filter.priority }} limit={page.limit} offset={page.offset} total={page.total} />
                  </>
                )}
              </div>
            </Card>

            <Card title="Rules evaluated" description="Each rule states the evidence it needs. “Insufficient evidence” means the data to judge it is absent or too small, not that nothing is wrong.">
              <RulesTable rules={page.rules} />
            </Card>
          </>
        )}
      </Gate>
    </>
  );
}
