/** Serializes rendered forms the way a browser would, so tests can submit what a user would. */
export type SearchParams = Record<string, string | string[] | undefined>;

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Serializes a form like a browser: every named control is sent, blank text fields as empty strings. */
export function submitForm(markup: string, action: string, overrides: Record<string, string> = {}): URLSearchParams {
  const body = new RegExp(`<form[^>]*\\saction="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(markup)?.[1];
  if (body === undefined) throw new Error(`no form with action ${action}`);
  const entries = new Map<string, string>();
  for (const input of body.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(input[0], "name");
    if (name) entries.set(name, attr(input[0], "value") ?? "");
  }
  for (const select of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(select[1] ?? "", "name");
    const options = [...(select[2] ?? "").matchAll(/<option\b([^>]*)>/g)].map((o) => o[1] ?? "");
    const chosen = options.find((o) => /\sselected(=|\s|$)/.test(o)) ?? options[0];
    if (name) entries.set(name, attr(chosen ?? "", "value") ?? "");
  }
  for (const [k, v] of Object.entries(overrides)) entries.set(k, v);
  return new URLSearchParams([...entries]);
}

export const toRaw = (params: URLSearchParams): SearchParams => {
  const out: SearchParams = {};
  for (const key of new Set(params.keys())) out[key] = params.getAll(key).length > 1 ? params.getAll(key) : (params.get(key) ?? "");
  return out;
};

