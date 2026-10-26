import { CliError } from "./codes";

export interface ConfigScanCommand {
  readonly userRoot: string | null;
  readonly projectRoot: string | null;
  readonly db: string | null;
}

const OPTIONS = ["--user-root", "--project-root", "--db"] as const;

/**
 * Strict parsing: the sub-command `scan` is implied by the script name; only the three options below are
 * accepted, each at most once with a separate value, and no positional argument. Each root says what kind of
 * root it is, so the scanner never has to guess a layout. Nothing touches the filesystem here.
 */
export function parseConfigArgs(argv: readonly string[]): ConfigScanCommand {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new CliError("CONFIG_USAGE");
    if (!(OPTIONS as readonly string[]).includes(arg)) throw new CliError("INVALID_OPTION");
    if (options.has(arg)) throw new CliError("DUPLICATE_OPTION");
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError("CONFIG_USAGE");
    options.set(arg, value);
    i += 1;
  }
  const userRoot = options.get("--user-root") ?? null;
  const projectRoot = options.get("--project-root") ?? null;
  if (userRoot === null && projectRoot === null) throw new CliError("ROOT_REQUIRED");
  return { userRoot, projectRoot, db: options.get("--db") ?? null };
}
