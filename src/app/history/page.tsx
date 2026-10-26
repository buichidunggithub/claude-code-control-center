import { HistoryView } from "@/components/dashboard/history-view";
import { Shell } from "@/components/dashboard/shell";
import { PAGE_LIMIT_DEFAULT, parseRunDetailQuery, parseRunsQuery, type RunsQuery } from "@/core/analysis";
import { getAnalysis } from "@/server/analysis";
import { toSearchParams, type RawSearchParams } from "@/server/search-params";

export const dynamic = "force-dynamic";
const UNPAGED: RunsQuery = { limit: PAGE_LIMIT_DEFAULT, offset: 0 };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const params = toSearchParams(await searchParams);
  const run = params.getAll("run");
  params.delete("run");
  const list = parseRunsQuery(params);
  const q = list.ok ? list.value : UNPAGED;

  // `run` selects a run for the detail panel; it is validated by the same parser the detail API uses.
  const selection = new URLSearchParams({ id: run[0] ?? "" });
  const detailQuery = run.length === 1 ? parseRunDetailQuery(selection) : null;
  const selected = detailQuery !== null && detailQuery.ok ? detailQuery.value : null;
  const invalid = !list.ok ? list.parameter : run.length > 0 && selected === null ? "run" : null;

  const analysis = getAnalysis();
  return (
    <Shell active="history" title="Run history">
      {invalid === null ? null : (
        <div role="alert" className="rounded-lg border border-red-400 p-4 text-sm">
          The request is not valid (parameter: {invalid}); showing the first page of runs without a selection.
        </div>
      )}
      <HistoryView
        runs={analysis.runHistory(q)}
        detail={selected === null ? null : analysis.runDetail({ id: selected.id, limit: PAGE_LIMIT_DEFAULT, offset: 0 })}
        selectedId={selected === null ? null : selected.id}
      />
    </Shell>
  );
}
