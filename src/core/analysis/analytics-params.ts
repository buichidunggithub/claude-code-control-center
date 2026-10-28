/** Query parsing for the event-facts analytics API. Same strictness as `params.ts`: unknown or repeated parameters fail. */
import { dayRange, fail, good, onlyKnown, pageParams, single, type DayRange, type PageParams, type ParamResult, type Source } from "./params";

/** Opaque session reference: the first 16 hex characters of the salted fingerprint, as in the usage sessions API. */
export const SESSION_REF_PATTERN = /^[0-9a-f]{16}$/;

export interface TrendsQuery extends PageParams, DayRange {}
export interface SessionDetailQuery extends PageParams {
  readonly id: string;
}

export function parseTrendsQuery(source: Source): ParamResult<TrendsQuery> {
  const unknown = onlyKnown(source, ["from", "to", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const page = pageParams(source);
  if (!page.ok) return page;
  const range = dayRange(source);
  return range.ok ? good({ ...page.value, ...range.value }) : range;
}

export function parseAnalyticsPageQuery(source: Source): ParamResult<PageParams> {
  const unknown = onlyKnown(source, ["limit", "offset"]);
  return unknown ? fail(unknown) : pageParams(source);
}

export function parseSessionDetailQuery(source: Source): ParamResult<SessionDetailQuery> {
  const unknown = onlyKnown(source, ["id", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const id = single(source, "id");
  if (id === undefined || id === null || !SESSION_REF_PATTERN.test(id)) return fail("id");
  const page = pageParams(source);
  return page.ok ? good({ ...page.value, id }) : page;
}
