export type RawSearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** Keeps repeated keys so the strict parsers can reject them instead of silently picking one. */
export function toSearchParams(raw: RawSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
  }
  return out;
}
