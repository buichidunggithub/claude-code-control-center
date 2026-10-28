import { CliError } from "./codes";

export const PROMPT_SIZE_FLAG = "--prompt-size";

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "preview"; readonly path: string }
  /** `promptSize` is present (true) only when `--prompt-size` was given; absent means off. */
  | { readonly kind: "run"; readonly path: string; readonly db: string | null; readonly token: string | null; readonly promptSize?: true };

/**
 * Strict parsing: one sub-command, exactly one positional path, and for `run` only `--db` and `--token`
 * (each at most once with a separate value) and the value-less `--prompt-size`. Anything else is rejected
 * before any filesystem access. `help` takes no arguments.
 */
export function parseArgs(argv: readonly string[]): Command {
  const [sub, ...rest] = argv;
  if (sub === "help") {
    if (rest.length > 0) throw new CliError("USAGE");
    return { kind: "help" };
  }
  if (sub !== "preview" && sub !== "run") throw new CliError("USAGE");
  let promptSize = false;

  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (sub === "run" && arg === PROMPT_SIZE_FLAG) {
      if (promptSize) throw new CliError("DUPLICATE_OPTION");
      promptSize = true;
      continue;
    }
    if (sub === "preview" || (arg !== "--db" && arg !== "--token")) throw new CliError("INVALID_OPTION");
    if (options.has(arg)) throw new CliError("DUPLICATE_OPTION");
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError("USAGE");
    options.set(arg, value);
    i += 1;
  }
  if (positional.length !== 1) throw new CliError("USAGE");

  const path = positional[0] as string;
  if (sub === "preview") return { kind: "preview", path };
  const run = { kind: "run" as const, path, db: options.get("--db") ?? null, token: options.get("--token") ?? null };
  return promptSize ? { ...run, promptSize: true } : run;
}
