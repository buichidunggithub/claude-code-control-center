import { parseNoParams } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseNoParams, (a) => a.configSummary());
