import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations";
import { one, run, str } from "./sql";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;
const SALT_BYTES = 32;

export interface Store {
  readonly db: DatabaseSync;
  /** Local secret mixed into every fingerprint. Never leaves the database file. */
  readonly salt: Buffer;
  close(): void;
}

function loadOrCreateSalt(db: DatabaseSync): Buffer {
  const existing = one(db, "SELECT value FROM meta WHERE key = 'salt'");
  if (existing) return Buffer.from(str(existing, "value"), "hex");
  const salt = randomBytes(SALT_BYTES);
  run(db, "INSERT INTO meta (key, value) VALUES ('salt', ?)", salt.toString("hex"));
  return salt;
}

/**
 * Opens (creating if needed) the database at an ABSOLUTE path, applies migrations and enables
 * foreign keys. A relative path is rejected so nothing can be created in the working directory
 * (which is the repository during development). Nothing happens until this is called.
 */
export function openStore(filePath: string): Store {
  if (!isAbsolute(filePath)) throw new TypeError("database path must be absolute");

  const directory = dirname(filePath);
  const createdDirectory = mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  if (createdDirectory !== undefined) chmodSync(directory, DIRECTORY_MODE);

  // Create with 0600 before SQLite does, so the file is never briefly world-readable.
  closeSync(openSync(filePath, "a", FILE_MODE));
  chmodSync(filePath, FILE_MODE);

  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    migrate(db);
    const salt = loadOrCreateSalt(db);
    return { db, salt, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

export { fingerprint, keyedHash } from "../fingerprint";
