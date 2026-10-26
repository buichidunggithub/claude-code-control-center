import { lstatSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "@/cli/codes";
import { fileToken } from "@/cli/token";
import { countRows, realTemp, registerCliCleanup, syntheticTranscript, writeFile } from "./cli-helpers";

registerCliCleanup();

/** The reader is wrapped ONLY to report a different byte count than the file really has. Nothing else changes. */
const reader: { delta: number } = { delta: 0 };
vi.mock("@/core/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/core/store")>();
  return {
    ...real,
    readSource: async (...args: Parameters<typeof real.readSource>) => {
      const input = await real.readSource(...args);
      return input.kind === "ok" && reader.delta !== 0 ? { ...input, sizeBytes: input.sizeBytes + reader.delta } : input;
    },
  };
});
import { runIngest } from "@/cli/run";

const tokenFor = (p: string) => fileToken(p, lstatSync(p, { bigint: true }));

describe("post-read byte-count check (the file's metadata is untouched, so only the byte count can notice)", () => {
  const prepared = () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    return { file, db: join(dir, "out", "usage.db"), token: tokenFor(file) };
  };

  it.each([1, -1, 4096])("a reader that consumed %i bytes more or fewer than the previewed size aborts before any record is written", async (delta) => {
    const s = prepared();
    reader.delta = delta;
    let error: unknown;
    try {
      await runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token });
    } catch (e) {
      error = e;
    } finally {
      reader.delta = 0;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("FILE_CHANGED_DURING_READ");
    expect((error as CliError).afterDbOpen).toBe(true);
    expect(["usage_records", "source_files", "source_scan_results", "scan_runs"].map((t) => countRows(s.db, t))).toEqual([0, 0, 0, 0]);
  });

  it("control: with a matching byte count the same file ingests", async () => {
    const s = prepared();
    reader.delta = 0;
    expect((await runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token })).status).toBe("complete");
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });
});
