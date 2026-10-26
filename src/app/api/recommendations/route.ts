import { parseRecommendationsQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseRecommendationsQuery, (a, q) => a.recommendations(q));
