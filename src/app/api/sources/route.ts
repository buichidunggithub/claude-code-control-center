import { parseSourcesQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseSourcesQuery, (a, q) => a.sourceCoverage(q));
