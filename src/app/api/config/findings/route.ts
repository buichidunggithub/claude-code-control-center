import { parseFindingsQuery } from "@/core/analysis";
import { readOnlyRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = readOnlyRoute(parseFindingsQuery, (a, q) => a.configFindings(q));
