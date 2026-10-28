/** Strict, bounded query-parameter parsing. Failures name the parameter only, never echo the value. */
import { RULES } from "../config";
import { CATEGORIES, PRIORITIES, type RecommendationCategory, type RecommendationPriority } from "../recommend";
import type { SidechainMode } from "./types";

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;
export const PAGE_OFFSET_MAX = 100_000;
export const MAX_RANGE_DAYS = 366;
export const RUN_ID_MAX = 9_999_999;
const MS_PER_DAY = 86_400_000;

export const SEVERITIES = ["info", "low", "medium", "high"] as const;

export type ParamResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly parameter: string };

export type Source = Pick<URLSearchParams, "get" | "getAll" | "keys">;

export const fail = (parameter: string): { ok: false; parameter: string } => ({ ok: false, parameter });
export const good = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value });

/** A single optional value (null when absent or empty); repeating the parameter is rejected rather than guessed. */
export function single(source: Source, name: string): string | null | undefined {
  const values = source.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) return undefined;
  // An empty value is what a browser sends for a blank field or an "All" option: same as absent.
  return values[0] === "" ? null : values[0];
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): ParamResult<number> {
  const raw = single(source, name);
  if (raw === undefined) return fail(name);
  if (raw === null) return good(fallback);
  if (!/^\d{1,7}$/.test(raw)) return fail(name);
  const value = Number(raw);
  return value < min || value > max ? fail(name) : good(value);
}

export function parseDay(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== raw ? null : ms;
}

/** Rejects unknown parameters so a typo never silently widens a query. */
export function onlyKnown(source: Source, known: readonly string[]): string | null {
  for (const key of source.keys()) if (!known.includes(key)) return key.length <= 40 && /^\w+$/.test(key) ? key : "unknown";
  return null;
}

export interface PageParams {
  readonly limit: number;
  readonly offset: number;
}

export function pageParams(source: Source): ParamResult<PageParams> {
  const limit = integer(source, "limit", PAGE_LIMIT_DEFAULT, 1, PAGE_LIMIT_MAX);
  if (!limit.ok) return limit;
  const offset = integer(source, "offset", 0, 0, PAGE_OFFSET_MAX);
  return offset.ok ? good({ limit: limit.value, offset: offset.value }) : offset;
}

function sidechainParam(source: Source): ParamResult<SidechainMode> {
  const raw = single(source, "sidechain");
  if (raw === undefined) return fail("sidechain");
  if (raw === null) return good("include");
  return raw === "include" || raw === "exclude" ? good(raw) : fail("sidechain");
}

export interface SidechainQuery {
  readonly sidechain: SidechainMode;
}
export interface PagedSidechainQuery extends SidechainQuery, PageParams {}
export interface DayQuery extends PagedSidechainQuery {
  readonly from: string | null;
  readonly to: string | null;
}
export interface FindingsQuery extends PageParams {
  readonly severity: (typeof SEVERITIES)[number] | null;
  readonly ruleId: string | null;
}

export interface RecommendationsQuery extends PageParams {
  readonly category: RecommendationCategory | null;
  readonly priority: RecommendationPriority | null;
}

export function parseRecommendationsQuery(source: Source): ParamResult<RecommendationsQuery> {
  const unknown = onlyKnown(source, ["category", "priority", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const page = pageParams(source);
  if (!page.ok) return page;
  const category = single(source, "category");
  if (category === undefined || (category !== null && !(CATEGORIES as readonly string[]).includes(category))) return fail("category");
  const priority = single(source, "priority");
  if (priority === undefined || (priority !== null && !(PRIORITIES as readonly string[]).includes(priority))) return fail("priority");
  return good({ ...page.value, category: category as RecommendationsQuery["category"], priority: priority as RecommendationsQuery["priority"] });
}

export function parseNoParams(source: Source): ParamResult<Record<string, never>> {
  const unknown = onlyKnown(source, []);
  return unknown ? fail(unknown) : good({});
}

export function parseSidechainQuery(source: Source): ParamResult<SidechainQuery> {
  const unknown = onlyKnown(source, ["sidechain"]);
  if (unknown) return fail(unknown);
  const sidechain = sidechainParam(source);
  return sidechain.ok ? good({ sidechain: sidechain.value }) : sidechain;
}

export function parsePagedSidechainQuery(source: Source): ParamResult<PagedSidechainQuery> {
  const unknown = onlyKnown(source, ["sidechain", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const sidechain = sidechainParam(source);
  if (!sidechain.ok) return sidechain;
  const page = pageParams(source);
  return page.ok ? good({ sidechain: sidechain.value, ...page.value }) : page;
}

export function parseDayQuery(source: Source): ParamResult<DayQuery> {
  const unknown = onlyKnown(source, ["sidechain", "limit", "offset", "from", "to"]);
  if (unknown) return fail(unknown);
  const sidechain = sidechainParam(source);
  if (!sidechain.ok) return sidechain;
  const page = pageParams(source);
  if (!page.ok) return page;
  const bounds = dayRange(source);
  return bounds.ok ? good({ sidechain: sidechain.value, ...page.value, ...bounds.value }) : bounds;
}

export interface DayRange {
  readonly from: string | null;
  readonly to: string | null;
}

/** Optional inclusive `from`/`to` UTC days, at most MAX_RANGE_DAYS apart and in order. */
export function dayRange(source: Source): ParamResult<DayRange> {
  const bounds: Record<"from" | "to", string | null> = { from: null, to: null };
  for (const name of ["from", "to"] as const) {
    const raw = single(source, name);
    if (raw === undefined || (raw !== null && parseDay(raw) === null)) return fail(name);
    bounds[name] = raw;
  }
  if (bounds.from !== null && bounds.to !== null) {
    const span = ((parseDay(bounds.to) ?? 0) - (parseDay(bounds.from) ?? 0)) / MS_PER_DAY;
    if (span < 0 || span + 1 > MAX_RANGE_DAYS) return fail("to");
  }
  return good(bounds);
}

export function parseFindingsQuery(source: Source): ParamResult<FindingsQuery> {
  const unknown = onlyKnown(source, ["severity", "ruleId", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const page = pageParams(source);
  if (!page.ok) return page;
  const severity = single(source, "severity");
  if (severity === undefined || (severity !== null && !(SEVERITIES as readonly string[]).includes(severity))) return fail("severity");
  const ruleId = single(source, "ruleId");
  if (ruleId === undefined || (ruleId !== null && !Object.hasOwn(RULES, ruleId))) return fail("ruleId");
  return good({ ...page.value, severity: severity as FindingsQuery["severity"], ruleId });
}

export type RunsQuery = PageParams;
export interface RunDetailQuery extends PageParams {
  readonly id: number;
}

export function parseRunsQuery(source: Source): ParamResult<RunsQuery> {
  const unknown = onlyKnown(source, ["limit", "offset"]);
  return unknown ? fail(unknown) : pageParams(source);
}

export function parseRunDetailQuery(source: Source): ParamResult<RunDetailQuery> {
  const unknown = onlyKnown(source, ["id", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const id = integer(source, "id", 0, 1, RUN_ID_MAX);
  // `id` has no default: an absent or empty value is rejected rather than guessed.
  if (!id.ok || id.value === 0) return fail("id");
  const page = pageParams(source);
  return page.ok ? good({ ...page.value, id: id.value }) : page;
}

export const SOURCE_REF_PATTERN = /^[0-9a-f]{32}$/;

export type SourcesQuery = PageParams;
export interface SourceDetailQuery extends PageParams {
  readonly ref: string;
}

export function parseSourcesQuery(source: Source): ParamResult<SourcesQuery> {
  const unknown = onlyKnown(source, ["limit", "offset"]);
  return unknown ? fail(unknown) : pageParams(source);
}

export function parseSourceDetailQuery(source: Source): ParamResult<SourceDetailQuery> {
  const unknown = onlyKnown(source, ["ref", "limit", "offset"]);
  if (unknown) return fail(unknown);
  const ref = single(source, "ref");
  if (ref === undefined || ref === null || !SOURCE_REF_PATTERN.test(ref)) return fail("ref");
  const page = pageParams(source);
  return page.ok ? good({ ...page.value, ref }) : page;
}
