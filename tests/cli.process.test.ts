import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openStore, scanAndIngest } from "@/core/store";
import { CANARIES, countRows, projection, realTemp, registerCliCleanup, snapshotTree, syntheticTranscript, writeFile } from "./cli-helpers";

registerCliCleanup();

const ROOT = resolve(".");
const CLI = join(ROOT, ".cli-build", "cli", "main.js");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");
const BUILD_TIMEOUT_MS = 120_000;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the compiled CLI under plain Node with a scrubbed environment and an isolated working directory and HOME. */
function cli(args: string[], sandbox: { cwd: string; home: string }, extraEnv: Record<string, string> = {}): Result {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    cwd: sandbox.cwd,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: sandbox.home, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sandbox() {
  const root = realTemp();
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  const data = join(root, "data");
  for (const d of [cwd, home, data]) mkdirSync(d);
  const file = writeFile(data, "SECRET_DIR_NAME/SECRET_FILE_NAME.jsonl", syntheticTranscript());
  return { root, cwd, home, data, file, db: join(root, "out", "pilot", "usage.db") };
}

const tokenOf = (stdout: string): string => /--token ([0-9a-f]{64})/.exec(stdout)?.[1] ?? "";

beforeAll(() => {
  const build = spawnSync(TSC, ["-p", "tsconfig.cli.json"], { cwd: ROOT, encoding: "utf8", timeout: BUILD_TIMEOUT_MS });
  if (build.status !== 0) throw new Error(`cli build failed: ${build.stdout}${build.stderr}`);
}, BUILD_TIMEOUT_MS + 5000);

describe("build and packaging", () => {
  it("emits plain CommonJS that needs no Next.js, React or alias at runtime", () => {
    expect(existsSync(CLI)).toBe(true);
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".js") && files.push(join(dir, e.name))));
    walk(join(ROOT, ".cli-build"));
    expect(files.length).toBeGreaterThan(10);
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).not.toMatch(/require\("(next|react|@\/)/);
    expect(all).not.toMatch(/from "@\//);
    expect(files.every((f) => !f.includes(`${join(ROOT, ".cli-build")}/app`))).toBe(true);
  });

  it("is wired into package scripts, git and eslint ignores, with no new dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["cli:build"]).toBe("tsc -p tsconfig.cli.json");
    expect(pkg.scripts["ingest"]).toBe("tsc -p tsconfig.cli.json && node --no-warnings .cli-build/cli/main.js");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["class-variance-authority", "clsx", "lucide-react", "next", "react", "react-dom", "tailwind-merge"]);
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toContain(".cli-build/");
    expect(readFileSync(join(ROOT, "eslint.config.mjs"), "utf8")).toContain(".cli-build/**");
  });
});

describe("preview, as a real process", () => {
  it("prints the documented preview, creates nothing anywhere, and never loads the database module", () => {
    const s = sandbox();
    const before = [snapshotTree(s.root)];
    const r = cli(["preview", s.file], s);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("PREVIEW (metadata only");
    expect(r.stdout).toContain("No database was created. No transcript content was read. Nothing was written anywhere.");
    expect(r.stdout).toContain(s.file);
    expect(r.stdout).toContain("67108864 bytes (64.0 MiB) total per file");
    expect(tokenOf(r.stdout)).toMatch(/^[0-9a-f]{64}$/);
    for (const canary of CANARIES) expect(r.stdout).not.toContain(canary);
    expect(snapshotTree(s.root)).toEqual(before[0]);

    const probe = spawnSync(process.execPath, ["-e", `const m=require(${JSON.stringify(CLI)});m.main(["preview",${JSON.stringify(s.file)}],{write(t,d){d&&d()}},{write(t,d){d&&d()}}).then(()=>console.log(process.moduleLoadList.some(x=>/sqlite/i.test(x))))`], { cwd: s.cwd, encoding: "utf8" });
    expect(probe.stdout.trim()).toBe("false");
  });

  it.skipIf(isRoot)("succeeds on an unreadable file, so the content is provably not opened", () => {
    const s = sandbox();
    spawnSync("chmod", ["000", s.file]);
    try {
      expect(cli(["preview", s.file], s).status).toBe(0);
    } finally {
      spawnSync("chmod", ["600", s.file]);
    }
  });

  it.each([
    [["preview"], "USAGE"],
    [["preview", "relative.jsonl"], "NOT_ABSOLUTE"],
    [["preview", "/x/../y.jsonl"], "PATH_NOT_NORMAL"],
    [["preview", "/x/*.jsonl"], "GLOB_CHARACTER"],
    [["preview", "/x/y.txt"], "NOT_JSONL"],
    [["preview", "/nonexistent/dir/y.jsonl"], "NOT_FOUND"],
    [["preview", "--db", "/x.db", "/x/y.jsonl"], "INVALID_OPTION"],
    [["preview", "/a.jsonl", "/b.jsonl"], "USAGE"],
    [["unknown"], "USAGE"],
    [[], "USAGE"],
  ] as [string[], string][])("rejects %j with %s and no side effects", (args, code) => {
    const s = sandbox();
    const before = snapshotTree(s.root);
    const r = cli(args, s);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`^REJECTED \\[${code}\\] [^\\n]+\\nNothing was read or created\\.\\n$`));
    expect(snapshotTree(s.root)).toEqual(before);
  });

  it("rejects a directory, a symlink, a symlinked parent and an over-limit file", () => {
    const s = sandbox();
    mkdirSync(join(s.data, "dir.jsonl"));
    writeFileSync(join(s.data, "big.jsonl"), "");
    truncateSync(join(s.data, "big.jsonl"), 64 * 1024 * 1024 + 1);
    spawnSync("ln", ["-s", s.file, join(s.data, "link.jsonl")]);
    spawnSync("ln", ["-s", join(s.data, "SECRET_DIR_NAME"), join(s.data, "linkdir")]);
    const before = snapshotTree(s.root);
    const expected: [string, string][] = [
      [join(s.data, "dir.jsonl"), "NOT_REGULAR_FILE"],
      [join(s.data, "link.jsonl"), "SYMLINK"],
      [join(s.data, "linkdir", "SECRET_FILE_NAME.jsonl"), "NOT_CANONICAL"],
      [join(s.data, "big.jsonl"), "FILE_TOO_LARGE"],
    ];
    for (const [path, code] of expected) {
      const r = cli(["preview", path], s);
      expect(r.status, path).toBe(2);
      expect(r.stderr).toContain(`[${code}]`);
      expect(r.stderr).not.toContain("SECRET_");
    }
    expect(snapshotTree(s.root)).toEqual(before);
  });
});

describe("run, as a real process", () => {
  const prepare = () => {
    const s = sandbox();
    const preview = cli(["preview", s.file], s);
    return { s, token: tokenOf(preview.stdout) };
  };

  it("ingests with the right token, creates the database 0700/0600, and prints aggregates only", () => {
    const { s, token } = prepare();
    const r = cli(["run", "--db", s.db, "--token", token, s.file], s);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("INGEST COMPLETE");
    expect(r.stdout).toMatch(/accepted \d+, duplicate \d+, conflicting \d+ \(\d+ groups\), ambiguous \d+/);
    expect(r.stdout).toContain("may be incomplete and are not billing totals");
    expect(statSync(s.db).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.root, "out", "pilot")).mode & 0o777).toBe(0o700);

    const bytes = readFileSync(s.db).toString("latin1");
    for (const canary of CANARIES) {
      expect(r.stdout).not.toContain(canary);
      expect(bytes).not.toContain(canary);
    }
    for (const secret of ["SECRET_DIR_NAME", "SECRET_FILE_NAME", s.data]) {
      expect(r.stdout).not.toContain(secret);
      expect(bytes).not.toContain(secret);
    }
  });

  it("stores exactly what the existing in-process ingest stores", async () => {
    const { s, token } = prepare();
    expect(cli(["run", "--db", s.db, "--token", token, s.file], s).status).toBe(0);
    const oracleDb = join(s.root, "oracle", "usage.db");
    const store = openStore(oracleDb);
    await scanAndIngest(store, [s.file]);
    store.close();
    expect(projection(s.db)).toEqual(projection(oracleDb));
  });

  it.each([
    ["no token", [] as string[], "TOKEN_MISSING"],
    ["a malformed token", ["--token", "abc"], "TOKEN_MALFORMED"],
    ["a wrong token", ["--token", "f".repeat(64)], "TOKEN_MISMATCH"],
  ])("rejects %s without creating anything", (_name, extra, code) => {
    const { s } = prepare();
    const before = snapshotTree(s.root);
    const r = cli(["run", "--db", s.db, ...extra, s.file], s);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`[${code}]`);
    expect(r.stdout).toBe("");
    expect(snapshotTree(s.root)).toEqual(before);
    expect(existsSync(join(s.root, "out"))).toBe(false);
  });

  it("requires an explicit absolute --db and never falls back to a default or to the environment", () => {
    const { s, token } = prepare();
    const envDb = join(s.root, "from-env", "usage.db");
    const before = snapshotTree(s.root);
    const missing = cli(["run", "--token", token, s.file], s, { CLAUDE_CONTROL_DB_PATH: envDb });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("[DB_REQUIRED]");
    const relative = cli(["run", "--db", "usage.db", "--token", token, s.file], s);
    expect(relative.stderr).toContain("[DB_NOT_ABSOLUTE]");
    expect(snapshotTree(s.root)).toEqual(before);
    expect(existsSync(envDb)).toBe(false);
    expect(existsSync(join(s.home, "Library"))).toBe(false); // the default location (under HOME) was never touched
    expect(existsSync(join(s.cwd, "usage.db"))).toBe(false);
  });

  it("rejects a file that changed after the preview (append, touch, same-size rewrite, replacement)", () => {
    const changes: [string, (s: ReturnType<typeof sandbox>) => void][] = [
      ["append", (s) => appendFileSync(s.file, "\n")],
      ["touch", (s) => utimesSync(s.file, new Date(2001, 1, 1), new Date(2001, 1, 1))],
      ["same-size rewrite, mtime restored", (s) => {
        const before = statSync(s.file);
        const bytes = readFileSync(s.file);
        bytes[9] = bytes[9] === 65 ? 66 : 65;
        writeFileSync(s.file, bytes);
        utimesSync(s.file, before.atime, before.mtime);
      }],
      ["replacement by an identical copy", (s) => {
        const before = statSync(s.file);
        const copy = `${s.file}.copy`;
        writeFileSync(copy, readFileSync(s.file));
        utimesSync(copy, before.atime, before.mtime);
        spawnSync("mv", [copy, s.file]);
      }],
    ];
    for (const [name, change] of changes) {
      const { s, token } = prepare();
      change(s);
      const before = snapshotTree(s.root);
      const r = cli(["run", "--db", s.db, "--token", token, s.file], s);
      expect(r.status, name).toBe(2);
      expect(r.stderr, name).toContain("[TOKEN_MISMATCH]");
      expect(snapshotTree(s.root), name).toEqual(before);
    }
  });

  it("rejects an over-limit file before creating a database, even with a correctly computed token", () => {
    const s = sandbox();
    const big = join(s.data, "big.jsonl");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024 + 1);
    const fakeToken = "a".repeat(64);
    const before = snapshotTree(s.root);
    const r = cli(["run", "--db", s.db, "--token", fakeToken, big], s);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("[FILE_TOO_LARGE]");
    expect(snapshotTree(s.root)).toEqual(before);
  });

  it("rejects bad database locations without creating directories", () => {
    const { s, token } = prepare();
    spawnSync("ln", ["-s", s.data, join(s.root, "linkdir")]);
    const before = snapshotTree(s.root);
    const cases: [string, string][] = [
      [join(s.root, "linkdir", "new", "usage.db"), "DB_NOT_CANONICAL"],
      [`${s.root}/a/../usage.db`, "DB_PATH_INVALID"],
      [s.file, "DB_IS_SOURCE"],
      [s.data, "DB_NOT_FILE"],
    ];
    for (const [db, code] of cases) {
      const r = cli(["run", "--db", db, "--token", token, s.file], s);
      expect(r.status, db).toBe(2);
      expect(r.stderr, db).toContain(`[${code}]`);
    }
    expect(snapshotTree(s.root)).toEqual(before);
  });

  it("a second run of an unchanged file is a no-op and keeps the existing database", () => {
    const { s, token } = prepare();
    expect(cli(["run", "--db", s.db, "--token", token, s.file], s).status).toBe(0);
    const inode = statSync(s.db).ino;
    const second = cli(["run", "--db", s.db, "--token", token, s.file], s);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("unchanged");
    expect(statSync(s.db).ino).toBe(inode);
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });

  it("exit codes: 0 success, 2 rejected input", () => {
    const { s, token } = prepare();
    expect(cli(["run", "--db", s.db, "--token", token, s.file], s).status).toBe(0);
    expect(cli(["run"], s).status).toBe(2);
  });
});

describe("documentation matches the implementation", () => {
  it("README states the workflow, the limit, the explicit database rule and the limits of the checks", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
    const missing = [
      "pnpm ingest preview /absolute/path/to/session.jsonl",
      "pnpm ingest run --db /absolute/path/to/pilot/usage.db --token <token-from-preview>",
      "Size limit: 64 MiB per file, fixed.",
      "no default and no environment fallback",
      "never opens the file, creates nothing",
      "It is a consistency check between preview and run, not authentication",
      "a swap that restores identical metadata is not detectable",
      "Not stored:",
      "CLAUDE_CONTROL_DB_PATH=/absolute/path/to/pilot/usage.db pnpm start",
      "there is no directory, glob or discovery mode",
    ].filter((phrase) => !readme.includes(phrase));
    expect(missing).toEqual([]);
  });

  it("the dashboard empty states point at the supported commands, not at library functions", () => {
    const notice = readFileSync(join(ROOT, "src/components/dashboard/notice.tsx"), "utf8");
    expect(notice).toContain("pnpm ingest preview <absolute path>");
    expect(notice).toContain("pnpm ingest run --db <absolute database path> --token <token> <absolute path>");
    expect(notice).not.toContain("scanAndIngest");
  });
});

describe("M7.1-R2: closed output streams, aliases and permissions, as a real process", () => {
  const prepare = () => {
    const s = sandbox();
    return { s, token: tokenOf(cli(["preview", s.file], s).stdout) };
  };
  const bash = (script: string, s: { cwd: string; home: string }) =>
    spawnSync("bash", ["-c", script], { cwd: s.cwd, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: s.home }, encoding: "utf8", timeout: 60_000 });
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

  it("stdout closed before the result is written: exit 0, a COMMITTED notice, no stack trace, records are stored", () => {
    const { s, token } = prepare();
    const errFile = join(s.root, "stderr.txt");
    const r = bash(`node --no-warnings ${q(CLI)} run --db ${q(s.db)} --token ${token} ${q(s.file)} 2>${q(errFile)} | true; echo "status=\${PIPESTATUS[0]}"`, s);
    const err = readFileSync(errFile, "utf8");

    expect(r.stdout.trim()).toBe("status=0");
    expect(err).toContain("INGEST COMMITTED");
    expect(err).not.toContain("No usage records were written");
    expect(err).not.toMatch(/Unhandled|EPIPE|node:events|node:internal|\n\s+at /);
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });

  it("stdout closed entirely: exit 0 and no stack trace", () => {
    const { s, token } = prepare();
    const errFile = join(s.root, "stderr.txt");
    const r = bash(`node --no-warnings ${q(CLI)} run --db ${q(s.db)} --token ${token} ${q(s.file)} >&- 2>${q(errFile)}; echo "status=$?"`, s);
    expect(r.stdout.trim()).toBe("status=0");
    expect(readFileSync(errFile, "utf8")).not.toMatch(/Unhandled|node:events|\n\s+at /);
    expect(countRows(s.db, "usage_records")).toBeGreaterThan(0);
  });

  it("a preview whose stdout is closed fails with OUTPUT_FAILED (exit 3) and creates nothing", () => {
    const s = sandbox();
    const before = snapshotTree(s.root);
    const errFile = join(s.root, "stderr.txt");
    const r = bash(`node --no-warnings ${q(CLI)} preview ${q(s.file)} 2>${q(errFile)} | true; echo "status=\${PIPESTATUS[0]}"`, s);
    const err = readFileSync(errFile, "utf8");
    expect(r.stdout.trim()).toBe("status=3");
    expect(err).toContain("[OUTPUT_FAILED]");
    expect(err).not.toMatch(/Unhandled|node:events|\n\s+at /);
    expect(snapshotTree(s.root).filter((e) => !e.includes("stderr.txt"))).toEqual(before);
  });

  it("rejects a database path that is a hard link to the transcript, before touching it", () => {
    const { s, token } = prepare();
    const alias = join(s.data, "SECRET_DIR_NAME", "alias.db");
    spawnSync("ln", [s.file, alias]);
    spawnSync("chmod", ["644", s.file]);
    const bytes = readFileSync(s.file);
    const before = snapshotTree(s.root);
    const r = cli(["run", "--db", alias, "--token", token, s.file], s);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("[DB_IS_SOURCE]");
    expect(snapshotTree(s.root)).toEqual(before);
    expect(readFileSync(s.file).equals(bytes)).toBe(true);
    expect(statSync(s.file).mode & 0o777).toBe(0o644);
  });

  it("an existing database keeps its mode; a new one is 0600", () => {
    const { s, token } = prepare();
    expect(cli(["run", "--db", s.db, "--token", token, s.file], s).status).toBe(0);
    expect(statSync(s.db).mode & 0o777).toBe(0o600);
    spawnSync("chmod", ["644", s.db]);
    const second = writeFile(s.data, "second.jsonl", syntheticTranscript().replace(/u-1\b/g, "u-9"));
    const token2 = tokenOf(cli(["preview", second], s).stdout);
    expect(cli(["run", "--db", s.db, "--token", token2, second], s).status).toBe(0);
    expect(statSync(s.db).mode & 0o777).toBe(0o644);
  });
});
