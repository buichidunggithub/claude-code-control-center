import { parsePagedSidechainQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parsePagedSidechainQuery, (a, q) => a.usageSessions(q));
