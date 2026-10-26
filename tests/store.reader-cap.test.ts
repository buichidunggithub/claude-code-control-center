import { chmodSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore, readSource } from "@/core/store";
import { usageLine, realTemp, registerCliCleanup, writeFile } from "./cli-helpers";

registerCliCleanup();

const salted = (dir: string) => openStore(join(dir, "db", "u.db"));
const unixOnly = process.platform === "win32";

describe("readSource maxBytes (additive option; unset behaves as before)", () => {
  it("reads a file of exactly the cap, with the same digest as an uncapped read", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "a.jsonl", `${usageLine(1)}\n${usageLine(2)}\n`);
    const size = statSync(file).size;
    const store = salted(dir);
    const capped = await readSource(store, file, { maxBytes: size });
    const uncapped = await readSource(store, file);
    store.close();

    expect(capped.kind).toBe("ok");
    expect(uncapped.kind).toBe("ok");
    if (capped.kind === "ok" && uncapped.kind === "ok") {
      expect(capped.contentHash).toBe(uncapped.contentHash);
      expect(capped.sizeBytes).toBe(size);
    }
  });

  it("fails a file one byte over the cap, with a fixed read-failure code and no content", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "a.jsonl", `${usageLine(1)}\n`);
    const size = statSync(file).size;
    const store = salted(dir);
    const result = await readSource(store, file, { maxBytes: size - 1 });
    store.close();

    expect(result).toMatchObject({ kind: "failed", errorCode: "READ_ERROR" });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("stops promptly: a 1 GiB sparse file with a 1 MiB cap returns quickly instead of streaming to the end", async () => {
    const dir = realTemp();
    const file = join(dir, "huge.jsonl");
    writeFileSync(file, "");
    truncateSync(file, 1024 * 1024 * 1024);
    const store = salted(dir);
    const started = Date.now();
    const result = await readSource(store, file, { maxBytes: 1024 * 1024 });
    const elapsed = Date.now() - started;
    store.close();

    expect(result).toMatchObject({ kind: "failed", errorCode: "READ_ERROR" });
    expect(elapsed).toBeLessThan(750); // streaming the whole sparse file takes seconds; the cap ends it after about one chunk
  });
});

describe("openStore tightenExistingFile", () => {
  it.skipIf(unixOnly)("false: an existing non-empty file keeps its mode, a new file is 0600 even under umask 000, an empty existing file becomes 0600", () => {
    const dir = realTemp();
    const existing = join(dir, "existing.db");
    openStore(existing).close();
    chmodSync(existing, 0o644);
    openStore(existing, { tightenExistingFile: false }).close();
    expect(statSync(existing).mode & 0o777).toBe(0o644);

    // 0o000 can only add bits; 0o277 strips the owner's write bit at creation, so only the explicit chmod yields a usable 0600 file.
    for (const mask of [0o000, 0o277]) {
      const previous = process.umask(mask);
      try {
        const fresh = join(dir, `fresh-${mask.toString(8)}.db`);
        openStore(fresh, { tightenExistingFile: false }).close();
        expect(statSync(fresh).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previous);
      }
    }

    const empty = writeFile(dir, "empty.db", "");
    chmodSync(empty, 0o644);
    openStore(empty, { tightenExistingFile: false }).close();
    expect(statSync(empty).mode & 0o777).toBe(0o600);
  });

  it.skipIf(unixOnly)("default (M2 behavior) still tightens a loose existing file to 0600", () => {
    const dir = realTemp();
    const db = join(dir, "usage.db");
    openStore(db).close();
    chmodSync(db, 0o644);
    openStore(db).close();
    expect(statSync(db).mode & 0o777).toBe(0o600);
  });

  it.skipIf(unixOnly)("false: a non-database existing file is left byte-for-byte and mode-for-mode as it was", () => {
    const dir = realTemp();
    const file = writeFile(dir, "notes.txt", "private notes\n".repeat(100));
    chmodSync(file, 0o640);
    expect(() => openStore(file, { tightenExistingFile: false })).toThrow();
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });
});
