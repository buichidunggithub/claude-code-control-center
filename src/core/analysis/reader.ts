/**
 * Read-only database access for the analysis API.
 *
 * Never creates, migrates or writes: the file is opened with `readOnly` and a missing file is
 * reported as `no-database`. Every failure is reduced to a fixed code; messages are dropped because
 * they can quote paths or data.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA_VERSION, currentSchemaVersion } from "../store/migrations";
import type { ApiEnvelope, DataState } from "./types";

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const BUSY_TIMEOUT_MS = 2000;

export type SectionGate = "none" | "usage" | "config" | "any";

export class Unavailable extends Error {
  constructor(readonly state: Exclude<DataState, "ok">, readonly code: string) {
    super(code);
    this.name = "Unavailable";
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof Unavailable) return error.code;
  const errcode = typeof error === "object" && error !== null && "errcode" in error ? error.errcode : undefined;
  if (errcode === SQLITE_CORRUPT || errcode === SQLITE_NOTADB) return "DB_CORRUPT";
  return "DB_UNREADABLE";
}

function openReadOnly(databasePath: string): DatabaseSync {
  if (!isAbsolute(databasePath)) throw new Unavailable("unavailable", "INVALID_DATABASE_PATH");
  let info;
  try {
    info = statSync(databasePath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") throw new Unavailable("no-database", "DATABASE_NOT_FOUND");
    throw new Unavailable("unavailable", "DB_UNREADABLE");
  }
  if (!info.isFile()) throw new Unavailable("unavailable", "NOT_A_FILE");

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA query_only = ON");
    const version = currentSchemaVersion(db);
    if (version === 0) throw new Unavailable("unavailable", "NOT_INITIALIZED");
    if (version < LATEST_SCHEMA_VERSION) throw new Unavailable("unavailable", "SCHEMA_OUTDATED");
    if (version > LATEST_SCHEMA_VERSION) throw new Unavailable("unavailable", "SCHEMA_NEWER");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Opens read-only, runs `work`, closes. Returns an envelope; never throws and never leaks messages. */
export function withDatabase<T>(
  databasePath: string,
  gate: SectionGate,
  isReady: (db: DatabaseSync, gate: SectionGate) => boolean,
  work: (db: DatabaseSync) => T,
): ApiEnvelope<T> {
  let db: DatabaseSync;
  try {
    db = openReadOnly(databasePath);
  } catch (error) {
    return { state: error instanceof Unavailable ? error.state : "unavailable", data: null, errorCode: errorCodeOf(error) };
  }
  try {
    if (gate !== "none" && !isReady(db, gate)) return { state: "no-completed-scan", data: null, errorCode: null };
    return { state: "ok", data: work(db), errorCode: null };
  } catch {
    return { state: "unavailable", data: null, errorCode: "QUERY_FAILED" };
  } finally {
    db.close();
  }
}
