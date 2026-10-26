import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAnalysis } from "@/core/analysis";
import { defaultDatabasePath } from "@/core/store";
import { DATABASE_PATH_ENV, getAnalysis, resolveDatabasePath } from "@/server/analysis";

const sentinel = process.env[DATABASE_PATH_ENV];

afterEach(() => {
  if (sentinel === undefined) delete process.env[DATABASE_PATH_ENV];
  else process.env[DATABASE_PATH_ENV] = sentinel;
});

describe("test isolation from the production database", () => {
  it("starts every test file with a temp, nonexistent database path", () => {
    expect(sentinel).toBeDefined();
    expect(sentinel?.startsWith(tmpdir())).toBe(true);
    expect(existsSync(sentinel ?? "")).toBe(false);
    expect(existsSync(join(sentinel ?? "", ".."))).toBe(false);
    expect(resolveDatabasePath(process.env, homedir())).toBe(sentinel);
  });

  it("serves an empty state from the sentinel and creates nothing", () => {
    expect(getAnalysis().status()).toMatchObject({ state: "no-database" });
    expect(existsSync(join(sentinel ?? "", ".."))).toBe(false);
  });

  it("fails loudly if a test lets the app resolve the real default path", () => {
    delete process.env[DATABASE_PATH_ENV];
    expect(() => getAnalysis()).toThrow(/production default database path/);
    expect(() => defaultDatabasePath(homedir())).toThrow(/production default database path/);
  });

  it("still allows the default-path computation for a fake home", () => {
    delete process.env[DATABASE_PATH_ENV];
    expect(resolveDatabasePath(process.env, "/fake-home")).toBe("/fake-home/Library/Application Support/claude-code-control-center/usage.db");
    expect(createAnalysis("/fake-home/none.db").status().state).toBe("no-database");
  });
});
