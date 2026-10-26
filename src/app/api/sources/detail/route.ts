import { parseSourceDetailQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseSourceDetailQuery, (a, q) => a.sourceDetail(q));
