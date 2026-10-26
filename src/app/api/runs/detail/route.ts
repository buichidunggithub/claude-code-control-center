import { parseRunDetailQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseRunDetailQuery, (a, q) => a.runDetail(q));
