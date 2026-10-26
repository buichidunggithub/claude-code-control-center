import { parseRunsQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseRunsQuery, (a, q) => a.runHistory(q));
