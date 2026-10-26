import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAndIngest, type Store } from "@/core/store";
import { freshStore } from "./store-helpers";

export const PATH_CANARY = "CANARY_SRC_DIR_c3d4";
export const LABEL_CANARY = "CANARY_SRC_LABEL_77aa";
export const FILE_CANARY = "secret-transcript-name";

const line = (id: string): string =>
  JSON.stringify({ type: "assistant", sessionId: "s1", message: { id, model: "claude-x", usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: "2026-03-01T00:00:00.000Z" });

export const lines = (...ids: string[]): string => ids.map((id) => `${line(id)}\n`).join("");

export interface Workspace {
  readonly store: Store;
  readonly dbPath: string;
  /** Writes a synthetic transcript under a directory whose name is a path canary; returns its absolute path. */
  readonly write: (name: string, ids: readonly string[]) => string;
  readonly remove: (path: string) => void;
  readonly ingest: (paths: readonly string[], label?: string) => Promise<void>;
}

export function workspace(): Workspace {
  const { store, dir, dbPath } = freshStore();
  const folder = join(dir, PATH_CANARY);
  mkdirSync(folder, { recursive: true });
  return {
    store,
    dbPath,
    write: (name, ids) => {
      const target = join(folder, `${FILE_CANARY}-${name}.jsonl`);
      writeFileSync(target, lines(...ids));
      return target;
    },
    remove: (path) => rmSync(path),
    ingest: async (paths, label) => {
      await scanAndIngest(store, paths, label === undefined ? {} : { label });
    },
  };
}
