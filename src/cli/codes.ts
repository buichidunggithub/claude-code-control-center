/**
 * Every failure of the ingest command is one of these fixed codes with a fixed hint. Nothing derived from
 * the input (a path, a file name, a message from a library, file content) is ever put into an error.
 * `exit` is 2 for rejected input (nothing was read or created) and 3 for a failure after work began.
 */
export const REJECTIONS = {
  USAGE: { exit: 2, hint: "Expected: ingest preview <absolute-path>   or   ingest run --db <absolute-db-path> --token <token> [--prompt-size] <absolute-path>   or   ingest help." },
  INVALID_OPTION: { exit: 2, hint: "Unknown or unsupported option." },
  DUPLICATE_OPTION: { exit: 2, hint: "An option was given more than once." },
  PATH_LENGTH: { exit: 2, hint: "The path is empty or too long." },
  CONTROL_CHARACTER: { exit: 2, hint: "The path contains a control character." },
  NOT_ABSOLUTE: { exit: 2, hint: "Give the full absolute path, starting with /." },
  GLOB_CHARACTER: { exit: 2, hint: "Wildcard characters are not accepted; name exactly one path." },
  PATH_NOT_NORMAL: { exit: 2, hint: "The path must not contain '..', '.', '//' or a trailing '/'." },
  NOT_JSONL: { exit: 2, hint: "Only a .jsonl file is accepted." },
  NOT_FOUND: { exit: 2, hint: "The file could not be found." },
  STAT_FAILED: { exit: 2, hint: "The file could not be inspected." },
  SYMLINK: { exit: 2, hint: "The final path component is a symbolic link; give the real file." },
  NOT_REGULAR_FILE: { exit: 2, hint: "The path is not a regular file (directories, devices and pipes are refused)." },
  NOT_CANONICAL: { exit: 2, hint: "The path is not in its real form (a parent directory is a symbolic link, or the letter case differs); give the real path." },
  FILE_TOO_LARGE: { exit: 2, hint: "The file is larger than the 64 MiB limit." },
  DB_REQUIRED: { exit: 2, hint: "--db <absolute-db-path> is required; there is no default database." },
  DB_NOT_ABSOLUTE: { exit: 2, hint: "--db must be an absolute path." },
  DB_PATH_INVALID: { exit: 2, hint: "The database path is not acceptable (length, control or wildcard characters, '..', '//', a trailing '/', or a parent that is not a directory)." },
  DB_NOT_CANONICAL: { exit: 2, hint: "The database location is not in its real form (a parent directory is a symbolic link); give the real path." },
  DB_SYMLINK: { exit: 2, hint: "The database path is a symbolic link; give the real file." },
  DB_NOT_FILE: { exit: 2, hint: "The database path exists but is not a regular file." },
  DB_IS_SOURCE: { exit: 2, hint: "The database path is the transcript itself (the same file, possibly under another name)." },
  TOKEN_MISSING: { exit: 2, hint: "--token <token> from the preview is required." },
  TOKEN_MALFORMED: { exit: 2, hint: "The token must be 64 lower-case hexadecimal characters, exactly as printed by the preview." },
  TOKEN_MISMATCH: { exit: 2, hint: "The token is wrong, or the file changed since the preview (path, size, timestamps or identity). Run the preview again." },
  OPEN_FAILED: { exit: 2, hint: "The file could not be opened safely." },
  FILE_CHANGED: { exit: 2, hint: "The opened file does not match what was validated. Run the preview again." },
  FILE_CHANGED_DURING_READ: { exit: 3, hint: "The file changed while it was being read. Nothing was ingested." },
  READ_FAILED: { exit: 3, hint: "The file could not be read. Nothing was ingested." },
  DB_UNUSABLE: { exit: 3, hint: "The database could not be created or opened. Nothing was ingested." },
  INGEST_FAILED: { exit: 3, hint: "The ingest failed and was rolled back. No usage records were written." },
  FACTS_FAILED: { exit: 3, hint: "Writing the event facts failed and the whole run was rolled back. No usage records and no facts were changed by this run." },
  OUTPUT_FAILED: { exit: 3, hint: "The result could not be written to standard output (it may be closed)." },
  CONFIG_USAGE: { exit: 2, hint: "Expected: config-scan --db <absolute-db-path> [--user-root <absolute-dir>] [--project-root <absolute-dir>] (at least one root; each option at most once)." },
  ROOT_REQUIRED: { exit: 2, hint: "Name at least one root with --user-root or --project-root; nothing is searched for." },
  ROOT_NOT_FOUND: { exit: 2, hint: "A selected root could not be found." },
  ROOT_STAT_FAILED: { exit: 2, hint: "A selected root could not be inspected." },
  ROOT_NOT_DIRECTORY: { exit: 2, hint: "A selected root is not a directory." },
  ROOT_SYMLINK: { exit: 2, hint: "A selected root is a symbolic link; give the real directory." },
  ROOT_NOT_CANONICAL: { exit: 2, hint: "A selected root is not in its real form (a parent directory is a symbolic link, or the letter case differs); give the real path." },
  ROOT_DUPLICATE: { exit: 2, hint: "--user-root and --project-root name the same directory." },
  DB_INSIDE_ROOT: { exit: 2, hint: "The database path is inside a selected root; choose a location outside every scanned root." },
  DB_MULTIPLE_LINKS: { exit: 2, hint: "The existing database file has more than one name (hard link); it could be a scanned file. Use a file with a single name." },
  ROOT_CHANGED: { exit: 2, hint: "A selected root changed after it was validated. Nothing was scanned." },
  SCAN_FAILED: { exit: 3, hint: "The configuration scan failed unexpectedly. Nothing was saved." },
  SCAN_INCOMPLETE: { exit: 3, hint: "The scan did not cover every selected root. A history row was recorded; the current snapshot was NOT replaced." },
  SAVE_FAILED: { exit: 3, hint: "Saving the scan failed and was rolled back. No configuration rows were written (a failed history row may have been recorded)." },
  INTERNAL_ERROR: { exit: 3, hint: "An unexpected error occurred. Nothing more is shown on purpose." },
} as const;

export type RejectionCode = keyof typeof REJECTIONS;

/** `afterDbOpen` tells the caller whether the database file may already exist when this error is shown. */
export class CliError extends Error {
  constructor(
    readonly code: RejectionCode,
    readonly afterDbOpen = false,
  ) {
    super(code);
    this.name = "CliError";
  }
}
