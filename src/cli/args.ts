import { CliError } from "./codes";

export type Command =
  | { readonly kind: "preview"; readonly path: string }
  | { readonly kind: "run"; readonly path: string; readonly db: string | null; readonly token: string | null };

/**
 * Strict parsing: one sub-command, exactly one positional path, and for `run` only `--db` and `--token`,
 * each at most once with a separate value. Anything else is rejected before any filesystem access.
 */
export function parseArgs(argv: readonly string[]): Command {
  const [sub, ...rest] = argv;
  if (sub !== "preview" && sub !== "run") throw new CliError("USAGE");

  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
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
  return sub === "preview" ? { kind: "preview", path } : { kind: "run", path, db: options.get("--db") ?? null, token: options.get("--token") ?? null };
}
