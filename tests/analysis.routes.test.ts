import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_PATH_ENV, resolveDatabasePath } from "@/server/analysis";
import { GET as configFindings } from "@/app/api/config/findings/route";
import { GET as recommendations } from "@/app/api/recommendations/route";
import { GET as configSummary } from "@/app/api/config/summary/route";
import { GET as status } from "@/app/api/status/route";
import { GET as usageDays } from "@/app/api/usage/days/route";
import { GET as usageModels } from "@/app/api/usage/models/route";
import { GET as usageQuality } from "@/app/api/usage/quality/route";
import { GET as usageSessions } from "@/app/api/usage/sessions/route";
import { GET as usageSummary } from "@/app/api/usage/summary/route";
import { ALL_CANARIES, databaseAtVersion, populatedDatabase } from "./analysis-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const saved = process.env[DATABASE_PATH_ENV];
beforeEach(() => {
  // Every test points the app at a temp path first; the production location is never consulted.
  process.env[DATABASE_PATH_ENV] = join(tempDir(), "never-created", "usage.db");
});
afterEach(() => {
  if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
  else process.env[DATABASE_PATH_ENV] = saved;
});

const call = (handler: (r: Request) => Response, path: string) => handler(new Request(`http://127.0.0.1:3210${path}`));

const ENDPOINTS: readonly [string, (r: Request) => Response][] = [
  ["/api/status", status],
  ["/api/usage/summary", usageSummary],
  ["/api/usage/models", usageModels],
  ["/api/usage/days", usageDays],
  ["/api/usage/sessions", usageSessions],
  ["/api/usage/quality", usageQuality],
  ["/api/config/summary", configSummary],
  ["/api/config/findings", configFindings],
  ["/api/recommendations", recommendations],
];

describe("API routes", () => {
  it("answers 200 with an explicit no-database state and creates nothing", async () => {
    const target = process.env[DATABASE_PATH_ENV] ?? "";
    for (const [path, handler] of ENDPOINTS) {
      const response = call(handler, path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    }
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("returns the documented envelope and headers for a populated synthetic database", async () => {
    process.env[DATABASE_PATH_ENV] = (await populatedDatabase()).dbPath;
    for (const [path, handler] of ENDPOINTS) {
      const response = call(handler, path);
      const body = (await response.json()) as { state: string; data: unknown; errorCode: unknown };
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Object.keys(body).sort()).toEqual(["data", "errorCode", "state"]);
      expect(body.state).toBe("ok");
      expect(body.errorCode).toBeNull();
      expect(body.data).not.toBeNull();
    }
  });

  it("answers 400 naming only the parameter, before touching the database", async () => {
    for (const [path, handler, query] of [
      ["/api/usage/models", usageModels, "limit=9999"],
      ["/api/usage/days", usageDays, "from=2026-02-30"],
      ["/api/usage/summary", usageSummary, "sidechain=nope"],
      ["/api/config/findings", configFindings, "severity=urgent"],
      ["/api/status", status, "anything=1"],
      ["/api/recommendations", recommendations, "category=savings"],
      ["/api/recommendations", recommendations, "priority=urgent"],
    ] as const) {
      const response = call(handler, `${path}?${query}`);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ state: "invalid-request", data: null, errorCode: "INVALID_PARAMETER" });
      expect(JSON.stringify(body)).not.toContain(query.split("=")[1] ?? "unreachable");
    }
  });

  it("answers 503 with a fixed code when the database is unusable", async () => {
    process.env[DATABASE_PATH_ENV] = databaseAtVersion(2);
    const response = call(usageSummary, "/api/usage/summary");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
  });

  it("exports only GET from every route module", async () => {
    const modules = await Promise.all([
      import("@/app/api/status/route"),
      import("@/app/api/usage/summary/route"),
      import("@/app/api/usage/models/route"),
      import("@/app/api/usage/days/route"),
      import("@/app/api/usage/sessions/route"),
      import("@/app/api/usage/quality/route"),
      import("@/app/api/config/summary/route"),
      import("@/app/api/config/findings/route"),
      import("@/app/api/recommendations/route"),
    ]);
    for (const m of modules) expect(Object.keys(m).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))).toEqual(["GET"]);
  });

  it("has no canary in any response of a populated database", async () => {
    process.env[DATABASE_PATH_ENV] = (await populatedDatabase()).dbPath;
    for (const [path, handler] of ENDPOINTS) {
      const text = await call(handler, `${path}${path.includes("config/findings") || path.includes("usage/") ? "?limit=200" : ""}`).text();
      for (const canary of ALL_CANARIES) expect(text).not.toContain(canary);
    }
  });
});

describe("database path resolution", () => {
  it("is pure: an override wins, otherwise the M2 default under the given home", () => {
    expect(resolveDatabasePath({ [DATABASE_PATH_ENV]: "/tmp/custom/usage.db" }, "/fake-home")).toBe("/tmp/custom/usage.db");
    expect(resolveDatabasePath({}, "/fake-home")).toBe("/fake-home/Library/Application Support/claude-code-control-center/usage.db");
    expect(resolveDatabasePath({ [DATABASE_PATH_ENV]: "" }, "/fake-home")).toContain("/fake-home/");
    expect(existsSync("/fake-home")).toBe(false);
  });
});
