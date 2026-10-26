import { RecommendationsView } from "@/components/dashboard/recommendations-view";
import { Shell } from "@/components/dashboard/shell";
import { PAGE_LIMIT_DEFAULT, parseRecommendationsQuery, type RecommendationsQuery } from "@/core/analysis";
import { getAnalysis } from "@/server/analysis";
import { toSearchParams, type RawSearchParams } from "@/server/search-params";

export const dynamic = "force-dynamic";
const UNFILTERED: RecommendationsQuery = { category: null, priority: null, limit: PAGE_LIMIT_DEFAULT, offset: 0 };

export default async function RecommendationsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const parsed = parseRecommendationsQuery(toSearchParams(await searchParams));
  const analysis = getAnalysis();
  return (
    <Shell active="recommendations" title="Recommendations">
      {parsed.ok ? null : (
        <div role="alert" className="rounded-lg border border-red-400 p-4 text-sm">
          The filter is not valid (parameter: {parsed.parameter}); showing unfiltered recommendations.
        </div>
      )}
      <RecommendationsView recommendations={analysis.recommendations(parsed.ok ? parsed.value : UNFILTERED)} usageScanStatus={analysis.status().data?.usage.latestScan?.status ?? null} />
    </Shell>
  );
}
