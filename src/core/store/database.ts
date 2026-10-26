import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs";
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

/** "wx" creates the file 0600 and fails if it exists; an existing file is left as it is, except an empty one. */
function createWithoutTouchingExisting(filePath: string): void {
  try {
    closeSync(openSync(filePath, "wx", FILE_MODE));
    chmodSync(filePath, FILE_MODE); // the umask may have removed bits at creation
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
    if (statSync(filePath).size === 0) chmodSync(filePath, FILE_MODE);
  }
}

/**
 * Opens (creating if needed) the database at an ABSOLUTE path, applies migrations and enables
 * foreign keys. A relative path is rejected so nothing can be created in the working directory
 * (which is the repository during development). Nothing happens until this is called.
 */
export interface OpenStoreOptions {
  /**
   * Default true (M2): a database file that already exists is tightened to 0600. Pass false to never change
   * the mode of a file this call did not create: a new file is still created 0600, and an existing EMPTY file
   * (which is being initialized as a database) is set to 0600, but a non-empty existing file keeps its mode.
   */
  readonly tightenExistingFile?: boolean;
}

export function openStore(filePath: string, options: OpenStoreOptions = {}): Store {
  if (!isAbsolute(filePath)) throw new TypeError("database path must be absolute");

  const directory = dirname(filePath);
  const createdDirectory = mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  if (createdDirectory !== undefined) chmodSync(directory, DIRECTORY_MODE);

  // Create with 0600 before SQLite does, so the file is never briefly world-readable.
  if (options.tightenExistingFile ?? true) {
    closeSync(openSync(filePath, "a", FILE_MODE));
    chmodSync(filePath, FILE_MODE);
  } else {
    createWithoutTouchingExisting(filePath);
  }

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
