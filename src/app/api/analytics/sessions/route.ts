import { parseAnalyticsPageQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseAnalyticsPageQuery, (a, q) => a.analyticsSessions(q));
