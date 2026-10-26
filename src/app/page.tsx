import { OverviewView } from "@/components/dashboard/overview-view";
import { Shell } from "@/components/dashboard/shell";
import { getAnalysis } from "@/server/analysis";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const analysis = getAnalysis();
  return (
    <Shell active="overview" title="Overview">
      <OverviewView status={analysis.status()} summary={analysis.usageSummary({ sidechain: "include" })} config={analysis.configSummary()} />
    </Shell>
  );
}
