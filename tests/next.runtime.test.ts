import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnalysis } from "@/core/analysis";
import { openStore } from "@/core/store";
import { ALL_CANARIES, footprint, populatedDatabase, type Populated } from "./analysis-helpers";
import { buildProduction, get, raw, startServer, type RunningServer } from "./next-server";

const SETUP_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const API_PATHS = [
  "/api/status",
  "/api/usage/summary",
  "/api/usage/models",
  "/api/usage/days",
  "/api/usage/sessions",
  "/api/usage/quality",
  "/api/config/summary",
  "/api/config/findings",
  "/api/recommendations",
  "/api/runs",
  "/api/sources",
];
const PAGED_PATHS = ["/api/usage/models", "/api/usage/days", "/api/usage/sessions", "/api/config/findings", "/api/recommendations", "/api/runs", "/api/sources"];
const PAGE_PATHS = ["/", "/usage", "/config", "/quality", "/recommendations", "/history", "/sources"];

let populated: Populated;
let populatedServer: RunningServer;
let emptyServer: RunningServer;
let missingBase: string;
let missingDatabasePath: string;

beforeAll(async () => {
  buildProduction();
  populated = await populatedDatabase();
  // Not the per-test temp helper: these directories must outlive individual tests and are removed in afterAll.
  missingBase = mkdtempSync(join(tmpdir(), "acc-runtime-"));
  missingDatabasePath = join(missingBase, "app-data", "usage.db");
  populatedServer = await startServer(populated.dbPath);
  emptyServer = await startServer(missingDatabasePath);
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  populatedServer?.stop();
  emptyServer?.stop();
  for (const dir of [populated?.base, missingBase]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("populated synthetic database through the real Next.js runtime", () => {
  it(
    "serves the same values as the analysis layer, with the documented envelope and headers",
    async () => {
      const analysis = createAnalysis(populated.dbPath);
      const summary = await get(populatedServer.port, "/api/usage/summary");
      expect(summary.status).toBe(200);
      expect(summary.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(summary.body)).toEqual(JSON.parse(JSON.stringify(analysis.usageSummary({ sidechain: "include" }))));

      const excluded = await get(populatedServer.port, "/api/usage/summary?sidechain=exclude");
      expect(JSON.parse(excluded.body)).toEqual(JSON.parse(JSON.stringify(analysis.usageSummary({ sidechain: "exclude" }))));

      const body = JSON.parse(summary.body) as { state: string; data: { settled: { records: number }; conflicting: { groups: number }; ambiguous: { records: number } } };
      expect(body.state).toBe("ok");
      expect(body.data.settled.records).toBeGreaterThan(0);
      expect(body.data.conflicting.groups).toBeGreaterThan(0);
      expect(body.data.ambiguous.records).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "serves recommendations that match the analysis layer, cite real findings, and filter without alerts",
    async () => {
      const analysis = createAnalysis(populated.dbPath);
      const response = await get(populatedServer.port, "/api/recommendations?limit=200");
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual(JSON.parse(JSON.stringify(analysis.recommendations({ category: null, priority: null, limit: 200, offset: 0 }))));

      const body = JSON.parse(response.body) as { data: { items: { id: string; evidence: { findingIds: string[] } }[] } };
      const findings = JSON.parse((await get(populatedServer.port, "/api/config/findings?limit=200")).body) as { data: { items: { id: string }[] } };
      const known = new Set(findings.data.items.map((f) => f.id));
      expect(body.data.items.length).toBeGreaterThan(0);
      for (const r of body.data.items) for (const id of r.evidence.findingIds) expect(known.has(id)).toBe(true);

      expect((await get(populatedServer.port, "/api/recommendations?category=savings")).status).toBe(400);
      for (const path of ["/recommendations?category=&priority=", "/recommendations?category=data-quality"]) {
        const page = await get(populatedServer.port, path);
        expect(page.status).toBe(200);
        expect(page.body).not.toContain("filter is not valid");
      }
      expect((await get(populatedServer.port, "/recommendations?priority=urgent")).body).toContain("filter is not valid");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lists days newest first, session ids opaque, and findings with rule versions",
    async () => {
      const days = JSON.parse((await get(populatedServer.port, "/api/usage/days")).body) as { data: { items: { key: string }[] } };
      const keys = days.data.items.map((i) => i.key);
      expect(keys.length).toBeGreaterThan(1);
      expect(keys).toEqual([...keys].sort().reverse());

      const sessions = JSON.parse((await get(populatedServer.port, "/api/usage/sessions")).body) as { data: { items: { id: string | null }[] } };
      for (const s of sessions.data.items) if (s.id !== null) expect(s.id).toMatch(/^[0-9a-f]{16}$/);

      const findings = JSON.parse((await get(populatedServer.port, "/api/config/findings")).body) as { data: { items: { ruleId: string; ruleVersion: number }[]; total: number } };
      expect(findings.data.total).toBeGreaterThan(0);
      for (const f of findings.data.items) expect(f.ruleVersion).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaks no canary, temp path or salt in any API response or page, and leaves the database untouched",
    async () => {
      const before = footprint(populated.dbPath);
      const store = openStore(populated.dbPath);
      const salt = store.salt.toString("hex");
      store.close();
      const afterOpen = footprint(populated.dbPath);

      let text = "";
      for (const path of [...API_PATHS.map((p) => `${p}${PAGED_PATHS.includes(p) ? "?limit=200" : ""}`), ...PAGE_PATHS]) {
        const response = await get(populatedServer.port, path);
        expect(response.status).toBe(200);
        text += response.body;
      }
      for (const canary of ALL_CANARIES) expect(text).not.toContain(canary);
      expect(text).not.toContain(populated.base);
      expect(text).not.toContain(populated.dbPath);
      expect(text).not.toContain(salt);
      expect(text).not.toMatch(/\/private\/var|\/var\/folders|\/Users\//);
      expect(footprint(populated.dbPath)).toEqual(afterOpen);
      expect(afterOpen.siblings).toEqual(before.siblings);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders pages for blank browser-style filters without an invalid-filter alert",
    async () => {
      for (const path of ["/usage?from=&to=", "/usage?sidechain=exclude&from=&to=", "/config?severity=&ruleId="]) {
        const response = await get(populatedServer.port, path);
        expect(response.status).toBe(200);
        expect(response.body).not.toContain("filter is not valid");
      }
      expect((await get(populatedServer.port, "/usage?from=2026-02-30")).body).toContain("filter is not valid");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects every non-GET method without changing state",
    async () => {
      const before = footprint(populated.dbPath);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const path of API_PATHS) expect((await get(populatedServer.port, path, {}, method)).status).toBe(405);
      }
      expect(footprint(populated.dbPath)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Host validation in the production runtime", () => {
  it(
    "accepts the approved local Host forms for pages, APIs and static assets",
    async () => {
      const port = populatedServer.port;
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
        for (const path of ["/", "/api/status"]) expect((await get(port, path, { Host: host })).status).toBe(200);
      }
      const asset = /\/_next\/static\/[^"']+\.css/.exec((await get(port, "/")).body)?.[0];
      expect(asset).toBeDefined();
      expect((await get(port, asset ?? "")).status).toBe(200);
      expect((await get(port, asset ?? "", { Host: "evil.example" })).status).toBe(403);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers an unapproved Host with a bare 403 on pages, APIs and static assets",
    async () => {
      const port = populatedServer.port;
      for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `127.0.0.1:${port}.evil.example`, `localhost.evil.example:${port}`]) {
        for (const path of ["/", "/usage?limit=1", "/api/status", "/api/usage/summary", "/_next/static/chunks/missing.js"]) {
          const response = await get(port, path, { Host: host });
          expect(response.status).toBe(403);
          expect(response.body).toBe("Forbidden");
          expect(response.body).not.toContain("evil");
          expect(String(response.headers["cache-control"])).toBe("no-store");
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores forwarding headers",
    async () => {
      const port = populatedServer.port;
      expect((await get(port, "/api/status", { Host: "evil.example", "X-Forwarded-Host": `127.0.0.1:${port}` })).status).toBe(403);
      expect((await get(port, "/api/status", { "X-Forwarded-Host": "evil.example" })).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never serves a request whose Host is missing, and rejects a bad first Host",
    async () => {
      const port = populatedServer.port;
      const missing11 = await raw(port, "GET /api/status HTTP/1.1\r\nConnection: close\r\n\r\n");
      const missing10 = await raw(port, "GET /api/status HTTP/1.0\r\n\r\n");
      const badFirst = await raw(port, `GET /api/status HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      expect(missing11.status).toBe(400);
      expect(missing10.status).toBe(403);
      expect(badFirst.status).toBe(403);
      for (const result of [missing11, missing10, badFirst]) expect(result.text).not.toContain('"state"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "documents the platform limits: duplicate Host headers collapse to the first value, and absolute-form targets are redirected without data",
    async () => {
      const port = populatedServer.port;
      // Node's HTTP parser keeps only the first Host value, so the application cannot observe a duplicate.
      // The request is therefore judged on that first value (here an approved one). Browsers never send two.
      const goodFirst = await raw(port, `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
      expect(goodFirst.status).toBe(200);

      // Next.js normalizes an absolute-form request target before the proxy runs. It answers with a
      // bodiless redirect, never with data, and browsers do not send this form to an origin server.
      for (const target of [`http://evil.example/api/status`, `http://127.0.0.1:${port}/api/status`]) {
        const result = await raw(port, `GET ${target} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
        expect([308, 400, 403]).toContain(result.status);
        expect(result.text).not.toContain('"state"');
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Host validation for the recommendation API and page", () => {
  const PATHS = ["/api/recommendations", "/api/recommendations?category=data-quality", "/api/recommendations?category=&priority=info", "/recommendations", "/recommendations?category=data-quality&priority=medium"];

  it(
    "rejects an unapproved Host with a bare 403, with or without a forged forwarded host",
    async () => {
      const port = populatedServer.port;
      for (const path of PATHS) {
        const plain = await get(port, path, { Host: "evil.example" });
        const forged = await get(port, path, { Host: "evil.example", "X-Forwarded-Host": `127.0.0.1:${port}` });
        const forgedOther = await get(port, path, { Host: `127.0.0.1:${port + 1}`, "X-Forwarded-Host": `127.0.0.1:${port}`, Forwarded: `host=127.0.0.1:${port}` });
        for (const response of [plain, forged, forgedOther]) {
          expect(response.status).toBe(403);
          expect(response.body).toBe("Forbidden");
          expect(String(response.headers["cache-control"])).toBe("no-store");
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "serves the same paths to the approved local Hosts, and ignores a forged forwarded host on an approved request",
    async () => {
      const port = populatedServer.port;
      for (const path of PATHS) {
        for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) expect((await get(port, path, { Host: host })).status).toBe(200);
        expect((await get(port, path, { "X-Forwarded-Host": "evil.example" })).status).toBe(200);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects an unapproved Host on a missing-database server too, before any data is touched",
    async () => {
      for (const path of PATHS) {
        const response = await get(emptyServer.port, path, { Host: "evil.example" });
        expect(response.status).toBe(403);
        expect(response.body).toBe("Forbidden");
      }
      expect(existsSync(missingDatabasePath)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("missing database through the real runtime", () => {
  it(
    "returns explicit empty states and creates nothing",
    async () => {
      for (const path of API_PATHS) {
        const response = await get(emptyServer.port, path);
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ state: "no-database", data: null, errorCode: "DATABASE_NOT_FOUND" });
      }
      const page = await get(emptyServer.port, "/");
      expect(page.status).toBe(200);
      expect(page.body).toContain("No database yet");
      expect(existsSync(missingDatabasePath)).toBe(false);
      expect(existsSync(join(missingDatabasePath, ".."))).toBe(false);
      expect(readdirSync(missingBase)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
