import { AnalyticsView } from "@/components/dashboard/analytics-view";
import { Shell } from "@/components/dashboard/shell";
import {
  PAGE_LIMIT_DEFAULT,
  parseAnalyticsPageQuery,
  parseSessionDetailQuery,
  parseTrendsQuery,
  type ParamResult,
  type PageParams,
  type TrendsQuery,
} from "@/core/analysis";
import { getAnalysis } from "@/server/analysis";
import { toSearchParams, type RawSearchParams } from "@/server/search-params";

export const dynamic = "force-dynamic";

/** Page parameter names, mapped to the API parameter each one feeds. */
const KNOWN = ["from", "to", "offset", "soffset", "session", "doffset"] as const;
const DEFAULT_TRENDS: TrendsQuery = { from: null, to: null, limit: PAGE_LIMIT_DEFAULT, offset: 0 };
const DEFAULT_PAGE: PageParams = { limit: PAGE_LIMIT_DEFAULT, offset: 0 };

/** Copies the listed page parameters (every repeated value) under the names an API parser expects. */
function pick(source: URLSearchParams, mapping: Readonly<Record<string, string>>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [from, to] of Object.entries(mapping)) for (const value of source.getAll(from)) out.append(to, value);
  return out;
}

/** The first failing parameter, named as the page spells it. The value is never echoed. */
function firstInvalid(results: readonly (readonly [ParamResult<unknown>, Readonly<Record<string, string>>])[]): string | null {
  for (const [result, names] of results) if (!result.ok) return names[result.parameter] ?? "unknown";
  return null;
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = toSearchParams(await searchParams);
  const stray = [...raw.keys()].find((key) => !(KNOWN as readonly string[]).includes(key));

  const trendsParsed = parseTrendsQuery(pick(raw, { from: "from", to: "to", offset: "offset" }));
  const sessionsParsed = parseAnalyticsPageQuery(pick(raw, { soffset: "offset" }));
  const detailParsed = raw.has("session") ? parseSessionDetailQuery(pick(raw, { session: "id", doffset: "offset" })) : null;

  const invalid =
    stray !== undefined
      ? "unknown"
      : firstInvalid([
          [trendsParsed, { from: "from", to: "to", offset: "offset", limit: "offset" }],
          [sessionsParsed, { offset: "soffset", limit: "soffset" }],
          ...(detailParsed === null ? [] : [[detailParsed, { id: "session", offset: "doffset", limit: "doffset" }] as const]),
        ]);

  const trendsQuery = trendsParsed.ok ? trendsParsed.value : DEFAULT_TRENDS;
  const sessionsQuery = sessionsParsed.ok ? sessionsParsed.value : DEFAULT_PAGE;
  const detailQuery = detailParsed !== null && detailParsed.ok ? detailParsed.value : null;

  const analysis = getAnalysis();
  const base = {
    from: trendsQuery.from,
    to: trendsQuery.to,
    offset: trendsQuery.offset === 0 ? null : String(trendsQuery.offset),
    soffset: sessionsQuery.offset === 0 ? null : String(sessionsQuery.offset),
    session: detailQuery === null ? null : detailQuery.id,
    doffset: detailQuery === null || detailQuery.offset === 0 ? null : String(detailQuery.offset),
  };

  return (
    <Shell active="analytics" title="Event facts">
      {invalid === null ? null : (
        <div role="alert" className="rounded-lg border border-red-400 p-4 text-sm">
          The request is not valid (parameter: {invalid}); invalid parts are shown with their defaults. Dates are UTC days as YYYY-MM-DD, at most 366 days apart.
        </div>
      )}
      <AnalyticsView
        summary={analysis.analyticsSummary()}
        tools={analysis.analyticsTools()}
        trends={analysis.analyticsTrends(trendsQuery)}
        sessions={analysis.analyticsSessions(sessionsQuery)}
        detail={detailQuery === null ? null : analysis.analyticsSessionDetail(detailQuery)}
        selectedSession={detailQuery === null ? null : detailQuery.id}
        base={base}
      />
    </Shell>
  );
}
