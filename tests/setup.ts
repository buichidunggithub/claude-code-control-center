/**
 * Runs before every test file, before any application module is imported.
 *
 * 1. Points the dashboard database at a temp path that does not exist and is never created. Tests that
 *    need data build their own temporary database and set the variable themselves (restoring this value).
 * 2. Makes resolving the production default path (the user's real Application Support directory) throw,
 *    so a test that forgets step 1 fails loudly instead of reading real data.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export const TEST_DATABASE_SENTINEL = join(tmpdir(), `acc-test-sentinel-${process.pid}`, "never-created", "usage.db");
process.env.CLAUDE_CONTROL_DB_PATH = TEST_DATABASE_SENTINEL;

vi.mock("@/core/store/paths", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/core/store/paths")>();
  const { homedir } = await import("node:os");
  const realHome = homedir();
  return {
    ...original,
    defaultDatabasePath: (home: string): string => {
      if (home === realHome) throw new Error("test attempted to resolve the production default database path");
      return original.defaultDatabasePath(home);
    },
  };
});
