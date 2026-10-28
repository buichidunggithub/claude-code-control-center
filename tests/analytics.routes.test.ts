import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as sessionDetail } from "@/app/api/analytics/sessions/detail/route";
import { GET as sessions } from "@/app/api/analytics/sessions/route";
import { GET as summary } from "@/app/api/analytics/summary/route";
import { GET as tools } from "@/app/api/analytics/tools/route";
import { GET as trends } from "@/app/api/analytics/trends/route";
import { proxy } from "@/proxy";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { openStore } from "@/core/store";
import { factsDatabase, sessionRef } from "./analytics-helpers";
import { ALL_CANARIES, databaseAtVersion } from "./analysis-helpers";
import { FACT_CANARIES } from "./facts-helpers";
import { registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const saved = process.env[DATABASE_PATH_ENV];
beforeEach(() => {
  process.env[DATABASE_PATH_ENV] = join(tempDir(), "never-created", "usage.db");
});
afterEach(() => {
  if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
  else process.env[DATABASE_PATH_ENV] = saved;
});

type Handler = (request: Request) => Response;
const call = (handler: Handler, path: string) => handler(new Request(`http://127.0.0.1:3210${path}`));

const ENDPOINTS: readonly [string, Handler][] = [
  ["/api/analytics/summary", summary],
  ["/api/analytics/trends", trends],
  ["/api/analytics/tools", tools],
  ["/api/analytics/sessions", sessions],
  ["/api/analytics/sessions/detail?id=0123456789abcdef", sessionDetail],
];

const pathOf = (endpoint: string) => endpoint.split("?")[0] ?? endpoint;

describe("analytics routes", () => {
  it("answers 200 with a no-database state and creates nothing", async () => {
    const target = process.env[DATABASE_PATH_ENV] ?? "";
    for (const [path, handler] of ENDPOINTS) {
      const response = call(handler, path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
    }
    expect(existsSync(join(target, ".."))).toBe(false);
  });

  it("answers no-completed-scan when the database has no completed scan", async () => {
    const dbPath = join(tempDir(), "empty.db");
    openStore(dbPath).close();
    process.env[DATABASE_PATH_ENV] = dbPath;
    for (const [path, handler] of ENDPOINTS) {
      const response = call(handler, path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "no-completed-scan", data: null, errorCode: null });
    }
  });

  it("answers 503 with a fixed code for an outdated schema", async () => {
    process.env[DATABASE_PATH_ENV] = databaseAtVersion(3);
    for (const [path, handler] of ENDPOINTS) {
      const response = call(handler, path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "unavailable", data: null, errorCode: "SCHEMA_OUTDATED" });
    }
  });

  it("returns the standard envelope and headers, labelled as unverified source structure", async () => {
    const { dbPath, salt } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const detail = `/api/analytics/sessions/detail?id=${sessionRef(salt, "sess-F")}`;
    for (const [path, handler] of [...ENDPOINTS.slice(0, 4), [detail, sessionDetail] as const]) {
      const response = call(handler, path);
      const body = (await response.json()) as { state: string; data: Record<string, unknown> | null; errorCode: unknown };
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Object.keys(body).sort()).toEqual(["data", "errorCode", "state"]);
      expect(body.state).toBe("ok");
      expect(body.data).toMatchObject({ validation: "unverified-source-structure", state: "collected" });
      expect(String(body.data?.["note"])).toMatch(/not yet validated against real Claude Code transcripts/);
      expect(body.data?.["coverage"]).toMatchObject({ sources: 3, collected: 3, complete: true });
    }
  });

  it.each([
    ["/api/analytics/summary", summary, "sidechain=include", "sidechain"],
    ["/api/analytics/summary", summary, "anything=1", "anything"],
    ["/api/analytics/tools", tools, "limit=5", "limit"],
    ["/api/analytics/trends", trends, "limit=201", "limit"],
    ["/api/analytics/trends", trends, "limit=0", "limit"],
    ["/api/analytics/trends", trends, "offset=100001", "offset"],
    ["/api/analytics/trends", trends, "offset=-1", "offset"],
    ["/api/analytics/trends", trends, "from=2026-02-30", "from"],
    ["/api/analytics/trends", trends, "from=2026-05-02&to=2026-05-01", "to"],
    ["/api/analytics/trends", trends, "from=2024-01-01&to=2026-01-01", "to"],
    ["/api/analytics/trends", trends, "sidechain=include", "sidechain"],
    ["/api/analytics/sessions", sessions, "limit=abc", "limit"],
    ["/api/analytics/sessions", sessions, "limit=5&limit=6", "limit"],
    ["/api/analytics/sessions", sessions, "id=0123456789abcdef", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=0123456789ABCDEF", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=0123456789abcde", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=0123456789abcdef0", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=0123456789abcdef&id=0123456789abcdef", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=sess-F", "id"],
    ["/api/analytics/sessions/detail", sessionDetail, "id=0123456789abcdef&limit=999", "limit"],
  ] as const)("rejects %s?%s with 400 naming only `%s`", async (path, handler, query, parameter) => {
    const response = call(handler, `${path}?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ state: "invalid-request", data: null, errorCode: "INVALID_PARAMETER", parameter });
  });

  it("validates before touching the database", async () => {
    // The configured path does not exist; a valid query would answer no-database, an invalid one must not get that far.
    expect((await call(sessions, "/api/analytics/sessions?limit=0").json()) as { state: string }).toMatchObject({ state: "invalid-request" });
  });

  it("exports only GET from every analytics route module", async () => {
    const modules = await Promise.all([
      import("@/app/api/analytics/summary/route"),
      import("@/app/api/analytics/trends/route"),
      import("@/app/api/analytics/tools/route"),
      import("@/app/api/analytics/sessions/route"),
      import("@/app/api/analytics/sessions/detail/route"),
    ]);
    for (const m of modules) expect(Object.keys(m).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))).toEqual(["GET"]);
  });

  it("is subject to the loopback host restriction like every other route", () => {
    for (const [path] of ENDPOINTS) {
      const rejected = proxy(new NextRequest(`http://evil.example${pathOf(path)}`, { headers: { host: "evil.example" } }));
      expect(rejected.status).toBe(403);
      const allowed = proxy(new NextRequest(`http://127.0.0.1:3210${pathOf(path)}`, { headers: { host: "127.0.0.1:3210" } }));
      expect(allowed.status).toBe(200);
    }
  });
});

describe("privacy of analytics responses", () => {
  const SECRETS = (extra: readonly string[]) => [
    ...FACT_CANARIES, ...ALL_CANARIES, "CANARY", "sess-F", "sess-A", "toolu_", "mcp__", "<odd>", "msg_", "secret.txt",
    "a.jsonl", "b.jsonl", "usage-basic", "fingerprint", "tool_id_fp", "session_fp", "source_files", ...extra,
  ];

  it("leaks no canary, path, raw id, tool name outside the allowlist, fingerprint or salt in any response", async () => {
    for (const optIn of [true, false]) {
      const { dbPath, base, salt } = await factsDatabase({ optIn });
      process.env[DATABASE_PATH_ENV] = dbPath;
      const detail = `/api/analytics/sessions/detail?id=${sessionRef(salt, "sess-F")}`;
      const texts = await Promise.all(
        [...ENDPOINTS.slice(0, 4).map(([path, handler]) => [`${path}?limit=200`, handler] as const), [detail, sessionDetail] as const].map(([path, handler]) => call(handler, path).text()),
      );
      for (const text of texts) {
        for (const secret of SECRETS([base, dbPath, salt])) expect(text, secret).not.toContain(secret);
        expect(text).not.toMatch(/\/Users\/|\/private\/var|\/tmp\//);
        // The only hex strings are the 16-character opaque session references.
        for (const hex of text.match(/[0-9a-f]{17,}/g) ?? []) throw new Error(`long hex string in response: ${hex.length} chars`);
      }
    }
  });

  it("exposes session references of exactly 16 hex characters and nothing that can be reversed to an id", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const body = (await call(sessions, "/api/analytics/sessions").json()) as { data: { items: { id: string | null }[] } };
    for (const item of body.data.items) expect(item.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("only ever names tool buckets from the fixed vocabulary", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const body = (await call(tools, "/api/analytics/tools").json()) as { data: { toolCalls: { byBucket: { bucket: string }[] } } };
    expect(body.data.toolCalls.byBucket.map((r) => r.bucket)).toEqual([
      "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "other", "unknown",
    ]);
  });

  it("keeps size states distinguishable in the wire format", async () => {
    const { dbPath } = await factsDatabase();
    process.env[DATABASE_PATH_ENV] = dbPath;
    const body = (await call(summary, "/api/analytics/summary").json()) as { data: { userEvents: { sizeStates: Record<string, number> } } };
    expect(Object.keys(body.data.userEvents.sizeStates)).toEqual(["empty", "xs", "s", "m", "l", "xl", "unsupported", "not-read"]);
    expect(body.data.userEvents.sizeStates).toMatchObject({ empty: 1, unsupported: 7, "not-read": 0 });
  });
});
