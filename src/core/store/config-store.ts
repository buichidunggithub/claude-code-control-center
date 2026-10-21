/**
 * Persistence for the configuration inventory.
 *
 * Snapshot semantics: only a COMPLETE scan replaces the current snapshot. Partial and failed scans
 * (an unavailable root) record a history row but never delete the previous snapshot: a root that is
 * missing during a scan is not evidence that its files are gone.
 */
import type { DatabaseSync } from "node:sqlite";
import { isSafeEvidence } from "../config/rules";
import type { ConfigInventory, Evidence } from "../config/types";
import type { Store } from "./database";
import { all, inTransaction, num, one, optNum, optStr, run, sqliteErrorCode, str } from "./sql";

export class ConfigStoreError extends Error {
  constructor(readonly code: string) {
    super(`config store failed (${code})`);
    this.name = "ConfigStoreError";
  }
}

export interface ConfigStoreOptions {
  readonly now?: () => Date;
}

function writeSnapshot(db: DatabaseSync, inventory: ConfigInventory, startedAt: string, now: () => Date): number {
  const unavailable = inventory.roots.filter((r) => r.status === "unavailable").length;
  const skipped = inventory.files.filter((f) => f.status === "skipped").length;
  const replace = inventory.status === "complete";
  const scanId = run(
    db,
    `INSERT INTO config_scans (started_at, finished_at, status, is_current, roots_requested, roots_unavailable, files_inventoried, files_skipped, findings_count)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    startedAt, now().toISOString(), inventory.status, inventory.roots.length, unavailable, inventory.files.length, skipped, inventory.findings.length,
  );
  if (!replace) return scanId;

  const fileIds = new Map<string, number>();
  for (const f of inventory.files) {
    fileIds.set(
      f.sourceId,
      run(
        db,
        `INSERT INTO config_files (scan_id, source_id, fingerprint, scope, category, status, error_code, size_bytes, line_count,
           content_hash, est_tokens, activation, activation_basis, frontmatter_state, import_depth, label, metadata_json, detail_json)
         VALUES (${Array.from({ length: 18 }, () => "?").join(", ")})`,
        scanId, f.sourceId, f.fingerprint, f.scope, f.category, f.status, f.errorCode, f.sizeBytes, f.lineCount,
        f.contentHash, f.estimatedTokens, f.activation, f.activationBasis, f.frontmatterState, f.importDepth, f.label,
        JSON.stringify(f.metadata), JSON.stringify(f.detail ?? {}),
      ),
    );
  }
  for (const edge of inventory.imports) {
    const fileId = fileIds.get(edge.sourceId);
    if (fileId === undefined) throw new ConfigStoreError("UNKNOWN_FILE");
    run(
      db,
      "INSERT INTO config_imports (scan_id, file_id, target_file_id, line_number, status, depth) VALUES (?, ?, ?, ?, ?, ?)",
      scanId, fileId, edge.targetSourceId === null ? null : (fileIds.get(edge.targetSourceId) ?? null), edge.line, edge.status, edge.depth,
    );
  }
  for (const finding of inventory.findings) {
    if (!isSafeEvidence(finding.evidence)) throw new ConfigStoreError("UNSAFE_EVIDENCE");
    run(
      db,
      `INSERT INTO config_findings (scan_id, finding_key, rule_id, severity, confidence, file_id, related_file_id, evidence_json, limitations, recommendation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scanId, finding.key, finding.ruleId, finding.severity, finding.confidence,
      finding.sourceId === null ? null : (fileIds.get(finding.sourceId) ?? null),
      finding.relatedSourceId === null ? null : (fileIds.get(finding.relatedSourceId) ?? null),
      JSON.stringify(finding.evidence), finding.limitations, finding.recommendation,
    );
  }

  // Replace the previous snapshot: children first (foreign keys), history rows stay.
  for (const table of ["config_findings", "config_imports", "config_files"]) run(db, `DELETE FROM ${table} WHERE scan_id <> ?`, scanId);
  run(db, "UPDATE config_scans SET is_current = 0 WHERE id <> ?", scanId);
  run(db, "UPDATE config_scans SET is_current = 1 WHERE id = ?", scanId);
  return scanId;
}

/**
 * Saves one inventory atomically. On any error everything from this call is rolled back, a `failed`
 * history row with an error code is recorded, and a `ConfigStoreError` carrying only that code is thrown.
 */
export function saveConfigInventory(store: Store, inventory: ConfigInventory, options: ConfigStoreOptions = {}): { readonly scanId: number } {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  try {
    return { scanId: inTransaction(store.db, () => writeSnapshot(store.db, inventory, startedAt, now)) };
  } catch (error) {
    const code = error instanceof ConfigStoreError ? error.code : sqliteErrorCode(error, "CONFIG_STORE_ERROR");
    run(
      store.db,
      "INSERT INTO config_scans (started_at, finished_at, status, error_code, roots_requested) VALUES (?, ?, 'failed', ?, ?)",
      startedAt, now().toISOString(), code, inventory.roots.length,
    );
    throw new ConfigStoreError(code);
  }
}

export interface StoredFinding {
  readonly ruleId: string;
  readonly severity: string;
  readonly confidence: string;
  readonly sourceId: string | null;
  readonly relatedSourceId: string | null;
  readonly evidence: Evidence;
  readonly limitations: string;
  readonly recommendation: string;
}

/** Findings of the current snapshot, ordered like a fresh scan (rule id, then key). */
export function listConfigFindings(db: DatabaseSync): StoredFinding[] {
  return all(
    db,
    `SELECT f.*, a.source_id AS src, b.source_id AS rel
       FROM config_findings f
       JOIN config_scans s ON s.id = f.scan_id AND s.is_current = 1
       LEFT JOIN config_files a ON a.id = f.file_id
       LEFT JOIN config_files b ON b.id = f.related_file_id
      ORDER BY f.rule_id, f.finding_key`,
  ).map((r) => ({
    ruleId: str(r, "rule_id"),
    severity: str(r, "severity"),
    confidence: str(r, "confidence"),
    sourceId: optStr(r, "src"),
    relatedSourceId: optStr(r, "rel"),
    evidence: JSON.parse(str(r, "evidence_json")) as Evidence,
    limitations: str(r, "limitations"),
    recommendation: str(r, "recommendation"),
  }));
}

export interface ConfigSummaryRow {
  readonly scope: string;
  readonly category: string;
  readonly files: number;
  readonly skipped: number;
  /** Estimated tokens of files PRESENT on disk. Not a measure of what is loaded. */
  readonly estimatedTokensOnDisk: number;
}

export function configInventorySummary(db: DatabaseSync): ConfigSummaryRow[] {
  return all(
    db,
    `SELECT f.scope, f.category, COUNT(*) AS files, SUM(f.status = 'skipped') AS skipped, COALESCE(SUM(f.est_tokens), 0) AS tokens
       FROM config_files f JOIN config_scans s ON s.id = f.scan_id AND s.is_current = 1
      GROUP BY f.scope, f.category ORDER BY f.scope, f.category`,
  ).map((r) => ({
    scope: str(r, "scope"),
    category: str(r, "category"),
    files: num(r, "files"),
    skipped: num(r, "skipped"),
    estimatedTokensOnDisk: num(r, "tokens"),
  }));
}

export function currentConfigScanId(db: DatabaseSync): number | null {
  const row = one(db, "SELECT id FROM config_scans WHERE is_current = 1");
  return row ? optNum(row, "id") : null;
}
