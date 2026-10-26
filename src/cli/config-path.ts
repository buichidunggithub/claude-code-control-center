import { lstatSync, realpathSync } from "node:fs";
import { isWithin } from "../core/config/safe-fs";
import { CliError } from "./codes";
import { checkPathSyntax, inspectDbPath } from "./path-check";

/**
 * Metadata-only inspection of one selected root: it must be an existing directory, not a symbolic link, and
 * already in its real form (no symlink anywhere in the path). The scanner would accept a symlinked root; this
 * command does not, so the directory that is scanned is exactly the one that was named.
 */
export function inspectRoot(path: string): string {
  checkPathSyntax(path);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    throw new CliError(code === "ENOENT" || code === "ENOTDIR" ? "ROOT_NOT_FOUND" : "ROOT_STAT_FAILED");
  }
  if (stats.isSymbolicLink()) throw new CliError("ROOT_SYMLINK");
  if (!stats.isDirectory()) throw new CliError("ROOT_NOT_DIRECTORY");
  let real: string | null;
  try {
    real = realpathSync.native(path);
  } catch {
    real = null;
  }
  if (real !== path) throw new CliError("ROOT_NOT_CANONICAL");
  return path;
}

/**
 * The database may not live inside a scanned root and may not be a second name for any file: a database inside a
 * root could be a configuration file (an empty `settings.json` would otherwise be initialised as a database),
 * and an existing database with several names could be a hard link to one. Runs before anything is created.
 */
export function inspectConfigDb(db: string | null, roots: readonly string[]): string {
  const checked = inspectDbPath(db, null);
  if (roots.some((root) => isWithin(checked, root))) throw new CliError("DB_INSIDE_ROOT");
  let info;
  try {
    info = lstatSync(checked, { bigint: true });
  } catch {
    return checked; // a new database: nothing to compare
  }
  if (info.nlink > 1n) throw new CliError("DB_MULTIPLE_LINKS");
  return checked;
}
