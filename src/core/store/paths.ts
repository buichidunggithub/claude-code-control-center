import { join } from "node:path";

export const APP_DATA_DIRNAME = "claude-code-control-center";
export const DATABASE_FILENAME = "usage.db";

/**
 * macOS location for application data, outside any repository. Pure: it computes a path and never
 * touches the filesystem; the directory and file are created only by `openStore`.
 */
export function defaultDatabasePath(homeDir: string): string {
  return join(homeDir, "Library", "Application Support", APP_DATA_DIRNAME, DATABASE_FILENAME);
}
