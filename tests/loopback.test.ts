import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOPBACK_HOST } from "@/config/server";

const scripts = (
  JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
).scripts;
const serverScripts = Object.entries(scripts).filter(([, cmd]) => /\bnext (dev|start)\b/.test(cmd));

describe("loopback-only server configuration", () => {
  it("pins the host constant to 127.0.0.1", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });

  it("finds the dev and start scripts", () => {
    expect(serverScripts.map(([name]) => name).sort()).toEqual(["dev", "start"]);
  });

  it.each(serverScripts)("script %s binds explicitly to 127.0.0.1", (_name, cmd) => {
    expect(cmd).toMatch(/-H 127\.0\.0\.1\b/);
    expect(cmd).not.toMatch(/0\.0\.0\.0|--hostname\s+(?!127\.0\.0\.1)|-H\s+(?!127\.0\.0\.1)/);
  });

  it("disables Next.js telemetry in every next script", () => {
    for (const cmd of Object.values(scripts).filter((c) => /\bnext (dev|start|build)\b/.test(c))) {
      expect(cmd).toContain("NEXT_TELEMETRY_DISABLED=1");
    }
  });
});
