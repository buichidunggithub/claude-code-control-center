import type { DatabaseSync } from "node:sqlite";
import { inTransaction, one, num } from "./sql";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const TOKEN_PREFIXES = ["in", "out", "cr", "cc"] as const;

const tokenColumns = TOKEN_PREFIXES.map(
  (p) => `${p}_state TEXT NOT NULL CHECK (${p}_state IN ('missing','null','invalid','value')),
  ${p}_value INTEGER CHECK (${p}_value IS NULL OR ${p}_value >= 0)`,
).join(",\n  ");

const tokenChecks = TOKEN_PREFIXES.map(
  (p) => `CHECK ((${p}_state = 'value') = (${p}_value IS NOT NULL))`,
).join(",\n  ");

/**
 * v1 stores structure only: opaque salted fingerprints, model names, timestamps, counters and
 * their raw states. There is no column for prompts, responses, tool arguments, paths or env values.
 */
const V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  error_code TEXT,
  sources_requested INTEGER NOT NULL DEFAULT 0,
  sources_new INTEGER NOT NULL DEFAULT 0,
  sources_unchanged INTEGER NOT NULL DEFAULT 0,
  sources_appended INTEGER NOT NULL DEFAULT 0,
  sources_modified INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_removed INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE source_files (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  label TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  ended_with_newline INTEGER NOT NULL CHECK (ended_with_newline IN (0,1)),
  first_seen_scan_id INTEGER NOT NULL REFERENCES scan_runs(id),
  last_read_scan_id INTEGER NOT NULL REFERENCES scan_runs(id)
) STRICT;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL CHECK (line_number >= 1),
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('message-id','uuid','none')),
  event_key_fp TEXT,
  session_id INTEGER REFERENCES sessions(id),
  model TEXT,
  event_type TEXT NOT NULL,
  ts TEXT,
  day TEXT,
  is_sidechain INTEGER CHECK (is_sidechain IN (0,1)),
  ${tokenColumns},
  accounting TEXT NOT NULL CHECK (accounting IN ('accepted','duplicate','conflicting','ambiguous')),
  group_size INTEGER NOT NULL CHECK (group_size >= 1),
  UNIQUE (source_file_id, line_number),
  CHECK ((identity_kind = 'none') = (event_key_fp IS NULL)),
  ${tokenChecks}
) STRICT;

CREATE INDEX idx_usage_event_key ON usage_records(event_key_fp) WHERE event_key_fp IS NOT NULL;
CREATE INDEX idx_usage_accounting_day ON usage_records(accounting, day);
CREATE INDEX idx_usage_accounting_model ON usage_records(accounting, model);
CREATE INDEX idx_usage_session ON usage_records(session_id);

CREATE TABLE source_scan_results (
  id INTEGER PRIMARY KEY,
  scan_run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_file_id INTEGER REFERENCES source_files(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('new','unchanged','appended','modified','failed')),
  error_code TEXT,
  anonymous_identity_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (anonymous_identity_uncertain IN (0,1)),
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_removed INTEGER NOT NULL DEFAULT 0,
  records_retained INTEGER NOT NULL DEFAULT 0,
  lines_read INTEGER NOT NULL DEFAULT 0,
  blank_lines INTEGER NOT NULL DEFAULT 0,
  malformed_lines INTEGER NOT NULL DEFAULT 0,
  oversized_lines INTEGER NOT NULL DEFAULT 0,
  non_object_lines INTEGER NOT NULL DEFAULT 0,
  events_without_usage INTEGER NOT NULL DEFAULT 0,
  usage_objects_malformed INTEGER NOT NULL DEFAULT 0,
  unusable_timestamps INTEGER NOT NULL DEFAULT 0,
  missing_session_ids INTEGER NOT NULL DEFAULT 0,
  missing_models INTEGER NOT NULL DEFAULT 0,
  sidechain_records INTEGER NOT NULL DEFAULT 0,
  unrecognized_usage_key_count INTEGER NOT NULL DEFAULT 0,
  usage_records_parsed INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX idx_scan_results_run ON source_scan_results(scan_run_id);
`;


/**
 * v2 adds the configuration inventory. Additive only: no v1 table or column changes. Rows hold salted
 * fingerprints, counts, hashes keyed by the local salt, fixed code words and rule text; never file
 * content, paths, hook commands, env values or permission rules.
 */
const V2 = `
CREATE TABLE config_scans (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete','partial','failed')),
  error_code TEXT,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  roots_requested INTEGER NOT NULL DEFAULT 0,
  roots_unavailable INTEGER NOT NULL DEFAULT 0,
  files_inventoried INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE config_files (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES config_scans(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user','project')),
  category TEXT NOT NULL CHECK (category IN ('claude_md','rule','agent','skill','settings','imported')),
  status TEXT NOT NULL CHECK (status IN ('ok','skipped')),
  error_code TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  content_hash TEXT,
  est_tokens INTEGER NOT NULL CHECK (est_tokens >= 0),
  activation TEXT NOT NULL CHECK (activation IN ('unverified-candidate','conditional','on-demand','import-only','unknown')),
  activation_basis TEXT NOT NULL,
  frontmatter_state TEXT NOT NULL CHECK (frontmatter_state IN ('none','valid','malformed')),
  import_depth INTEGER NOT NULL DEFAULT 0 CHECK (import_depth >= 0),
  label TEXT,
  metadata_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  UNIQUE (scan_id, source_id)
) STRICT;

CREATE TABLE config_imports (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES config_scans(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES config_files(id) ON DELETE CASCADE,
  target_file_id INTEGER REFERENCES config_files(id) ON DELETE SET NULL,
  line_number INTEGER NOT NULL CHECK (line_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('resolved','broken','outside-roots','unresolvable','cycle','too-deep','skipped')),
  depth INTEGER NOT NULL CHECK (depth >= 1)
) STRICT;

CREATE TABLE config_findings (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES config_scans(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  file_id INTEGER REFERENCES config_files(id) ON DELETE CASCADE,
  related_file_id INTEGER REFERENCES config_files(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL,
  limitations TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  UNIQUE (scan_id, finding_key)
) STRICT;

CREATE INDEX idx_config_files_scan ON config_files(scan_id, category);
CREATE INDEX idx_config_findings_scan ON config_findings(scan_id, rule_id);
CREATE INDEX idx_config_imports_scan ON config_imports(scan_id);
`;

/** v3 records which version of a rule produced each finding. Additive: one column, existing rows get 1. */
const V3 = `
ALTER TABLE config_findings ADD COLUMN rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version >= 1);
`;

/**
 * v4 persists privacy-safe event facts, separately from usage accounting. Additive: one column and two tables,
 * no change to any existing table's rows. Rows hold salted fingerprints, positions, timestamps and values from
 * fixed vocabularies; never prompt text, exact lengths, tool names outside the allowlist, tool-use ids, tool
 * arguments or results. The vocabularies below are deliberately spelled out here, not imported, so this
 * historical migration cannot change when the code's allowlist does; widening one needs a new migration.
 *
 * - source_files.facts_version: 0 means the facts of that source were never collected (every source that
 *   existed before v4); a positive value is the facts logic that produced its rows. A collected source with
 *   no events has a positive version and no rows.
 * - source_user_events: one row per source-typed "user" event. This models nothing about prompts or turns.
 *   size_state is 'not-read' (opt-in off), 'unsupported' (read, not supported text) or a coarse bucket.
 * - tool_calls: one row per tool_use block occurrence, duplicates included, so deduplication can be recomputed
 *   across sources. (source_file_id, line_number, block_index) identifies an occurrence within ONE version of a
 *   source and is the only identity of a call with no id. dedup is derived: for each tool_id_fp the occurrence
 *   in the earliest (source fingerprint, line, block) is 'kept' and the rest are 'duplicate'; calls with no id
 *   are always 'kept'.
 * - session_fp is the same salted fingerprint the sessions table uses. It is stored directly, with no foreign
 *   key, so facts can never change what the usage-side sessions table holds.
 */
const V4 = `
ALTER TABLE source_files ADD COLUMN facts_version INTEGER NOT NULL DEFAULT 0 CHECK (facts_version >= 0);

CREATE TABLE source_user_events (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL CHECK (line_number >= 1),
  session_fp TEXT,
  ts TEXT,
  day TEXT,
  is_sidechain INTEGER CHECK (is_sidechain IN (0,1)),
  size_state TEXT NOT NULL CHECK (size_state IN ('empty','xs','s','m','l','xl','unsupported','not-read')),
  UNIQUE (source_file_id, line_number)
) STRICT;

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL CHECK (line_number >= 1),
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  tool_id_fp TEXT,
  tool_bucket TEXT NOT NULL CHECK (tool_bucket IN ('Read','Write','Edit','MultiEdit','NotebookEdit','Bash','Glob','Grep','WebFetch','WebSearch','Task','TodoWrite','other','unknown')),
  session_fp TEXT,
  ts TEXT,
  day TEXT,
  is_sidechain INTEGER CHECK (is_sidechain IN (0,1)),
  dedup TEXT NOT NULL CHECK (dedup IN ('kept','duplicate')),
  dedup_group_size INTEGER NOT NULL CHECK (dedup_group_size >= 1),
  UNIQUE (source_file_id, line_number, block_index),
  CHECK (tool_id_fp IS NOT NULL OR (dedup = 'kept' AND dedup_group_size = 1))
) STRICT;

CREATE INDEX idx_tool_calls_id_fp ON tool_calls(tool_id_fp) WHERE tool_id_fp IS NOT NULL;
CREATE UNIQUE INDEX uq_tool_calls_kept_id ON tool_calls(tool_id_fp) WHERE tool_id_fp IS NOT NULL AND dedup = 'kept';
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", sql: V1 },
  { version: 2, name: "config-inventory", sql: V2 },
  { version: 3, name: "finding-rule-version", sql: V3 },
  { version: 4, name: "event-facts", sql: V4 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export class SchemaVersionError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`database schema version ${found} is newer than supported version ${supported}`);
    this.name = "SchemaVersionError";
  }
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = one(db, "PRAGMA user_version");
  return row ? num(row, "user_version") : 0;
}

/** Applies pending migrations in order, each in its own transaction. Refuses a newer schema. */
export function migrate(db: DatabaseSync): { readonly from: number; readonly to: number } {
  const from = currentSchemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) throw new SchemaVersionError(from, LATEST_SCHEMA_VERSION);
  for (const migration of MIGRATIONS.filter((m) => m.version > from)) {
    inTransaction(db, () => {
      db.exec(migration.sql);
      // The version is a code constant, never external input.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return { from, to: currentSchemaVersion(db) };
}
