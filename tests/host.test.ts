import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT, PORT_ENV, isAllowedHost, resolveAllowedPort } from "@/config/server";
import { proxy } from "@/proxy";

describe("isAllowedHost", () => {
  it.each(["127.0.0.1:3210", "localhost:3210", "LOCALHOST:3210", "Localhost:3210"])("allows %s", (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["127.0.0.1"],
    ["localhost"],
    ["127.0.0.1:3211"],
    ["127.0.0.1:03210"],
    ["127.0.0.1:3210, evil.example"],
    ["evil.example, 127.0.0.1:3210"],
    ["127.0.0.1:3210,127.0.0.1:3210"],
    ["evil.example"],
    ["evil.example:3210"],
    ["127.0.0.1:3210.evil.example"],
    ["localhost.evil.example:3210"],
    ["localhost.:3210"],
    ["user@127.0.0.1:3210"],
    ["127.0.0.1:3210@evil.example"],
    ["127.0.0.1:3210/"],
    [" 127.0.0.1:3210"],
    ["127.0.0.1:3210 "],
    ["[::1]:3210"],
    ["0.0.0.0:3210"],
    ["127.0.0.2:3210"],
    ["127.1:3210"],
    ["2130706433:3210"],
    ["127.0.0.1:3210\r\nX: y"],
  ])("rejects %j", (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });

  it("matches only the configured port", () => {
    expect(isAllowedHost("127.0.0.1:4000", 4000)).toBe(true);
    expect(isAllowedHost("127.0.0.1:3210", 4000)).toBe(false);
  });
});

describe("resolveAllowedPort", () => {
  it("defaults to the pinned port and only accepts a plain valid port override", () => {
    expect(resolveAllowedPort({})).toBe(DEFAULT_PORT);
    expect(resolveAllowedPort({ [PORT_ENV]: "4100" })).toBe(4100);
    for (const bad of ["", "0", "65536", "-1", "3210.5", "abc", "3210 ", "99999999"]) expect(resolveAllowedPort({ [PORT_ENV]: bad })).toBe(DEFAULT_PORT);
  });
});

describe("proxy", () => {
  const saved = process.env[PORT_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[PORT_ENV];
    else process.env[PORT_ENV] = saved;
  });

  const request = (path: string, headers: Record<string, string>) => new NextRequest(`http://127.0.0.1:3210${path}`, { headers });

  it("lets approved local hosts through for pages, APIs and static assets", () => {
    delete process.env[PORT_ENV];
    for (const path of ["/", "/usage", "/api/status", "/_next/static/chunks/app.js"]) {
      for (const host of ["127.0.0.1:3210", "localhost:3210"]) {
        const response = proxy(request(path, { host }));
        expect(response.status).toBe(200);
        expect(response.headers.get("x-middleware-next")).toBe("1");
      }
    }
  });

  it("answers an unapproved Host with a bare 403 that echoes nothing", async () => {
    delete process.env[PORT_ENV];
    for (const host of ["evil.example", "evil.example:3210", "127.0.0.1", "127.0.0.1:3210, evil.example"]) {
      const response = proxy(request("/api/usage/summary?limit=5", { host }));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).toBe("Forbidden");
      expect(body).not.toContain("evil");
    }
  });

  it("rejects a request with no Host header", () => {
    expect(proxy(request("/", {})).status).toBe(403);
  });

  it("does not trust forwarding headers in either direction", () => {
    delete process.env[PORT_ENV];
    const forwarded = { "x-forwarded-host": "127.0.0.1:3210", forwarded: "host=127.0.0.1:3210", "x-original-host": "127.0.0.1:3210", "x-host": "127.0.0.1:3210" };
    expect(proxy(request("/", { host: "evil.example", ...forwarded })).status).toBe(403);
    expect(proxy(request("/", { host: "127.0.0.1:3210", "x-forwarded-host": "evil.example" })).status).toBe(200);
  });

  it("follows the port override", () => {
    process.env[PORT_ENV] = "4100";
    expect(proxy(request("/", { host: "127.0.0.1:4100" })).status).toBe(200);
    expect(proxy(request("/", { host: "127.0.0.1:3210" })).status).toBe(403);
  });

  it("is not narrowed by a matcher, so it covers every request", () => {
    expect(readFileSync("src/proxy.ts", "utf8")).not.toMatch(/export\s+const\s+config\b/);
  });
});
