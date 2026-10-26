import { parseSidechainQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseSidechainQuery, (a, q) => a.usageSummary(q));
