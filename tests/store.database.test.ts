import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaVersionError,
  defaultDatabasePath,
  openStore,
  scanAndIngest,
} from "@/core/store";
import { fixturePath } from "./helpers";
import { count, findDatabaseFiles, freshStore, registerTempStoreCleanup, tempDir } from "./store-helpers";

registerTempStoreCleanup();

const unixOnly = process.platform === "win32";

describe("database location", () => {
  it("computes the macOS Application Support path without touching the filesystem", () => {
    const home = tempDir();
    const path = defaultDatabasePath(home);

    expect(path).toBe(join(home, "Library", "Application Support", "claude-code-control-center", "usage.db"));
    expect(readdirSync(home)).toEqual([]);
  });

  it("rejects a relative path so nothing can be created in the working directory", () => {
    expect(() => openStore("usage.db")).toThrow(TypeError);
    expect(findDatabaseFiles(process.cwd())).toEqual([]);
  });

  it("creates no database files inside the repository", () => {
    freshStore();

    expect(findDatabaseFiles(process.cwd())).toEqual([]);
  });
});

describe("creation, migration and permissions", () => {
  it("creates the schema at the latest version with a local salt", () => {
    const { store } = freshStore();
    const version = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];

    expect(version.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["meta", "scan_runs", "source_files", "sessions", "usage_records", "source_scan_results"]),
    );
    expect(store.salt).toHaveLength(32);
  });

  it("has contiguous migration versions starting at 1", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("reopens idempotently with the same salt and no repeated migration", () => {
    const { store, dbPath } = freshStore();
    const salt = store.salt.toString("hex");
    store.close();

    const reopened = openStore(dbPath);
    try {
      expect(reopened.salt.toString("hex")).toBe(salt);
      expect((reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  });

  it("refuses a database written by a newer schema version", () => {
    const { store, dbPath } = freshStore();
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => openStore(dbPath)).toThrow(SchemaVersionError);
  });

  it.skipIf(unixOnly)("creates the directory 0700 and the database file 0600", () => {
    const { dbPath } = freshStore();

    expect(statSync(join(dbPath, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(unixOnly)("tightens a loose database file to 0600 but leaves an existing directory alone", () => {
    const dir = tempDir();
    const dataDir = join(dir, "existing");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const dbPath = join(dataDir, "usage.db");
    openStore(dbPath).close();
    chmodSync(dbPath, 0o644);

    openStore(dbPath).close();

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o755);
  });

  it.skipIf(unixOnly)("leaves no journal or sidecar files after a committed scan", async () => {
    const { store, dbPath } = freshStore();
    await scanAndIngest(store, [fixturePath("usage-basic.jsonl")]);

    expect(readdirSync(join(dbPath, ".."))).toEqual(["usage.db"]);
  });
});

describe("schema constraints", () => {
  it("has no column that could hold prompts, responses, tool arguments, paths or env values", () => {
    const { store } = freshStore();
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const columns = tables.flatMap((t) => (store.db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name));
    // content_hash is a salted change-detection hash of a file, not file content.
    const allowed = new Set(["content_hash"]);

    expect(
      columns.filter((name) => !allowed.has(name) && /(^|_)(prompt|response|content|body|arguments?|paths?|env|message|text)(_|$)/i.test(name)),
    ).toEqual([]);
  });

  it("enforces foreign keys", () => {
    const { store } = freshStore();
    const insert = () =>
      store.db
        .prepare(
          `INSERT INTO usage_records (source_file_id, line_number, identity_kind, event_type, in_state, out_state, cr_state, cc_state, accounting, group_size)
           VALUES (999, 1, 'none', 'assistant', 'missing', 'missing', 'missing', 'missing', 'ambiguous', 1)`,
        )
        .run();

    expect(insert).toThrow();
  });

  it("keeps referential integrity after ingestion and cascades source deletion", async () => {
    const { store } = freshStore();
    await scanAndIngest(store, [fixturePath("usage-basic.jsonl")]);

    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.db.exec("DELETE FROM source_files");
    expect(count(store, "usage_records")).toBe(0);
  });

  it("rejects a token state that disagrees with its value", () => {
    const { store } = freshStore();
    store.db.exec("INSERT INTO scan_runs (started_at, status) VALUES ('t', 'complete')");
    store.db.exec("INSERT INTO source_files (fingerprint, content_hash, size_bytes, ended_with_newline, first_seen_scan_id, last_read_scan_id) VALUES ('f', 'h', 0, 1, 1, 1)");
    const insert = (state: string, value: number | null) =>
      store.db
        .prepare(
          `INSERT INTO usage_records (source_file_id, line_number, identity_kind, event_type, in_state, in_value, out_state, cr_state, cc_state, accounting, group_size)
           VALUES (1, 1, 'none', 'assistant', ?, ?, 'missing', 'missing', 'missing', 'ambiguous', 1)`,
        )
        .run(state, value);

    expect(() => insert("missing", 5)).toThrow();
    expect(() => insert("value", null)).toThrow();
    expect(() => insert("value", -1)).toThrow();
    expect(() => insert("value", 0)).not.toThrow();
  });
});
