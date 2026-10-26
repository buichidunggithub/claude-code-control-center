import { Shell } from "@/components/dashboard/shell";
import { SourcesView } from "@/components/dashboard/sources-view";
import { PAGE_LIMIT_DEFAULT, parseSourceDetailQuery, parseSourcesQuery, type SourcesQuery } from "@/core/analysis";
import { getAnalysis } from "@/server/analysis";
import { toSearchParams, type RawSearchParams } from "@/server/search-params";

export const dynamic = "force-dynamic";
const UNPAGED: SourcesQuery = { limit: PAGE_LIMIT_DEFAULT, offset: 0 };

export default async function SourcesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const params = toSearchParams(await searchParams);
  const source = params.getAll("source");
  params.delete("source");
  const list = parseSourcesQuery(params);
  const q = list.ok ? list.value : UNPAGED;

  // `source` selects a source for the detail panel; it is validated by the parser the detail API uses.
  const selection = new URLSearchParams({ ref: source[0] ?? "" });
  const detailQuery = source.length === 1 ? parseSourceDetailQuery(selection) : null;
  const selected = detailQuery !== null && detailQuery.ok ? detailQuery.value : null;
  const invalid = !list.ok ? list.parameter : source.length > 0 && selected === null ? "source" : null;

  const analysis = getAnalysis();
  return (
    <Shell active="sources" title="Source coverage">
      {invalid === null ? null : (
        <div role="alert" className="rounded-lg border border-red-400 p-4 text-sm">
          The request is not valid (parameter: {invalid}); showing the first page of sources without a selection.
        </div>
      )}
      <SourcesView
        sources={analysis.sourceCoverage(q)}
        detail={selected === null ? null : analysis.sourceDetail({ ref: selected.ref, limit: PAGE_LIMIT_DEFAULT, offset: 0 })}
        selectedRef={selected === null ? null : selected.ref}
      />
    </Shell>
  );
}
