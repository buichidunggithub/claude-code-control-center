import { scanConfig } from "../core/config";
import type { ConfigInventory, ConfigRoot } from "../core/config";
import { openStore, saveConfigInventory, type Store } from "../core/store";
import { CliError } from "./codes";
import { inspectConfigDb, inspectRoot } from "./config-path";

export interface ConfigScanOptions {
  readonly userRoot: string | null;
  readonly projectRoot: string | null;
  readonly dbPath: string | null;
}

/** Test seams only: the command line never sets these. */
export interface ConfigScanHooks {
  /** After validation, immediately before the database is created or opened. */
  readonly beforeOpen?: () => void;
  /** After the database was opened, immediately before the roots are re-checked and scanned. */
  readonly beforeScan?: () => void;
}

export interface ConfigScanReport {
  readonly scanId: number;
  readonly status: ConfigInventory["status"];
  /** True only for a complete scan: partial and failed scans never replace the current snapshot. */
  readonly snapshotReplaced: boolean;
  readonly roots: { readonly requested: number; readonly unavailable: number };
  readonly files: number;
  readonly skippedByCode: Readonly<Record<string, number>>;
  readonly filesByScopeAndCategory: Readonly<Record<string, number>>;
  readonly importsByStatus: Readonly<Record<string, number>>;
  readonly findingsBySeverity: Readonly<Record<string, number>>;
  readonly findingRules: number;
}

function closeQuietly(close: () => void): void {
  try {
    close();
  } catch {
    // the work is finished and every needed check already ran
  }
}

function tally<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[keyOf(item)] = (out[keyOf(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function summarize(scanId: number, inventory: ConfigInventory): ConfigScanReport {
  return {
    scanId,
    status: inventory.status,
    snapshotReplaced: inventory.status === "complete",
    roots: { requested: inventory.roots.length, unavailable: inventory.roots.filter((r) => r.status === "unavailable").length },
    files: inventory.files.length,
    skippedByCode: tally(inventory.files.filter((f) => f.status === "skipped"), (f) => f.errorCode ?? "UNKNOWN"),
    filesByScopeAndCategory: tally(inventory.files, (f) => `${f.scope}/${f.category}`),
    importsByStatus: tally(inventory.imports, (i) => i.status),
    findingsBySeverity: tally(inventory.findings, (f) => f.severity),
    findingRules: new Set(inventory.findings.map((f) => f.ruleId)).size,
  };
}

/**
 * Order is the safety design:
 *  1. validate every root and the database path (metadata only; nothing is created);
 *  2. create/open the database (the scanner needs its local salt);
 *  3. re-check the roots, then run the EXISTING scanner on exactly those roots (static, read-only, never
 *     follows a link out of a root, never executes anything it finds);
 *  4. save with the EXISTING persistence (one transaction). A complete scan replaces the current snapshot;
 *     a partial or failed one only adds a history row.
 * No label is stored, no path is stored or printed, and no transcript is touched.
 */
export async function runConfigScan(options: ConfigScanOptions, hooks: ConfigScanHooks = {}): Promise<ConfigScanReport> {
  const selected: ConfigRoot[] = [
    ...(options.userRoot === null ? [] : [{ kind: "user-config" as const, dir: inspectRoot(options.userRoot) }]),
    ...(options.projectRoot === null ? [] : [{ kind: "project" as const, dir: inspectRoot(options.projectRoot) }]),
  ];
  if (selected.length === 0) throw new CliError("ROOT_REQUIRED");
  if (selected.length === 2 && selected[0]?.dir === selected[1]?.dir) throw new CliError("ROOT_DUPLICATE");
  const dbPath = inspectConfigDb(options.dbPath, selected.map((r) => r.dir));

  hooks.beforeOpen?.();
  let store: Store;
  try {
    store = openStore(dbPath, { tightenExistingFile: false });
  } catch {
    throw new CliError("DB_UNUSABLE", true);
  }
  try {
    hooks.beforeScan?.();
    try {
      for (const root of selected) inspectRoot(root.dir);
    } catch (error) {
      throw error instanceof CliError ? new CliError("ROOT_CHANGED", true) : error;
    }
    let inventory: ConfigInventory;
    try {
      inventory = await scanConfig(selected, { salt: store.salt });
    } catch {
      throw new CliError("SCAN_FAILED", true);
    }
    let scanId: number;
    try {
      scanId = saveConfigInventory(store, inventory).scanId;
    } catch {
      throw new CliError("SAVE_FAILED", true);
    }
    return summarize(scanId, inventory);
  } finally {
    closeQuietly(() => store.close());
  }
}

const list = (counts: Readonly<Record<string, number>>): string =>
  Object.keys(counts).length === 0 ? "none" : Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ");

export function renderConfigScan(r: ConfigScanReport): string {
  const head =
    r.status === "complete"
      ? "CONFIG SCAN COMPLETE (aggregate figures only; no path or content is shown)"
      : `CONFIG SCAN ${r.status.toUpperCase()} (aggregate figures only; the current snapshot was NOT replaced)`;
  return [
    head,
    "",
    `Scan ............ #${r.scanId}, status ${r.status}; roots ${r.roots.requested - r.roots.unavailable} of ${r.roots.requested} available`,
    `Files ........... ${r.files} inventoried (present on disk; not evidence that any is loaded): ${list(r.filesByScopeAndCategory)}`,
    `Skipped ......... ${list(r.skippedByCode)}`,
    `Imports ......... ${list(r.importsByStatus)}`,
    `Findings ........ ${list(r.findingsBySeverity)} (${r.findingRules} rules)`,
    "",
    "Nothing was changed, executed or enabled. Estimated tokens are bytes / 4 and activation is unverified.",
    "",
    "To inspect the results in the dashboard: CLAUDE_CONTROL_DB_PATH=<the --db path you used> pnpm start",
  ].join("\n");
}

