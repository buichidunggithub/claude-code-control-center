import { ConfigView } from "@/components/dashboard/config-view";
import { Shell } from "@/components/dashboard/shell";
import { parseFindingsQuery } from "@/core/analysis";
import { getAnalysis } from "@/server/analysis";
import { toSearchParams, type RawSearchParams } from "@/server/search-params";

export const dynamic = "force-dynamic";

export default async function ConfigPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const parsed = parseFindingsQuery(toSearchParams(await searchParams));
  const analysis = getAnalysis();
  const query = parsed.ok ? parsed.value : { severity: null, ruleId: null, limit: 50, offset: 0 };
  return (
    <Shell active="config" title="Configuration audit">
      {parsed.ok ? null : (
        <div role="alert" className="rounded-lg border border-red-400 p-4 text-sm">
          The filter is not valid (parameter: {parsed.parameter}); showing unfiltered findings.
        </div>
      )}
      <ConfigView summary={analysis.configSummary()} findings={analysis.configFindings(query)} />
    </Shell>
  );
}
