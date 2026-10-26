import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfigInventory, scanAndIngest } from "@/core/store";
import { projectRoot, scan, userRoot, writeTree } from "./config-helpers";
import { plantConfig, type Populated } from "./analysis-helpers";
import { freshStore, tempDir } from "./store-helpers";

const IDENTICAL_BODY = `${"Shared guidance paragraph used in two places, long enough to be compared. ".repeat(3)}\n`;
const LARGE_BODY = Array.from({ length: 12 }, (_, i) => `Guidance line number ${i} with some distinct words ${i * 7}.`).join("\n");

/** One settled assistant event per line: unique message ids, two models, plain counters. */
export function settledEventsJsonl(count: number, models: readonly [string, string] = ["model-alpha", "model-beta"]): string {
  return (
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-${i}`,
        sessionId: `sess-${i % 4}`,
        timestamp: `2026-03-${String((i % 9) + 1).padStart(2, "0")}T10:00:00.000Z`,
        isSidechain: false,
        message: { id: `msg_${i}`, role: "assistant", model: i % 3 === 0 ? models[1] : models[0], content: [], usage: { input_tokens: 10 + i, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }),
    ).join("\n") + "\n"
  );
}

export interface RichOptions {
  readonly events?: number;
  readonly config?: boolean;
  readonly usage?: boolean;
}

/** Temp database where every recommendation rule can trigger: duplicates, oversized file, 40 settled events, plus the planted conflicts. */
export async function richDatabase(options: RichOptions = {}): Promise<Populated> {
  const { events = 40, config = true, usage = true } = options;
  const base = tempDir();
  const { store, dbPath } = freshStore(base);
  if (usage) {
    const file = join(base, "synthetic-events.jsonl");
    writeFileSync(file, settledEventsJsonl(events));
    await scanAndIngest(store, [file]);
  }
  if (config) {
    const { user, proj } = plantConfig(base);
    writeTree(proj, { ".claude/rules/one.md": IDENTICAL_BODY, ".claude/rules/two.md": IDENTICAL_BODY, "docs/large.md": LARGE_BODY, ".claude/CLAUDE.md": LARGE_BODY });
    saveConfigInventory(store, await scan([userRoot(user), projectRoot(proj)], { limits: { largeLines: 5 } }));
  }
  store.close();
  return { dbPath, base };
}
