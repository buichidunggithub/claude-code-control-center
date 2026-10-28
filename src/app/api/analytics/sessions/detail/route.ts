import { parseSessionDetailQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseSessionDetailQuery, (a, q) => a.analyticsSessionDetail(q));
