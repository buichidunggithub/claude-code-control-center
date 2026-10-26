import { describe, expect, it, vi } from "vitest";
import type { ConfigRoot, ScanOptions } from "@/core/config";
import { openStore, saveConfigInventory } from "@/core/store";
import { main } from "@/cli/config-main";
import { createAnalysis } from "@/core/analysis";
import { registerCliCleanup } from "./cli-helpers";
import { configBox, countOf, rows, scanArgs } from "./cli-config-helpers";
import { userRoot } from "./config-helpers";

registerCliCleanup();

const mode = vi.hoisted(() => ({ value: "partial" as "partial" | "failed" }));

// A genuine partial/failed inventory: the real scanner runs, but one extra root (or only a missing root) is added.
vi.mock("@/core/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/core/config")>();
  return {
    ...real,
    scanConfig: (roots: readonly ConfigRoot[], options: ScanOptions) =>
      real.scanConfig(mode.value === "partial" ? [...roots, { kind: "project", dir: "/nonexistent-root-for-test" }] : [{ kind: "project", dir: "/nonexistent-root-for-test" }], options),
  };
});

const sinks = () => {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (target: string[]) => ({ write: (text: string, done?: (e?: Error | null) => void) => (target.push(text), done?.()) });
  return { out, err, o: sink(out), e: sink(err) };
};

/** A complete snapshot saved with the real scanner (the mock only affects the CLI's own call path via the module). */
async function seedSnapshot(dbPath: string, userDir: string): Promise<void> {
  const store = openStore(dbPath);
  const real = await vi.importActual<typeof import("@/core/config")>("@/core/config");
  saveConfigInventory(store, await real.scanConfig([userRoot(userDir)], { salt: store.salt }));
  store.close();
}

describe("a partial or failed scan is recorded as history only and reported as such", () => {
  it.each(["partial", "failed"] as const)("%s scan: exit 3 SCAN_INCOMPLETE, aggregates printed, snapshot not replaced", async (kind) => {
    mode.value = kind;
    const box = configBox();
    await seedSnapshot(box.db, box.user);
    const filesBefore = countOf(box.db, "config_files");
    const s = sinks();

    const code = await main(scanArgs(box), s.o, s.e);

    expect(code).toBe(3);
    expect(s.out.join("")).toContain(`CONFIG SCAN ${kind.toUpperCase()} (aggregate figures only; the current snapshot was NOT replaced)`);
    expect(s.out.join("")).toMatch(/roots \d of \d available/);
    expect(s.err.join("")).toMatch(/^FAILED \[SCAN_INCOMPLETE\] [^\n]+\nA history row was recorded; the current configuration snapshot was not replaced\.\n$/);
    expect(s.out.join("") + s.err.join("")).not.toMatch(/nonexistent-root-for-test|\/Users\/|\n\s+at /);

    expect(countOf(box.db, "config_scans")).toBe(2);
    expect(rows(box.db, "SELECT id, status, is_current FROM config_scans ORDER BY id")).toEqual([
      { id: 1, status: "complete", is_current: 1 },
      { id: 2, status: kind, is_current: 0 },
    ]);
    expect(countOf(box.db, "config_files")).toBe(filesBefore);
    const analysis = createAnalysis(box.db);
    expect(analysis.status().data?.config.latestScan).toMatchObject({ id: 2, status: kind, isCurrent: false });
    expect(analysis.configSummary().state).toBe("ok");
  });
});
