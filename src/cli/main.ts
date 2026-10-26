import { parseArgs } from "./args";
import { CliError, REJECTIONS } from "./codes";
import { emit, type Sink } from "./output";
import { previewSource, renderPreview } from "./preview";

type RunModule = typeof import("./run");

/** Loaded only for `run`, so the preview never loads the database module. Tests inject their own loader. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultLoader = (): RunModule => require("./run") as RunModule;

const COMMITTED_NOTICE =
  "INGEST COMMITTED. The usage records were written, but the result summary could not be shown (standard output was closed or failed). " +
  "Inspect the database in the dashboard to see the result.\n";

type Stage = "parse" | "preview" | "run";

/** What may truthfully be said about the database for a failure that carries no code of ours. */
function stateAfter(exit: number, known: boolean, afterDbOpen: boolean, stage: Stage): string {
  if (exit === 2 || (known && !afterDbOpen)) return "Nothing was read or created.";
  if (known) return "No usage records were written by this run; the database file may already exist.";
  return stage === "run" ? "It is not known whether this run changed the database; inspect it before relying on it." : "Nothing was read or created.";
}

/**
 * Entry point. Returns the exit status instead of exiting, so it can be tested in-process. It never prints
 * an exception message, a stack, a path from an error, or any file content.
 *
 * Exit status: 0 success (including a committed ingest whose summary could not be shown), 2 input rejected
 * before any work, 3 failure after work began. Once `runIngest` has returned the ingest is committed, and
 * nothing after that point may report otherwise.
 */
export async function main(argv: readonly string[], out: Sink = process.stdout, err: Sink = process.stderr, load: () => RunModule | Promise<RunModule> = defaultLoader): Promise<number> {
  let stage: Stage = "parse";
  try {
    const command = parseArgs(argv);
    if (command.kind === "preview") {
      stage = "preview";
      const text = renderPreview(previewSource(command.path));
      if (!(await emit(out, `${text}\n`))) throw new CliError("OUTPUT_FAILED");
      return 0;
    }
    stage = "run";
    const { runIngest, renderRun } = await load();
    const report = await runIngest({ sourcePath: command.path, dbPath: command.db, token: command.token });

    // From here on the ingest is committed.
    let summary: string | null = null;
    try {
      summary = `${renderRun(report)}\n`;
    } catch {
      summary = null;
    }
    if (summary === null || !(await emit(out, summary))) await emit(err, COMMITTED_NOTICE);
    return 0;
  } catch (error) {
    const known = error instanceof CliError;
    const code = known ? error.code : "INTERNAL_ERROR";
    const { exit, hint } = REJECTIONS[code];
    const state = stateAfter(exit, known, known && error.afterDbOpen, stage);
    await emit(err, `${exit === 2 ? "REJECTED" : "FAILED"} [${code}] ${hint}\n${state}\n`);
    return exit;
  }
}

if (typeof require !== "undefined" && require.main === module) {
  // A closed stdout/stderr must end as a normal exit status, not as an unhandled 'error' event with a stack trace.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
