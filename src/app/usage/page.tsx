import { Shell } from "@/components/dashboard/shell";
import { UsageView } from "@/components/dashboard/usage-view";
import { PAGE_LIMIT_DEFAULT, parseDayQuery, type DayQuery } from "@/core/analysis";
import { getAnalysis } from "@/server/analysis";
import { toSearchParams, type RawSearchParams } from "@/server/search-params";

export const dynamic = "force-dynamic";
const SESSION_PREVIEW = 25;
const UNFILTERED: DayQuery = { sidechain: "include", limit: PAGE_LIMIT_DEFAULT, offset: 0, from: null, to: null };

export default async function UsagePage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const parsed = parseDayQuery(toSearchParams(await searchParams));
  const q = parsed.ok ? parsed.value : UNFILTERED;
  const analysis = getAnalysis();
  return (
    <Shell active="usage" title="Usage">
      {parsed.ok ? null : (
        <div role="alert" className="rounded-lg border border-red-400 p-4 text-sm">
          The filter is not valid (parameter: {parsed.parameter}); showing unfiltered data. Dates are UTC days as YYYY-MM-DD, at most 366 days apart.
        </div>
      )}
      <UsageView
        sidechain={q.sidechain}
        from={q.from}
        to={q.to}
        models={analysis.usageByModel({ sidechain: q.sidechain, limit: PAGE_LIMIT_DEFAULT, offset: 0 })}
        days={analysis.usageByDay(q)}
        sessions={analysis.usageSessions({ sidechain: q.sidechain, limit: SESSION_PREVIEW, offset: 0 })}
        usageScanStatus={analysis.status().data?.usage.latestScan?.status ?? null}
      />
    </Shell>
  );
}
