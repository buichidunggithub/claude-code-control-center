import { parseTrendsQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseTrendsQuery, (a, q) => a.analyticsTrends(q));
