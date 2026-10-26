import { parseDayQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseDayQuery, (a, q) => a.usageByDay(q));
