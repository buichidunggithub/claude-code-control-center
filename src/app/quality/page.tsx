import { QualityView } from "@/components/dashboard/quality-view";
import { Shell } from "@/components/dashboard/shell";
import { getAnalysis } from "@/server/analysis";

export const dynamic = "force-dynamic";

export default function QualityPage() {
  const analysis = getAnalysis();
  return (
    <Shell active="quality" title="Data quality">
      <QualityView status={analysis.status()} quality={analysis.usageQuality()} config={analysis.configSummary()} />
    </Shell>
  );
}
