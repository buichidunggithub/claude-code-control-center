import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, scanAndIngest, fingerprint } from "@/core/store";
import { PROMPT_FACTS_A, PROMPT_FACTS_B } from "./facts-helpers";
import { copyFixtureTo, freshStore, tempDir, writeText } from "./store-helpers";
import { fixturePath } from "./helpers";

export const BASIC_FIXTURE = fixturePath("usage-basic.jsonl");

export interface FactsDatabase {
  readonly dbPath: string;
  readonly base: string;
  readonly salt: string;
  readonly a: string;
  readonly b: string;
}

export interface FactsDatabaseOptions {
  readonly optIn?: boolean;
  /** Include usage-basic.jsonl, which also holds usage records and user events on another day. */
  readonly basic?: boolean;
  /** Extra synthetic source files to ingest, as [name, text]. */
  readonly extra?: readonly (readonly [string, string])[];
}

/** A temporary, fully synthetic database with persisted event facts. Never reads a real location. */
export async function factsDatabase(options: FactsDatabaseOptions = {}): Promise<FactsDatabase> {
  const { optIn = true, basic = true, extra = [] } = options;
  const base = tempDir();
  const { store, dbPath } = freshStore(base);
  const a = copyFixtureTo(base, PROMPT_FACTS_A, "a.jsonl");
  const b = copyFixtureTo(base, PROMPT_FACTS_B, "b.jsonl");
  const extras = extra.map(([name, text]) => {
    const path = join(base, name);
    writeText(path, text);
    return path;
  });
  await scanAndIngest(store, [a, b, ...(basic ? [BASIC_FIXTURE] : []), ...extras], { readPromptLength: optIn });
  const salt = store.salt.toString("hex");
  store.close();
  return { dbPath, base, salt, a, b };
}

export const sessionRef = (salt: string, sessionId: string): string =>
  fingerprint(Buffer.from(salt, "hex"), "session", sessionId).slice(0, 16);

/** Runs `work` against a writable handle of a temp database, e.g. to simulate uncollected or tampered facts. */
export function withRawDatabase<T>(dbPath: string, work: (db: DatabaseSync) => T): T {
  const raw = new DatabaseSync(dbPath);
  try {
    return work(raw);
  } finally {
    raw.close();
  }
}

export function saltOf(dbPath: string): string {
  const store = openStore(dbPath);
  try {
    return store.salt.toString("hex");
  } finally {
    store.close();
  }
}

export const jsonLines = (...events: readonly unknown[]): string => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
