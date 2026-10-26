import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { CliError, type RejectionCode } from "./codes";
import { MAX_PATH_CHARS } from "./limits";

const CONTROL = /[\u0000-\u001f\u007f]/;
const GLOB = /[*?[\]{}]/;

/** Shared syntax rules. Pure: no filesystem access. `codes` lets the database path report its own codes. */
function checkSyntax(raw: string, codes: { absolute: RejectionCode; invalid: (reason: "length" | "control" | "glob" | "normal") => RejectionCode }): void {
  if (raw.length === 0 || raw.length > MAX_PATH_CHARS) throw new CliError(codes.invalid("length"));
  if (CONTROL.test(raw)) throw new CliError(codes.invalid("control"));
  if (!raw.startsWith("/")) throw new CliError(codes.absolute);
  if (GLOB.test(raw)) throw new CliError(codes.invalid("glob"));
  if (raw.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")) throw new CliError(codes.invalid("normal"));
}

/** Syntax of any absolute input path (a transcript or a configuration root). Pure: no filesystem access. */
export function checkPathSyntax(raw: string): void {
  checkSyntax(raw, {
    absolute: "NOT_ABSOLUTE",
    invalid: (reason) => (reason === "length" ? "PATH_LENGTH" : reason === "control" ? "CONTROL_CHARACTER" : reason === "glob" ? "GLOB_CHARACTER" : "PATH_NOT_NORMAL"),
  });
}

export function checkSourceSyntax(raw: string): void {
  checkPathSyntax(raw);
  if (!raw.endsWith(".jsonl")) throw new CliError("NOT_JSONL");
}

export function checkDbSyntax(raw: string): void {
  checkSyntax(raw, { absolute: "DB_NOT_ABSOLUTE", invalid: () => "DB_PATH_INVALID" });
}

const lstatOrNull = (path: string, notFound: RejectionCode, failed: RejectionCode, allowMissing: boolean): BigIntStats | null => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      if (allowMissing) return null;
      throw new CliError(notFound);
    }
    throw new CliError(code === "ENOTDIR" && allowMissing ? "DB_PATH_INVALID" : failed);
  }
};

const realOf = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

/**
 * Metadata-only inspection of the transcript path: lstat and realpath, never open or read. Returns the
 * file's identity metadata. The path must already be in its real form: no symlink anywhere in it.
 */
export function inspectSource(path: string, maxBytes: number): BigIntStats {
  checkSourceSyntax(path);
  const stats = lstatOrNull(path, "NOT_FOUND", "STAT_FAILED", false) as BigIntStats;
  if (stats.isSymbolicLink()) throw new CliError("SYMLINK");
  if (!stats.isFile()) throw new CliError("NOT_REGULAR_FILE");
  if (realOf(path) !== path) throw new CliError("NOT_CANONICAL");
  if (stats.size > BigInt(maxBytes)) throw new CliError("FILE_TOO_LARGE");
  return stats;
}

/**
 * Validates the database path without creating anything. When the source's identity is given, a database path
 * that is another name (hard link) for the transcript is rejected, so the transcript can never be opened as a
 * database. An existing database must be a regular, non-symlink
 * file in a real directory. A new one is allowed only where the nearest existing ancestor is a real
 * directory; the missing directories are created later, by `openStore`, after every other check passed.
 */
export function inspectDbPath(db: string | null, sourcePath: string | null, sourceStats?: Pick<BigIntStats, "dev" | "ino">): string {
  if (db === null) throw new CliError("DB_REQUIRED");
  checkDbSyntax(db);
  if (db === sourcePath) throw new CliError("DB_IS_SOURCE");

  const existing = lstatOrNull(db, "DB_PATH_INVALID", "DB_PATH_INVALID", true);
  if (existing !== null) {
    if (existing.isSymbolicLink()) throw new CliError("DB_SYMLINK");
    if (!existing.isFile()) throw new CliError("DB_NOT_FILE");
    // A different name for the same file (a hard link) is the same file: compare identity, not the string.
    if (sourceStats !== undefined && existing.dev === sourceStats.dev && existing.ino === sourceStats.ino) throw new CliError("DB_IS_SOURCE");
    if (realOf(dirname(db)) !== dirname(db)) throw new CliError("DB_NOT_CANONICAL");
    return db;
  }

  let ancestor = dirname(db);
  while (lstatOrNull(ancestor, "DB_PATH_INVALID", "DB_PATH_INVALID", true) === null) ancestor = dirname(ancestor);
  const info = lstatOrNull(ancestor, "DB_PATH_INVALID", "DB_PATH_INVALID", false) as BigIntStats;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CliError(info.isSymbolicLink() ? "DB_NOT_CANONICAL" : "DB_PATH_INVALID");
  if (realOf(ancestor) !== ancestor) throw new CliError("DB_NOT_CANONICAL");
  return db;
}
