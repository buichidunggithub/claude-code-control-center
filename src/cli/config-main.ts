import { CliError, REJECTIONS } from "./codes";
import { parseConfigArgs } from "./config-args";
import { renderConfigScan, runConfigScan, type ConfigScanReport } from "./config-run";
import { emit, type Sink } from "./output";

type Scanner = (options: { userRoot: string | null; projectRoot: string | null; dbPath: string | null }) => Promise<ConfigScanReport>;

const RECORDED_NOTICE =
  "CONFIG SCAN RECORDED. The scan was saved, but the result summary could not be shown (standard output was closed or failed). " +
  "Inspect the database in the dashboard to see the result.\n";

/** What may truthfully be said about the database for a failure. */
function stateAfter(exit: number, known: boolean, afterDbOpen: boolean, code: string): string {
  if (code === "SCAN_INCOMPLETE") return "A history row was recorded; the current configuration snapshot was not replaced.";
  if (exit === 2 || (known && !afterDbOpen)) return "Nothing was scanned or created.";
  if (known) return "No configuration rows were written by this run; the database file may already exist.";
  return "It is not known whether this run changed the database; inspect it before relying on it.";
}

/**
 * Entry point; returns the exit status so it can be tested in-process. It never prints an exception message, a
 * stack, a path or any file content.
 *
 * Exit status: 0 complete scan saved (also when only the summary could not be shown), 2 input rejected before
 * any work, 3 failure after work began, including a partial or failed scan that was recorded as history only.
 */
export async function main(argv: readonly string[], out: Sink = process.stdout, err: Sink = process.stderr, scan: Scanner = runConfigScan): Promise<number> {
  try {
    const command = parseConfigArgs(argv);
    const report = await scan({ userRoot: command.userRoot, projectRoot: command.projectRoot, dbPath: command.db });

    // From here on the scan is saved.
    let summary: string | null = null;
    try {
      summary = `${renderConfigScan(report)}\n`;
    } catch {
      summary = null;
    }
    if (summary === null || !(await emit(out, summary))) await emit(err, RECORDED_NOTICE);
    if (report.status === "complete") return 0;
    const { exit, hint } = REJECTIONS.SCAN_INCOMPLETE;
    await emit(err, `FAILED [SCAN_INCOMPLETE] ${hint}\n${stateAfter(exit, true, true, "SCAN_INCOMPLETE")}\n`);
    return exit;
  } catch (error) {
    const known = error instanceof CliError;
    const code = known ? error.code : "INTERNAL_ERROR";
    const { exit, hint } = REJECTIONS[code];
    await emit(err, `${exit === 2 ? "REJECTED" : "FAILED"} [${code}] ${hint}\n${stateAfter(exit, known, known && error.afterDbOpen, code)}\n`);
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
