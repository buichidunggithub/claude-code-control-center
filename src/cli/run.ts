import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import { recognizeModelName } from "../core/recommend/model-name";
import { accountingStateCounts, accountingSummary, ingestSources, openStore, readSource, scanDiagnostics, settledByModel, type Store } from "../core/store";
import { CliError } from "./codes";
import { MAX_FILE_BYTES } from "./limits";
import { inspectDbPath, inspectSource } from "./path-check";
import { checkToken, fileToken } from "./token";

export interface RunOptions {
  readonly sourcePath: string;
  readonly dbPath: string | null;
  readonly token: string | null;
  /** Tests may lower the limit; the command line cannot. */
  readonly maxBytes?: number;
}

/** Test seams only: the command line never sets these. */
export interface RunHooks {
  /** Called after validation and the token check, immediately before the file is opened. */
  readonly beforeOpen?: () => void;
  /** Called after the database was opened, immediately before the file is streamed. */
  readonly beforeRead?: () => void;
  /** Called after the file was read and before the post-read check and the ingest. */
  readonly afterRead?: () => void;
}

export interface RunReport {
  readonly scanRunId: number;
  readonly status: string;
  readonly outcome: string;
  readonly recordsInserted: number;
  readonly recordsRemoved: number;
  readonly identityUncertain: boolean;
  /** Database-wide figures after this ingest, not only this file's. */
  readonly database: {
    readonly states: Record<string, number>;
    readonly settledRecords: number;
    readonly settledTokens: Record<string, number>;
    readonly conflictingGroups: number;
    readonly recognizedModelRecords: number;
    readonly unattributedModelRecords: number;
    readonly distinctRecognizedModels: number;
  } | null;
  readonly skippedLines: { readonly blank: number; readonly malformed: number; readonly nonObject: number; readonly oversized: number; readonly usageObjectsMalformed: number } | null;
}

const sameFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** After the ingest committed, a failure to close a handle must not turn a success into an error. */
function closeQuietly(close: () => void): void {
  try {
    close();
  } catch {
    // nothing to do: the work is finished and every needed check already ran
  }
}

const lstatOrNull = (path: string): BigIntStats | null => {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
};

/** The opened handle and the name must still be the validated file: same identity, size and timestamps. */
function assertUnchanged(fd: number, path: string, validated: BigIntStats, code: "FILE_CHANGED" | "FILE_CHANGED_DURING_READ", afterDbOpen: boolean): void {
  const opened = fstatSync(fd, { bigint: true });
  const named = lstatOrNull(path);
  if (!opened.isFile() || !sameFile(opened, validated) || named === null || !sameFile(named, opened)) throw new CliError(code, afterDbOpen);
}

function summarize(store: Store, scanRunId: number): Pick<RunReport, "database" | "skippedLines"> {
  try {
    const summary = accountingSummary(store.db);
    const models = settledByModel(store.db);
    const recognized = models.filter((m) => recognizeModelName(m.key) !== null);
    const diag = scanDiagnostics(store.db, scanRunId)?.sources[0]?.skipped;
    return {
      database: {
        states: { ...accountingStateCounts(store.db) },
        settledRecords: summary.settled.records,
        settledTokens: { input: summary.settled.inputTokens, output: summary.settled.outputTokens, cacheRead: summary.settled.cacheReadTokens, cacheCreation: summary.settled.cacheCreationTokens },
        conflictingGroups: summary.conflicting.groups,
        recognizedModelRecords: recognized.reduce((n, m) => n + m.records, 0),
        unattributedModelRecords: models.filter((m) => recognizeModelName(m.key) === null).reduce((n, m) => n + m.records, 0),
        distinctRecognizedModels: new Set(recognized.map((m) => recognizeModelName(m.key))).size,
      },
      skippedLines: diag ? { blank: diag.blank, malformed: diag.malformed, nonObject: diag.nonObject, oversized: diag.oversized, usageObjectsMalformed: diag.usageObjectsMalformed } : null,
    };
  } catch {
    return { database: null, skippedLines: null }; // the ingest is already committed; a summary problem must not look like a failed ingest
  }
}

/**
 * Order matters and is the safety design:
 *  1. validate the transcript path, the database path and the token (metadata only; nothing created);
 *  2. open the transcript with O_NOFOLLOW and check the OPENED handle against the validated metadata;
 *  3. only now create/open the database;
 *  4. read the file with the existing reader, then re-check the handle and the name and the byte count;
 *  5. only if nothing changed, run the existing ingest (one transaction).
 * The existing reader opens the file by path, so a change between steps 2 and 4 is detected after the read
 * (by identity, size and timestamps), not prevented. A change that leaves all of those unchanged is not
 * detectable. A detected change aborts before any record is written; the database file may then exist but
 * holds no records from this run.
 */
export async function runIngest(options: RunOptions, hooks: RunHooks = {}): Promise<RunReport> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const path = options.sourcePath;
  const validated = inspectSource(path, maxBytes);
  const dbPath = inspectDbPath(options.dbPath, path, validated);
  checkToken(options.token, fileToken(path, validated));

  hooks.beforeOpen?.();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new CliError("OPEN_FAILED");
  }
  try {
    assertUnchanged(fd, path, validated, "FILE_CHANGED", false);
    if (fstatSync(fd, { bigint: true }).size > BigInt(maxBytes)) throw new CliError("FILE_TOO_LARGE");

    let store: Store;
    try {
      store = openStore(dbPath, { tightenExistingFile: false });
    } catch {
      throw new CliError("DB_UNUSABLE", true);
    }
    try {
      hooks.beforeRead?.();
      // The cap is the previewed size, which already passed the size limit: the stream stops at once if the file
      // grows past what was validated, instead of being read to its end.
      const input = await readSource(store, path, { maxBytes: Number(validated.size) });
      hooks.afterRead?.();
      if (input.kind !== "ok") {
        assertUnchanged(fd, path, validated, "FILE_CHANGED_DURING_READ", true); // growth or replacement is reported as such
        throw new CliError("READ_FAILED", true);
      }
      assertUnchanged(fd, path, validated, "FILE_CHANGED_DURING_READ", true);
      if (BigInt(input.sizeBytes) !== validated.size) throw new CliError("FILE_CHANGED_DURING_READ", true);

      let result;
      try {
        result = await ingestSources(store, [input]);
      } catch {
        throw new CliError("INGEST_FAILED", true);
      }
      const source = result.sources[0];
      return {
        scanRunId: result.scanRunId,
        status: result.status,
        outcome: source?.outcome ?? "unknown",
        recordsInserted: source?.recordsInserted ?? 0,
        recordsRemoved: source?.recordsRemoved ?? 0,
        identityUncertain: source?.anonymousIdentityUncertain ?? false,
        ...summarize(store, result.scanRunId),
      };
    } finally {
      closeQuietly(() => store.close());
    }
  } finally {
    closeQuietly(() => closeSync(fd));
  }
}

export function renderRun(r: RunReport): string {
  const lines = [
    "INGEST COMPLETE (aggregate figures only; no content is shown)",
    "",
    `Scan run ........ #${r.scanRunId}, status ${r.status}`,
    `This file ....... ${r.outcome}; ${r.recordsInserted} records stored, ${r.recordsRemoved} replaced${r.identityUncertain ? "; anonymous identity is uncertain for this source" : ""}`,
  ];
  if (r.skippedLines) lines.push(`Skipped lines ... malformed ${r.skippedLines.malformed}, non-object ${r.skippedLines.nonObject}, blank ${r.skippedLines.blank}, oversized ${r.skippedLines.oversized}, malformed usage objects ${r.skippedLines.usageObjectsMalformed}`);
  if (r.database) {
    const d = r.database;
    lines.push(
      "",
      "Database totals after this ingest (all sources in this database):",
      `  accounting states ... accepted ${d.states.accepted ?? 0}, duplicate ${d.states.duplicate ?? 0}, conflicting ${d.states.conflicting ?? 0} (${d.conflictingGroups} groups), ambiguous ${d.states.ambiguous ?? 0}`,
      `  settled records ..... ${d.settledRecords}; tokens input ${d.settledTokens.input}, output ${d.settledTokens.output}, cache read ${d.settledTokens.cacheRead}, cache creation ${d.settledTokens.cacheCreation}`,
      `  models .............. ${d.distinctRecognizedModels} recognized (${d.recognizedModelRecords} settled records), ${d.unattributedModelRecords} settled records without a recognized model identifier`,
    );
  } else lines.push("", "(The summary could not be produced; the ingest itself was committed.)");
  lines.push(
    "",
    "Token totals count usage records found in the ingested transcript and accepted by the accounting pipeline.",
    "They may be incomplete and are not billing totals. See the README.",
    "",
    "To inspect the results in the dashboard: CLAUDE_CONTROL_DB_PATH=<the --db path you used> pnpm start",
  );
  return lines.join("\n");
}
