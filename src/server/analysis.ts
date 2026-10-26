import { homedir } from "node:os";
import { createAnalysis, type Analysis } from "@/core/analysis";
import { defaultDatabasePath } from "@/core/store";

/** Explicit override for the database location. Must be absolute. */
export const DATABASE_PATH_ENV = "CLAUDE_CONTROL_DB_PATH";

/**
 * Pure path resolution: nothing is read, opened or created here. Without an override the M2 default
 * location is used, and only ever opened read-only (see `analysis/reader.ts`).
 */
export function resolveDatabasePath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env[DATABASE_PATH_ENV];
  // A relative override is passed through on purpose: the reader reports it as INVALID_DATABASE_PATH.
  return override ? override : defaultDatabasePath(home);
}

export const getAnalysis = (): Analysis => createAnalysis(resolveDatabasePath(process.env, homedir()));
