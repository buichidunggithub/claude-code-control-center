import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { parseJsonlFiles, summarizeAccounting } from "@/core/parse";
import { accountingSummary, openStore, type Store } from "@/core/store";
import { fixturePath } from "./helpers";

const tempDirs: string[] = [];
const stores: Store[] = [];

/** Every store and temp dir opened through these helpers is closed and removed after each test. */
export function registerTempStoreCleanup(): void {
  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // already closed by the test
      }
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acc-store-"));
  tempDirs.push(dir);
  return dir;
}

export function freshStore(dir = tempDir()): { store: Store; dir: string; dbPath: string } {
  const dbPath = join(dir, "app-data", "usage.db");
  const store = openStore(dbPath);
  stores.push(store);
  return { store, dir, dbPath };
}

export function copyFixtureTo(dir: string, name: string, as = name): string {
  const target = join(dir, as);
  copyFileSync(fixturePath(name), target);
  return target;
}

export const readText = (path: string): string => readFileSync(path, "utf8");
export const writeText = (path: string, text: string): void => writeFileSync(path, text);

export function count(store: Store, table: string): number {
  const allowed = ["usage_records", "source_files", "sessions", "scan_runs", "source_scan_results"];
  if (!allowed.includes(table)) throw new Error("unexpected table");
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** The oracle: stored aggregates must equal the in-memory M1.1 accounting over the same files. */
export async function expectMatchesParser(store: Store, paths: readonly string[]): Promise<void> {
  const { expect } = await import("vitest");
  const parsed = summarizeAccounting((await parseJsonlFiles(paths)).usageRecords);
  expect(accountingSummary(store.db)).toEqual(parsed);
}

/** Lists database-like files below a root, skipping dependency and VCS directories. */
export function findDatabaseFiles(root: string): string[] {
  const found: string[] = [];
  const skip = new Set(["node_modules", ".git", ".next"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(db|sqlite3?|db-journal|db-wal|db-shm)$/.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found;
}
