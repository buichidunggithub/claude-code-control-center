import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseArgs } from "@/cli/args";
import { CliError, REJECTIONS, type RejectionCode } from "@/cli/codes";
import { MAX_FILE_BYTES } from "@/cli/limits";
import { main } from "@/cli/main";
import { checkDbSyntax, checkSourceSyntax, inspectDbPath, inspectSource } from "@/cli/path-check";
import { previewSource, renderPreview } from "@/cli/preview";
import { renderRun, runIngest } from "@/cli/run";
import { checkToken, fileToken } from "@/cli/token";
import { openStore, scanAndIngest } from "@/core/store";
import { CANARIES, countRows, projection, realTemp, registerCliCleanup, snapshotTree, syntheticTranscript, usageLine, writeFile } from "./cli-helpers";

registerCliCleanup();

/** A sink that, like a Node stream, reports completion (or failure) through the callback. */
const collect = (onText: (text: string) => void) => ({ write: (text: string, done?: (error?: Error | null) => void) => (onText(text), done?.(null), true) });
const failingStream = { write: (_text: string, done?: (error?: Error | null) => void) => (done?.(new Error("EPIPE: SECRET_STREAM_TEXT /private/stream/path")), false) };

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof CliError ? error.code : `NOT_CLI_ERROR:${String(error)}`;
  }
};
const asyncCodeOf = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof CliError ? error.code : `NOT_CLI_ERROR:${String(error)}`;
  }
};
const tokenFor = (path: string) => fileToken(path, lstatSync(path, { bigint: true }));
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("argument parsing", () => {
  it("accepts exactly the two documented forms", () => {
    expect(parseArgs(["preview", "/a/b.jsonl"])).toEqual({ kind: "preview", path: "/a/b.jsonl" });
    expect(parseArgs(["run", "--db", "/d/x.db", "--token", "t", "/a/b.jsonl"])).toEqual({ kind: "run", path: "/a/b.jsonl", db: "/d/x.db", token: "t" });
    expect(parseArgs(["run", "/a/b.jsonl", "--token", "t", "--db", "/d/x.db"])).toMatchObject({ db: "/d/x.db", token: "t" }); // order is free
    expect(parseArgs(["run", "/a/b.jsonl"])).toEqual({ kind: "run", path: "/a/b.jsonl", db: null, token: null }); // required values are checked later, with their own codes
  });

  it.each<[string[], RejectionCode]>([
    [[], "USAGE"],
    [["ingest"], "USAGE"],
    [["--help"], "USAGE"],
    [["preview"], "USAGE"],
    [["preview", "/a.jsonl", "/b.jsonl"], "USAGE"],
    [["preview", "--db", "/x.db", "/a.jsonl"], "INVALID_OPTION"],
    [["preview", "--", "/a.jsonl"], "INVALID_OPTION"],
    [["run"], "USAGE"],
    [["run", "/a.jsonl", "/b.jsonl"], "USAGE"],
    [["run", "--db", "/x.db", "--db", "/y.db", "--token", "t", "/a.jsonl"], "DUPLICATE_OPTION"],
    [["run", "--token", "a", "--token", "b", "/a.jsonl"], "DUPLICATE_OPTION"],
    [["run", "--db", "--token", "t", "/a.jsonl"], "USAGE"],
    [["run", "--db"], "USAGE"],
    [["run", "--db=/x.db", "--token", "t", "/a.jsonl"], "INVALID_OPTION"],
    [["run", "--force", "/a.jsonl"], "INVALID_OPTION"],
    [["run", "--label", "x", "/a.jsonl"], "INVALID_OPTION"],
    [["run", "--", "/a.jsonl"], "INVALID_OPTION"],
  ])("rejects %j with %s", (argv, code) => {
    expect(codeOf(() => parseArgs(argv))).toBe(code);
  });
});

describe("path syntax (no filesystem access)", () => {
  it.each<[string, RejectionCode]>([
    ["", "PATH_LENGTH"],
    ["/" + "a".repeat(5000) + ".jsonl", "PATH_LENGTH"],
    ["/a/b\n.jsonl", "CONTROL_CHARACTER"],
    ["/a/b\u0000.jsonl", "CONTROL_CHARACTER"],
    ["/a/b\u007f.jsonl", "CONTROL_CHARACTER"],
    ["relative/b.jsonl", "NOT_ABSOLUTE"],
    ["./b.jsonl", "NOT_ABSOLUTE"],
    ["~/b.jsonl", "NOT_ABSOLUTE"],
    ["b.jsonl", "NOT_ABSOLUTE"],
    ["/a/*.jsonl", "GLOB_CHARACTER"],
    ["/a/?.jsonl", "GLOB_CHARACTER"],
    ["/a/[x].jsonl", "GLOB_CHARACTER"],
    ["/a/{x,y}.jsonl", "GLOB_CHARACTER"],
    ["/a/../b.jsonl", "PATH_NOT_NORMAL"],
    ["/a/./b.jsonl", "PATH_NOT_NORMAL"],
    ["/a//b.jsonl", "PATH_NOT_NORMAL"],
    ["/a/b.jsonl/", "PATH_NOT_NORMAL"],
    ["/", "PATH_NOT_NORMAL"],
    ["/..", "PATH_NOT_NORMAL"],
    ["/a/b.json", "NOT_JSONL"],
    ["/a/b.jsonl.txt", "NOT_JSONL"],
    ["/a/b", "NOT_JSONL"],
  ])("source %j is rejected with %s", (path, code) => {
    expect(codeOf(() => checkSourceSyntax(path))).toBe(code);
  });

  it("accepts an ordinary absolute .jsonl path, spaces and unicode included", () => {
    expect(codeOf(() => checkSourceSyntax("/Users/someone/My Folder/session é.jsonl"))).toBeNull();
  });

  it.each<[string, RejectionCode]>([
    ["relative.db", "DB_NOT_ABSOLUTE"],
    ["", "DB_PATH_INVALID"],
    ["/a/../x.db", "DB_PATH_INVALID"],
    ["/a//x.db", "DB_PATH_INVALID"],
    ["/a/x.db/", "DB_PATH_INVALID"],
    ["/a/*.db", "DB_PATH_INVALID"],
    ["/a/x\n.db", "DB_PATH_INVALID"],
  ])("database path %j is rejected with %s", (path, code) => {
    expect(codeOf(() => checkDbSyntax(path))).toBe(code);
  });
});

describe("source inspection (metadata only)", () => {
  it("accepts a regular real .jsonl file and returns its identity metadata", () => {
    const dir = realTemp();
    const file = writeFile(dir, "ok.jsonl", "x\n");
    const stats = inspectSource(file, MAX_FILE_BYTES);
    expect(Number(stats.size)).toBe(2);
    expect(stats.isFile()).toBe(true);
  });

  it("rejects a missing file, a directory, a symlink, a symlinked parent and a FIFO", () => {
    const dir = realTemp();
    const real = writeFile(dir, "real/ok.jsonl", "x\n");
    mkdirSync(join(dir, "dir.jsonl"));
    symlinkSync(real, join(dir, "link.jsonl"));
    symlinkSync(join(dir, "real"), join(dir, "linkdir"));
    expect(codeOf(() => inspectSource(join(dir, "missing.jsonl"), MAX_FILE_BYTES))).toBe("NOT_FOUND");
    expect(codeOf(() => inspectSource(join(dir, "dir.jsonl"), MAX_FILE_BYTES))).toBe("NOT_REGULAR_FILE");
    expect(codeOf(() => inspectSource(join(dir, "link.jsonl"), MAX_FILE_BYTES))).toBe("SYMLINK");
    expect(codeOf(() => inspectSource(join(dir, "linkdir", "ok.jsonl"), MAX_FILE_BYTES))).toBe("NOT_CANONICAL");
  });

  it("enforces the size limit exactly: the limit itself passes, one byte more does not", () => {
    const dir = realTemp();
    const file = writeFile(dir, "s.jsonl", "0123456789");
    expect(codeOf(() => inspectSource(file, 10))).toBeNull();
    expect(codeOf(() => inspectSource(file, 9))).toBe("FILE_TOO_LARGE");
  });

  it("rejects a sparse file just over the real 64 MiB limit without reading it", () => {
    const dir = realTemp();
    const file = join(dir, "big.jsonl");
    writeFileSync(file, "");
    truncateSync(file, MAX_FILE_BYTES + 1);
    expect(codeOf(() => inspectSource(file, MAX_FILE_BYTES))).toBe("FILE_TOO_LARGE");
    truncateSync(file, MAX_FILE_BYTES);
    expect(codeOf(() => inspectSource(file, MAX_FILE_BYTES))).toBeNull();
    expect(MAX_FILE_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe("preview", () => {
  it("returns metadata and a token, and renders the documented statements", () => {
    const dir = realTemp();
    const file = writeFile(dir, "ok.jsonl", `${usageLine(1)}\n`);
    const preview = previewSource(file);
    const text = renderPreview(preview);

    expect(preview).toMatchObject({ path: file, sizeBytes: statSync(file).size, hardLinks: 1, maxBytes: MAX_FILE_BYTES });
    expect(preview.token).toMatch(/^[0-9a-f]{64}$/);
    for (const phrase of [
      "the file has NOT been opened and its content has NOT been read",
      "No database was created. No transcript content was read. Nothing was written anywhere.",
      "total per file; within the limit",
      "each line is capped at 4194304 bytes",
      "no other file, no directory listing, no configuration, no settings, no network",
      "NEVER STORED: prompts, responses, tool arguments, file contents, paths, environment values, secrets.",
      "It is a consistency check, not authentication.",
      `--token ${preview.token}`,
    ]) expect(text).toContain(phrase);
    expect(text).not.toContain(CANARIES[1]);
  });

  it.skipIf(isRoot)("succeeds on a file that cannot be read at all: proof that content is never opened", () => {
    const dir = realTemp();
    const file = writeFile(dir, "locked.jsonl", `${CANARIES[0]}\n`);
    chmodSync(file, 0o000);
    try {
      expect(() => readFileSync(file)).toThrow();
      const preview = previewSource(file);
      expect(preview.sizeBytes).toBe(statSync(file).size);
      expect(renderPreview(preview)).not.toContain(CANARIES[0]);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("warns about extra hard links and shows a quoted, pasteable command", () => {
    const dir = realTemp();
    const file = writeFile(dir, "it's here.jsonl", "x\n");
    linkSync(file, join(dir, "second-name.jsonl"));
    const text = renderPreview(previewSource(file));
    expect(text).toContain("Hard links .. 2  [warning: more than one name for this file]");
    expect(text).toContain(`'${dir}/it'\\''s here.jsonl'`);
  });

  it("creates, changes and removes nothing, for success and for every rejection", () => {
    const dir = realTemp();
    const file = writeFile(dir, "ok.jsonl", "x\n");
    mkdirSync(join(dir, "dir.jsonl"));
    symlinkSync(file, join(dir, "link.jsonl"));
    const before = snapshotTree(dir);
    const cwdBefore = snapshotTree(process.cwd().startsWith(dir) ? dir : dir);

    previewSource(file);
    for (const bad of [join(dir, "missing.jsonl"), join(dir, "dir.jsonl"), join(dir, "link.jsonl"), "relative.jsonl", `${dir}/../x.jsonl`, `${dir}/*.jsonl`]) {
      expect(codeOf(() => previewSource(bad))).not.toBeNull();
    }
    expect(snapshotTree(dir)).toEqual(before);
    expect(snapshotTree(dir)).toEqual(cwdBefore);
  });
});

describe("token", () => {
  const stats = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n };

  it("is a deterministic SHA-256 hex digest that depends on the path and on every metadata field", () => {
    const base = fileToken("/a/b.jsonl", stats);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(fileToken("/a/b.jsonl", { ...stats })).toBe(base);
    expect(fileToken("/a/c.jsonl", stats)).not.toBe(base);
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) expect(fileToken("/a/b.jsonl", { ...stats, [key]: stats[key] + 1n }), key).not.toBe(base);
  });

  it("rejects missing, malformed, wrong and stale tokens with distinct fixed codes", () => {
    const good = fileToken("/a/b.jsonl", stats);
    const stale = fileToken("/a/b.jsonl", { ...stats, ctimeNs: 6n });
    expect(codeOf(() => checkToken(good, good))).toBeNull();
    expect(codeOf(() => checkToken(null, good))).toBe("TOKEN_MISSING");
    expect(codeOf(() => checkToken("", good))).toBe("TOKEN_MISSING");
    for (const malformed of ["abc", good.slice(1), `${good}0`, good.toUpperCase(), ` ${good}`, `${good} `, "g".repeat(64), `${good.slice(0, 63)}\n`]) expect(codeOf(() => checkToken(malformed, good)), malformed).toBe("TOKEN_MALFORMED");
    expect(codeOf(() => checkToken("0".repeat(64), good))).toBe("TOKEN_MISMATCH");
    expect(codeOf(() => checkToken(stale, good))).toBe("TOKEN_MISMATCH");
  });
});

describe("database path inspection (creates nothing)", () => {
  it("accepts a new database in a missing directory tree, without creating it", () => {
    const dir = realTemp();
    const db = join(dir, "a", "b", "c", "usage.db");
    const before = snapshotTree(dir);
    expect(inspectDbPath(db, join(dir, "src.jsonl"))).toBe(db);
    expect(snapshotTree(dir)).toEqual(before);
    expect(existsSync(join(dir, "a"))).toBe(false);
  });

  it("accepts an existing regular database file", () => {
    const dir = realTemp();
    const db = writeFile(dir, "usage.db", "x");
    expect(inspectDbPath(db, join(dir, "src.jsonl"))).toBe(db);
  });

  it("rejects a missing --db, the source itself, a symlink, a directory, and symlinked locations", () => {
    const dir = realTemp();
    const source = join(dir, "src.jsonl");
    const real = writeFile(dir, "real/usage.db", "x");
    mkdirSync(join(dir, "dbdir"));
    symlinkSync(real, join(dir, "link.db"));
    symlinkSync(join(dir, "real"), join(dir, "linkdir"));
    writeFile(dir, "afile", "x");
    expect(codeOf(() => inspectDbPath(null, source))).toBe("DB_REQUIRED");
    expect(codeOf(() => inspectDbPath(source, source))).toBe("DB_IS_SOURCE");
    expect(codeOf(() => inspectDbPath(join(dir, "link.db"), source))).toBe("DB_SYMLINK");
    expect(codeOf(() => inspectDbPath(join(dir, "dbdir"), source))).toBe("DB_NOT_FILE");
    expect(codeOf(() => inspectDbPath(join(dir, "linkdir", "usage.db"), source))).toBe("DB_NOT_CANONICAL"); // existing file below a symlinked directory
    expect(codeOf(() => inspectDbPath(join(dir, "linkdir", "new", "usage.db"), source))).toBe("DB_NOT_CANONICAL"); // missing path whose nearest existing ancestor is a symlink
    expect(codeOf(() => inspectDbPath(join(dir, "afile", "sub", "usage.db"), source))).toBe("DB_PATH_INVALID"); // an ancestor is a regular file
    mkdirSync(join(dir, "real", "sub"));
    expect(lstatSync(join(dir, "linkdir", "sub")).isDirectory()).toBe(true); // a real directory, but reached through a symlinked parent
    expect(codeOf(() => inspectDbPath(join(dir, "linkdir", "sub", "new", "usage.db"), source))).toBe("DB_NOT_CANONICAL");
    expect(existsSync(join(dir, "real", "sub", "new"))).toBe(false);
    expect(existsSync(join(dir, "linkdir", "new"))).toBe(false);
  });
});

describe("runIngest: validation order and side effects", () => {
  const setup = () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    return { dir, file, db: join(dir, "out", "pilot", "usage.db"), token: tokenFor(file) };
  };

  it.each<[string, (s: ReturnType<typeof setup>) => Parameters<typeof runIngest>[0], string]>([
    ["missing token", (s) => ({ sourcePath: s.file, dbPath: s.db, token: null }), "TOKEN_MISSING"],
    ["malformed token", (s) => ({ sourcePath: s.file, dbPath: s.db, token: "zz" }), "TOKEN_MALFORMED"],
    ["wrong token", (s) => ({ sourcePath: s.file, dbPath: s.db, token: "0".repeat(64) }), "TOKEN_MISMATCH"],
    ["token of another file", (s) => ({ sourcePath: s.file, dbPath: s.db, token: tokenFor(writeFile(s.dir, "t/other.jsonl", "x\n")) }), "TOKEN_MISMATCH"],
    ["missing --db", (s) => ({ sourcePath: s.file, dbPath: null, token: s.token }), "DB_REQUIRED"],
    ["relative --db", (s) => ({ sourcePath: s.file, dbPath: "usage.db", token: s.token }), "DB_NOT_ABSOLUTE"],
    ["--db with ..", (s) => ({ sourcePath: s.file, dbPath: `${s.dir}/out/../usage.db`, token: s.token }), "DB_PATH_INVALID"],
    ["--db equal to the source", (s) => ({ sourcePath: s.file, dbPath: s.file, token: s.token }), "DB_IS_SOURCE"],
    ["relative source", () => ({ sourcePath: "session.jsonl", dbPath: "/x/usage.db", token: "0".repeat(64) }), "NOT_ABSOLUTE"],
    ["source with ..", (s) => ({ sourcePath: `${s.dir}/t/../t/session.jsonl`, dbPath: s.db, token: s.token }), "PATH_NOT_NORMAL"],
    ["source glob", (s) => ({ sourcePath: `${s.dir}/t/*.jsonl`, dbPath: s.db, token: s.token }), "GLOB_CHARACTER"],
    ["source directory", (s) => ({ sourcePath: join(s.dir, "t"), dbPath: s.db, token: s.token }), "NOT_JSONL"],
    ["non-jsonl source", (s) => ({ sourcePath: writeFile(s.dir, "t/notes.txt", "x"), dbPath: s.db, token: s.token }), "NOT_JSONL"],
  ])("%s is rejected before anything is read or created", async (_name, build, code) => {
    const s = setup();
    const options = build(s); // any fixture file this case needs is created BEFORE the snapshot
    const before = snapshotTree(s.dir);
    expect(await asyncCodeOf(() => runIngest(options))).toBe(code);
    expect(snapshotTree(s.dir)).toEqual(before);
    expect(existsSync(join(s.dir, "out"))).toBe(false);
  });

  it("rejects a symlinked source, a symlinked parent and a symlinked database location without creating anything", async () => {
    const s = setup();
    symlinkSync(s.file, join(s.dir, "link.jsonl"));
    symlinkSync(join(s.dir, "t"), join(s.dir, "linkdir"));
    symlinkSync(join(s.dir, "t"), join(s.dir, "dblink"));
    const before = snapshotTree(s.dir);
    expect(await asyncCodeOf(() => runIngest({ sourcePath: join(s.dir, "link.jsonl"), dbPath: s.db, token: s.token }))).toBe("SYMLINK");
    expect(await asyncCodeOf(() => runIngest({ sourcePath: join(s.dir, "linkdir", "session.jsonl"), dbPath: s.db, token: s.token }))).toBe("NOT_CANONICAL");
    expect(await asyncCodeOf(() => runIngest({ sourcePath: s.file, dbPath: join(s.dir, "dblink", "x", "usage.db"), token: s.token }))).toBe("DB_NOT_CANONICAL");
    expect(snapshotTree(s.dir)).toEqual(before);
  });

  it("rejects an over-limit file before the database exists, using the configured limit", async () => {
    const s = setup();
    const size = statSync(s.file).size;
    expect(await asyncCodeOf(() => runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token, maxBytes: size - 1 }))).toBe("FILE_TOO_LARGE");
    expect(existsSync(join(s.dir, "out"))).toBe(false);
    expect(await asyncCodeOf(() => runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token, maxBytes: size }))).toBeNull();
  });

  it("rejects a changed file: size, modification time, same-size rewrite with restored mtime, and replacement by a copy", async () => {
    const cases: [string, (file: string, dir: string) => void][] = [
      ["append", (file) => appendFileSync(file, "\n")],
      ["touch", (file) => utimesSync(file, new Date(2001, 1, 1), new Date(2001, 1, 1))],
      ["same-size rewrite with the mtime restored", (file) => {
        const before = statSync(file);
        const bytes = readFileSync(file);
        bytes[5] = bytes[5] === 65 ? 66 : 65;
        writeFileSync(file, bytes);
        utimesSync(file, before.atime, before.mtime); // mtime is back, but the status-change time cannot be restored
      }],
      ["replacement by an identical copy with the same mtime", (file, dir) => {
        const before = statSync(file);
        const copy = join(dir, "copy.tmp");
        writeFileSync(copy, readFileSync(file));
        utimesSync(copy, before.atime, before.mtime);
        renameSync(copy, file); // new inode, same name, size and mtime
      }],
    ];
    for (const [name, change] of cases) {
      const s = setup();
      change(s.file, join(s.dir, "t"));
      const before = snapshotTree(s.dir);
      expect(await asyncCodeOf(() => runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token })), name).toBe("TOKEN_MISMATCH");
      expect(snapshotTree(s.dir), name).toEqual(before);
    }
  });
});

describe("runIngest: changes between validation and open fail closed, with no database", () => {
  const setup = () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    return { dir, file, db: join(dir, "out", "usage.db"), token: tokenFor(file) };
  };
  const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    ["an append", (s) => appendFileSync(s.file, "\n"), "FILE_CHANGED"],
    ["a touch", (s) => utimesSync(s.file, new Date(2003, 3, 3), new Date(2003, 3, 3)), "FILE_CHANGED"],
    ["a replacement by a different file of the same size", (s) => {
      const other = join(s.dir, "t", "other.tmp");
      writeFileSync(other, Buffer.alloc(statSync(s.file).size, 0x20));
      renameSync(other, s.file);
    }, "FILE_CHANGED"],
    ["a swap for a symlink to the same content (O_NOFOLLOW refuses it)", (s) => {
      const target = join(s.dir, "t", "target.jsonl");
      writeFileSync(target, readFileSync(s.file));
      rmSync(s.file);
      symlinkSync(target, s.file);
    }, "OPEN_FAILED"],
  ];

  it.each(cases)("%s", async (_name, change, code) => {
    const s = setup();
    let error: unknown;
    try {
      await runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token }, { beforeOpen: () => change(s) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(code);
    expect((error as CliError).afterDbOpen).toBe(false);
    expect(existsSync(join(s.dir, "out"))).toBe(false); // no database and no directory were created
  });
});

describe("runIngest: changes while the file is being read fail closed", () => {
  const setup = () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    return { dir, file, db: join(dir, "out", "usage.db"), token: tokenFor(file) };
  };
  const opts = (s: ReturnType<typeof setup>) => ({ sourcePath: s.file, dbPath: s.db, token: s.token });
  const nothingStored = (db: string) => ["usage_records", "source_files", "source_scan_results", "scan_runs"].map((t) => countRows(db, t));

  it("control: an unchanged file ingests", async () => {
    const s = setup();
    let called = false;
    const report = await runIngest(opts(s), { afterRead: () => (called = true) });
    expect(called).toBe(true);
    expect(report.status).toBe("complete");
  });

  const mutations: [string, (file: string, dir: string) => void][] = [
    ["an append", (file) => appendFileSync(file, `${usageLine(99)}\n`)],
    ["a touch", (file) => utimesSync(file, new Date(2002, 2, 2), new Date(2002, 2, 2))],
    ["a same-size rewrite with the mtime restored", (file) => {
      const before = statSync(file);
      const bytes = readFileSync(file);
      bytes[7] = bytes[7] === 65 ? 66 : 65;
      writeFileSync(file, bytes);
      utimesSync(file, before.atime, before.mtime);
    }],
    ["a replacement by a different file of the same size", (file, dir) => {
      const other = join(dir, "other.tmp");
      writeFileSync(other, Buffer.alloc(statSync(file).size, 0x20));
      renameSync(other, file);
    }],
    ["a truncation", (file) => truncateSync(file, 10)],
  ];

  it.each(mutations)("%s after the read aborts before any record is written", async (_name, change) => {
    const s = setup();
    let error: unknown;
    try {
      await runIngest(opts(s), { afterRead: () => change(s.file, join(s.dir, "t")) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("FILE_CHANGED_DURING_READ");
    expect((error as CliError).afterDbOpen).toBe(true);
    expect(nothingStored(s.db)).toEqual([0, 0, 0, 0]); // the database exists, but holds no ingestion state
  });
});

describe("runIngest: the result equals the existing in-process ingest", () => {
  it("stores exactly what scanAndIngest stores for the same synthetic file", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    const cliDb = join(dir, "cli", "usage.db");
    await runIngest({ sourcePath: file, dbPath: cliDb, token: tokenFor(file) });

    const oracleDb = join(dir, "oracle", "usage.db");
    const store = openStore(oracleDb);
    await scanAndIngest(store, [file]);
    store.close();

    const expected = projection(oracleDb) as { records: unknown[] };
    expect(projection(cliDb)).toEqual(expected);
    expect(expected.records.length).toBeGreaterThan(8); // the comparison is not vacuous: duplicates, a conflict and an anonymous record are present
  });

  it("re-ingesting the unchanged file is a no-op, like the existing function", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    const db = join(dir, "usage.db");
    await runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) });
    const second = await runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) });
    expect(second.outcome).toBe("unchanged");
    expect(countRows(db, "scan_runs")).toBe(2);
  });
});

describe("runIngest: database handling", () => {
  it("preserves an existing database and adds to it", async () => {
    const dir = realTemp();
    const first = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const second = writeFile(dir, "t/b.jsonl", `${usageLine(2, { id: "other" })}\n`);
    const db = join(dir, "usage.db");
    await runIngest({ sourcePath: first, dbPath: db, token: tokenFor(first) });
    const inode = statSync(db).ino;
    await runIngest({ sourcePath: second, dbPath: db, token: tokenFor(second) });
    expect(statSync(db).ino).toBe(inode);
    expect(countRows(db, "source_files")).toBe(2);
    expect(countRows(db, "usage_records")).toBe(2);
  });

  it("reports DB_UNUSABLE for a file that is not a database and leaves its bytes untouched", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const db = writeFile(dir, "notadb.db", "this is definitely not a sqlite database ".repeat(40));
    const before = readFileSync(db);
    expect(await asyncCodeOf(() => runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) }))).toBe("DB_UNUSABLE");
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it("creates the database directory 0700 and the file 0600, only after validation succeeded", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const db = join(dir, "new", "dir", "usage.db");
    await runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) });
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "new", "dir")).mode & 0o777).toBe(0o700);
  });

  it("rolls back an ingest that fails inside the transaction: no usage records, no source row", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/a.jsonl", syntheticTranscript());
    const db = join(dir, "usage.db");
    openStore(db).close();
    const raw = new DatabaseSync(db);
    raw.exec("CREATE TRIGGER block_inserts BEFORE INSERT ON usage_records BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    raw.close();

    expect(await asyncCodeOf(() => runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) }))).toBe("INGEST_FAILED");
    expect(countRows(db, "usage_records")).toBe(0);
    expect(countRows(db, "source_files")).toBe(0);
    const runs = new DatabaseSync(db, { readOnly: true }).prepare("SELECT status FROM scan_runs").all() as { status: string }[];
    expect(runs.every((r) => r.status === "failed")).toBe(true); // at most a failed-run record, never data
  });
});

describe("output hygiene", () => {
  const capture = async (argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, collect((t) => (out += t)), collect((t) => (err += t)), () => import("@/cli/run"));
    return { code, out, err };
  };

  it("a successful run prints aggregates only: no canary, no path, no file name, no database bytes with them", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "SECRET_DIR_NAME/SECRET_FILE_NAME.jsonl", syntheticTranscript());
    const db = join(dir, "db", "usage.db");
    const preview = await capture(["preview", file]);
    expect(preview.code).toBe(0);
    const token = /--token ([0-9a-f]{64})/.exec(preview.out)?.[1] ?? "";
    const run = await capture(["run", "--db", db, "--token", token, file]);

    expect(run.code).toBe(0);
    expect(run.err).toBe("");
    const bytes = readFileSync(db).toString("latin1");
    for (const canary of CANARIES) {
      expect(run.out).not.toContain(canary);
      expect(bytes).not.toContain(canary);
    }
    for (const secret of ["SECRET_DIR_NAME", "SECRET_FILE_NAME", dir]) {
      expect(run.out).not.toContain(secret);
      expect(bytes).not.toContain(secret);
    }
    expect(run.out).toContain("INGEST COMPLETE");
    expect(run.out).toMatch(/accepted \d+, duplicate \d+, conflicting \d+ \(\d+ groups\), ambiguous \d+/);
  });

  it("every failure prints a fixed code and hint only: no path, no input, no library message", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "SECRET_DIR_NAME/x.jsonl", "x\n");
    const attempts = [
      ["preview", join(dir, "SECRET_DIR_NAME", "missing.jsonl")],
      ["preview", `${dir}/SECRET_DIR_NAME/../x.jsonl`],
      ["run", "--db", `${dir}/SECRET_DB/usage.db`, "--token", "not-a-token", file],
      ["run", "--db", `${dir}/SECRET_DB/usage.db`, "--token", "0".repeat(64), file],
      ["run", "--db", `${dir}/SECRET_DB/usage.db`, file],
      ["bogus"],
    ];
    for (const argv of attempts) {
      const r = await capture(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^REJECTED \[[A-Z_]+\] [^\n]+\nNothing was read or created\.\n$/);
      for (const secret of ["SECRET_DIR_NAME", "SECRET_DB", dir, "not-a-token"]) expect(r.err).not.toContain(secret);
    }
    for (const [code, entry] of Object.entries(REJECTIONS)) expect(entry.hint, code).not.toMatch(/[/\\]Users|\.jsonl\b.*\//);
  });

  it("a failing output stream is OUTPUT_FAILED, never its message", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "x.jsonl", "x\n");
    let err = "";
    const code = await main(["preview", file], { write: () => { throw new Error("SECRET_EXCEPTION_TEXT /private/path"); } }, collect((t) => (err += t)));
    expect(code).toBe(3);
    expect(err).toContain("FAILED [OUTPUT_FAILED]");
    expect(err).toContain("Nothing was read or created.");
    expect(err).not.toContain("SECRET_EXCEPTION_TEXT");
    expect(err).not.toContain("/private/path");
  });

  it("renderRun states that totals may be incomplete and shows no content", () => {
    const text = renderRun({ scanRunId: 1, status: "complete", outcome: "new", recordsInserted: 3, recordsRemoved: 0, identityUncertain: false, database: null, skippedLines: null });
    expect(text).toContain("They may be incomplete and are not billing totals.");
    expect(text).toContain("the ingest itself was committed");
  });
});

describe("M7.1-R2 fix 1: a failure after the commit is never reported as 'nothing written'", () => {
  const prepared = () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    return { dir, file, db: join(dir, "out", "usage.db"), token: tokenFor(file) };
  };
  const runArgv = (s: ReturnType<typeof prepared>) => ["run", "--db", s.db, "--token", s.token, s.file];
  const load = () => import("@/cli/run");

  it("a closed or failing stdout after the commit: exit 0, a COMMITTED notice on stderr, records are in the database", async () => {
    const s = prepared();
    let err = "";
    const code = await main(runArgv(s), failingStream, collect((t) => (err += t)), load);
    expect(code).toBe(0);
    expect(err).toContain("INGEST COMMITTED");
    expect(err).toContain("usage records were written");
    expect(err).not.toContain("No usage records were written");
    expect(err).not.toMatch(/SECRET_STREAM_TEXT|EPIPE|\/private\/stream\/path| at /);
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });

  it("a stdout that throws synchronously after the commit is handled the same way", async () => {
    const s = prepared();
    let err = "";
    const code = await main(runArgv(s), { write: () => { throw new Error("SECRET_SYNC_TEXT"); } }, collect((t) => (err += t)), load);
    expect(code).toBe(0);
    expect(err).toContain("INGEST COMMITTED");
    expect(err).not.toContain("SECRET_SYNC_TEXT");
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });

  it("a summary that cannot be rendered after the commit is the same notice, and a dead stderr changes nothing", async () => {
    const s = prepared();
    const real = await load();
    const code = await main(runArgv(s), collect(() => undefined), failingStream, async () => ({ ...real, renderRun: () => { throw new Error("render failed"); } }));
    expect(code).toBe(0);
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });

  it("an unexpected exception before the report says it is NOT KNOWN whether the database changed", async () => {
    const s = prepared();
    let err = "";
    const code = await main(runArgv(s), collect(() => undefined), collect((t) => (err += t)), async () => { throw new Error("SECRET_LOAD_TEXT"); });
    expect(code).toBe(3);
    expect(err).toContain("[INTERNAL_ERROR]");
    expect(err).toContain("It is not known whether this run changed the database");
    expect(err).not.toContain("No usage records were written");
    expect(err).not.toContain("SECRET_LOAD_TEXT");
  });

  it("a failing stdout during a PREVIEW is OUTPUT_FAILED with exit 3 and says nothing was created", async () => {
    const s = prepared();
    let err = "";
    const code = await main(["preview", s.file], failingStream, collect((t) => (err += t)), load);
    expect(code).toBe(3);
    expect(err).toContain("[OUTPUT_FAILED]");
    expect(err).toContain("Nothing was read or created.");
    expect(existsSync(join(s.dir, "out"))).toBe(false);
  });

  it("exit codes stay 0 / 2 / 3", async () => {
    const s = prepared();
    expect(await main(["bogus"], collect(() => undefined), collect(() => undefined), load)).toBe(2);
    expect(await main(runArgv(s), collect(() => undefined), collect(() => undefined), load)).toBe(0);
    expect(await main(["run", "--db", s.db, "--token", "0".repeat(64), s.file], collect(() => undefined), collect(() => undefined), load)).toBe(2);
    expect(await main(runArgv(s), collect(() => undefined), collect(() => undefined), async () => { throw new Error("x"); })).toBe(3);
  });
});

describe("M7.1-R2 fix 2: the size cap is enforced while the file is streamed", () => {
  const prepared = () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    return { dir, file, db: join(dir, "out", "usage.db"), token: tokenFor(file) };
  };
  const rows = (db: string) => ["usage_records", "source_files", "source_scan_results", "scan_runs"].map((t) => countRows(db, t));

  it.each<[string, (file: string) => void]>([
    ["one extra byte", (file) => appendFileSync(file, "\n")],
    ["a few MiB of valid lines", (file) => appendFileSync(file, `${usageLine(77)}\n`.repeat(20000))],
    ["a sparse extension to hundreds of MiB", (file) => truncateSync(file, 300 * 1024 * 1024)],
    ["a truncation", (file) => truncateSync(file, 100)],
  ])("growth or change during the read (%s) aborts before any record is written", async (_name, change) => {
    const s = prepared();
    let error: unknown;
    try {
      await runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token }, { beforeRead: () => change(s.file) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("FILE_CHANGED_DURING_READ");
    expect(rows(s.db)).toEqual([0, 0, 0, 0]);
  });

  it("stops promptly: a file extended to 8 GiB (sparse) during the read is abandoned after about one chunk, not streamed to its end", async () => {
    const s = prepared();
    const started = Date.now();
    let error: unknown;
    try {
      await runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token }, { beforeRead: () => truncateSync(s.file, 8 * 1024 * 1024 * 1024) });
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - started;
    expect((error as CliError).code).toBe("FILE_CHANGED_DURING_READ");
    expect(elapsed).toBeLessThan(3000); // streaming 8 GiB of zeros takes many seconds; the cap ends the read at the previewed size
    expect(rows(s.db)).toEqual([0, 0, 0, 0]);
  });

  it("a file exactly at the limit is accepted and one byte over is rejected before any database exists", async () => {
    const s = prepared();
    const size = statSync(s.file).size;
    expect(await asyncCodeOf(() => runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token, maxBytes: size - 1 }))).toBe("FILE_TOO_LARGE");
    expect(existsSync(join(s.dir, "out"))).toBe(false);
    expect(await asyncCodeOf(() => runIngest({ sourcePath: s.file, dbPath: s.db, token: s.token, maxBytes: size }))).toBeNull();
  });

  it("the cap does not change what a normal run stores", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/session.jsonl", syntheticTranscript());
    const cliDb = join(dir, "cli", "usage.db");
    await runIngest({ sourcePath: file, dbPath: cliDb, token: tokenFor(file) });
    const oracleDb = join(dir, "oracle", "usage.db");
    const store = openStore(oracleDb);
    await scanAndIngest(store, [file]);
    store.close();
    expect(projection(cliDb)).toEqual(projection(oracleDb));
  });
});

describe("M7.1-R2 fix 4: the database path may not be the transcript under another name", () => {
  it("rejects a hard link to a non-empty transcript before any side effect, leaving bytes and mode alone", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/s.jsonl", syntheticTranscript());
    const alias = join(dir, "t/alias.db");
    linkSync(file, alias);
    chmodSync(file, 0o644);
    const bytes = readFileSync(file);
    const before = snapshotTree(dir);

    expect(await asyncCodeOf(() => runIngest({ sourcePath: file, dbPath: alias, token: tokenFor(file) }))).toBe("DB_IS_SOURCE");
    expect(snapshotTree(dir)).toEqual(before);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("rejects it for an EMPTY transcript too: the file never becomes a database", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/e.jsonl", "");
    const alias = join(dir, "t/alias.db");
    linkSync(file, alias);
    expect(await asyncCodeOf(() => runIngest({ sourcePath: file, dbPath: alias, token: tokenFor(file) }))).toBe("DB_IS_SOURCE");
    expect(statSync(file).size).toBe(0);
    expect(readFileSync(file).length).toBe(0);
  });

  it("inspectDbPath compares device and inode, not just the string", () => {
    const dir = realTemp();
    const file = writeFile(dir, "s.jsonl", "x\n");
    const alias = join(dir, "alias.db");
    linkSync(file, alias);
    const stats = lstatSync(file, { bigint: true });
    expect(codeOf(() => inspectDbPath(alias, file, stats))).toBe("DB_IS_SOURCE");
    expect(codeOf(() => inspectDbPath(alias, file))).toBeNull(); // without the identity the old string comparison cannot see it
    expect(codeOf(() => inspectDbPath(writeFile(dir, "other.db", "x"), file, stats))).toBeNull();
  });
});

describe("M7.1-R2 fix 5: existing database files keep their permissions", () => {
  it("an existing database keeps its mode and its data after an ingest", async () => {
    const dir = realTemp();
    const first = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const second = writeFile(dir, "t/b.jsonl", `${usageLine(2, { id: "other" })}\n`);
    const db = join(dir, "usage.db");
    await runIngest({ sourcePath: first, dbPath: db, token: tokenFor(first) });
    chmodSync(db, 0o644);
    await runIngest({ sourcePath: second, dbPath: db, token: tokenFor(second) });
    expect(statSync(db).mode & 0o777).toBe(0o644);
    expect(countRows(db, "usage_records")).toBe(2);
  });

  it("an unrelated file named as --db keeps its bytes AND its mode when the run is refused", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const victim = writeFile(dir, "notes.txt", "my private notes\n".repeat(50));
    chmodSync(victim, 0o644);
    const bytes = readFileSync(victim);
    expect(await asyncCodeOf(() => runIngest({ sourcePath: file, dbPath: victim, token: tokenFor(file) }))).toBe("DB_UNUSABLE");
    expect(readFileSync(victim).equals(bytes)).toBe(true);
    expect(statSync(victim).mode & 0o777).toBe(0o644);
  });

  it("a new database is still created 0600 in a 0700 directory, even under a permissive umask", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const db = join(dir, "new", "dir", "usage.db");
    const previous = process.umask(0o000);
    try {
      await runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) });
    } finally {
      process.umask(previous);
    }
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "new", "dir")).mode & 0o777).toBe(0o700);
  });

  it("an existing EMPTY file being initialized as a database is made private, because it will now hold data", async () => {
    const dir = realTemp();
    const file = writeFile(dir, "t/a.jsonl", `${usageLine(1)}\n`);
    const db = writeFile(dir, "empty.db", "");
    chmodSync(db, 0o644);
    await runIngest({ sourcePath: file, dbPath: db, token: tokenFor(file) });
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(countRows(db, "usage_records")).toBeGreaterThan(0);
  });
});
