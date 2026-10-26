import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A temp directory in its REAL form (macOS temp paths contain a symlink, which the command rejects). */
export function realTemp(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cli-test-"));
  dirs.push(dir);
  return dir;
}

export function registerCliCleanup(): void {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}

export const CANARIES = ["CANARY_PROMPT_c1a0", "CANARY_RESPONSE_c2b1", "CANARY_TOOLARG_c3d2", "CANARY_SECRET_c4e3"] as const;

export function usageLine(i: number, over: { id?: string | null; model?: string; text?: string } = {}): string {
  return JSON.stringify({
    type: "assistant",
    ...(over.id === null ? {} : { uuid: `u-${i}` }),
    sessionId: "sess-1",
    timestamp: `2026-03-0${(i % 3) + 1}T10:00:00.000Z`,
    isSidechain: i % 5 === 0,
    message: {
      ...(over.id === null ? {} : { id: over.id ?? `m${i}` }),
      role: "assistant",
      model: over.model ?? "model-alpha",
      content: [{ type: "text", text: over.text ?? `${CANARIES[1]} response` }, { type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/x/${CANARIES[2]}`, token: CANARIES[3] } }],
      usage: { input_tokens: 10 + i, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    },
  });
}

/** A synthetic transcript: prompts, responses and tool arguments carry canaries, one identity group conflicts, one record is anonymous. */
export function syntheticTranscript(): string {
  const rows = [
    JSON.stringify({ type: "user", uuid: "u0", sessionId: "sess-1", timestamp: "2026-03-01T09:59:00.000Z", message: { role: "user", content: `${CANARIES[0]} please do things` } }),
    ...Array.from({ length: 6 }, (_, i) => usageLine(i + 1)),
    usageLine(2), // identical repeat of message m2: a duplicate
    usageLine(20, { id: "c" }),
    JSON.stringify({ ...JSON.parse(usageLine(21, { id: "c" })), message: { ...JSON.parse(usageLine(21, { id: "c" })).message, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    usageLine(30, { id: null }),
    "{ this line is not json",
    "[1, 2, 3]",
    "   ",
  ];
  return `${rows.join("\n")}\n`;
}

export function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Every entry below `root` with identity, size, mode and times: equal snapshots mean nothing was created, changed or removed. */
export function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const s = lstatSync(path);
      out.push(`${path.slice(root.length)}|${s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : "f"}|${s.ino}|${s.size}|${s.mode & 0o7777}|${s.mtimeMs}`);
      if (s.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

/** Salt-independent content of a database, so two independently created databases can be compared. */
export function projection(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = (sql: string) => db.prepare(sql).all();
    return {
      records: rows(`SELECT line_number, identity_kind, model, event_type, ts, day, is_sidechain, in_state, in_value, out_state, out_value, cr_state, cr_value, cc_state, cc_value, accounting, group_size FROM usage_records ORDER BY line_number`),
      runs: rows(`SELECT status, error_code, sources_requested, sources_new, sources_unchanged, sources_appended, sources_modified, sources_failed, records_inserted, records_removed FROM scan_runs ORDER BY id`),
      sources: rows(`SELECT size_bytes, ended_with_newline, label FROM source_files ORDER BY id`),
      results: rows(`SELECT outcome, error_code, anonymous_identity_uncertain, records_inserted, records_removed, records_retained, lines_read, blank_lines, malformed_lines, oversized_lines, non_object_lines, events_without_usage, usage_objects_malformed, unusable_timestamps, missing_session_ids, missing_models, sidechain_records, unrecognized_usage_key_count, usage_records_parsed FROM source_scan_results ORDER BY id`),
      sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}

export const countRows = (dbPath: string, table: string): number => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};
