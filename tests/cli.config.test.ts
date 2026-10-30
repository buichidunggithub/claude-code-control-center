import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createAnalysis } from "@/core/analysis";
import { openStore, scanAndIngest } from "@/core/store";
import { main } from "@/cli/config-main";
import { runConfigScan } from "@/cli/config-run";
import { REJECTIONS } from "@/cli/codes";
import { ALL_CANARIES } from "./analysis-helpers";
import { registerCliCleanup, snapshotTree, syntheticTranscript, writeFile } from "./cli-helpers";
import { CONFIG_CLI, ROOT, SECRET_DIR, configBox, configCli, countOf, rows, scanArgs } from "./cli-config-helpers";
import { CONFIG_CANARIES, treeDigest, writeTree } from "./config-helpers";

registerCliCleanup();

const TSC = join(ROOT, "node_modules", ".bin", "tsc");
const BUILD_TIMEOUT_MS = 120_000;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

beforeAll(() => {
  const build = spawnSync(TSC, ["-p", "tsconfig.cli.json"], { cwd: ROOT, encoding: "utf8", timeout: BUILD_TIMEOUT_MS });
  if (build.status !== 0) throw new Error(`cli build failed: ${build.stdout}${build.stderr}`);
}, BUILD_TIMEOUT_MS + 5000);

const NO_LEAKS = (text: string, box: { root: string }): void => {
  for (const secret of [box.root, SECRET_DIR, "reviewer", "style.md", "settings.json", "CLAUDE.md", ...ALL_CANARIES, ...CONFIG_CANARIES]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/\/Users\/|\/private\/|\/tmp\/|\n\s+at |Error:|node:/);
};

describe("config scan, as a real process", () => {
  it("scans the named roots, prints aggregates only, creates the database 0700/0600 and changes no configuration", () => {
    const box = configBox();
    const userBefore = treeDigest(box.user);
    const projectBefore = treeDigest(box.project);

    const r = configCli(scanArgs(box), box);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("CONFIG SCAN COMPLETE (aggregate figures only; no path or content is shown)");
    expect(r.stdout).toMatch(/Scan \.+ #1, status complete; roots 2 of 2 available/);
    expect(r.stdout).toContain("user/agent 1");
    expect(r.stdout).toContain("project/claude_md 1");
    expect(r.stdout).toContain("Nothing was changed, executed or enabled.");
    NO_LEAKS(r.stdout, box);
    expect(statSync(join(box.root, "out", "data")).mode & 0o777).toBe(0o700);
    expect(statSync(box.db).mode & 0o777).toBe(0o600);
    expect(treeDigest(box.user)).toEqual(userBefore);
    expect(treeDigest(box.project)).toEqual(projectBefore);
  });

  it("stores only recognised files, no label, and is visible through the existing dashboard APIs", () => {
    const box = configBox();
    expect(configCli(scanArgs(box), box).status).toBe(0);

    expect(countOf(box.db, "config_files")).toBe(7); // 5 user files (CLAUDE.md, settings, agent, rule, skill) + project CLAUDE.md + project agent; notes.md and README.txt are ignored
    expect(rows(box.db, "SELECT COUNT(*) AS n FROM config_files WHERE label IS NOT NULL")[0]?.["n"]).toBe(0);
    expect(rows(box.db, "SELECT COUNT(*) AS n FROM config_scans WHERE is_current = 1")[0]?.["n"]).toBe(1);

    const analysis = createAnalysis(box.db);
    const status = analysis.status().data;
    const summary = analysis.configSummary();
    const findings = analysis.configFindings({ severity: null, ruleId: null, limit: 200, offset: 0 });
    expect(status?.config.state).toBe("ok");
    expect(summary.state).toBe("ok");
    expect(summary.data?.rows.reduce((n, row) => n + row.files, 0)).toBe(7);
    expect(findings.state).toBe("ok");
    expect(findings.data?.total).toBeGreaterThan(0);
    const text = JSON.stringify([status, summary, findings, analysis.recommendations({ category: null, priority: null, limit: 200, offset: 0 })]);
    for (const canary of [...CONFIG_CANARIES, ...ALL_CANARIES.filter((c) => c.startsWith("CANARY_CFG") || c.startsWith("CANARY_NAMED"))]) expect(text).not.toContain(canary);
    expect(text).not.toContain(box.root);
  });

  it("replaces the current snapshot on a second complete scan and keeps both history rows", () => {
    const box = configBox();
    expect(configCli(scanArgs(box), box).status).toBe(0);
    writeTree(box.user, { "rules/extra.md": "Another rule.\n" });
    expect(configCli(scanArgs(box), box).status).toBe(0);

    expect(countOf(box.db, "config_scans")).toBe(2);
    expect(rows(box.db, "SELECT id FROM config_scans WHERE is_current = 1").map((x) => x["id"])).toEqual([2]);
    expect(countOf(box.db, "config_files")).toBe(8);
  });

  it("scans one root alone, and an empty root is a complete scan with zero files", () => {
    const box = configBox();
    const empty = join(box.root, "empty-root");
    mkdirSync(empty);

    const r = configCli(["--user-root", empty, "--db", box.db], box);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/roots 1 of 1 available/);
    expect(r.stdout).toContain("0 inventoried");
    expect(countOf(box.db, "config_files")).toBe(0);
    expect(createAnalysis(box.db).configSummary().state).toBe("ok");
  });

  it("counts skipped, malformed and broken inputs by fixed code in a complete scan, and ignores unrecognised files", () => {
    const box = configBox();
    writeFileSync(join(box.user, "rules", "binary.md"), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(join(box.user, "rules", "latin1.md"), Buffer.from([0xff, 0xfe, 0x41]));
    writeFileSync(join(box.user, "rules", "huge.md"), "");
    truncateSync(join(box.user, "rules", "huge.md"), 1024 * 1024 + 1);
    writeFileSync(join(box.user, "settings.local.json"), "{ this is not json");

    const r = configCli(scanArgs(box), box);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Skipped \.+ BINARY 1, INVALID_ENCODING 1, TOO_LARGE 1/);
    expect(r.stdout).toMatch(/Imports \.+ broken 1/);
    NO_LEAKS(r.stdout, box);
    expect(rows(box.db, "SELECT COUNT(*) AS n FROM config_files WHERE status = 'skipped'")[0]?.["n"]).toBe(3);
  });

  it("does not follow a symlink out of a root and never stores or prints what is outside", () => {
    const box = configBox();
    const outside = join(box.root, "outside");
    writeTree(outside, { "secret.md": `${CONFIG_CANARIES[5]} outside content\n` });
    symlinkSync(join(outside, "secret.md"), join(box.user, "rules", "leak.md"));
    symlinkSync(outside, join(box.user, "rules", "leakdir"));

    const r = configCli(scanArgs(box), box);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Skipped \.+ OUTSIDE_ROOTS/);
    expect(r.stdout).not.toContain(CONFIG_CANARIES[5]);
    expect(JSON.stringify(rows(box.db, "SELECT * FROM config_files"))).not.toContain(CONFIG_CANARIES[5]);
    expect(rows(box.db, "SELECT COUNT(*) AS n FROM config_files WHERE content_hash IS NOT NULL AND error_code IS NOT NULL")[0]?.["n"]).toBe(0);
  });

  it("never executes a hook or enables anything it finds", () => {
    const box = configBox();
    const marker = join(box.root, "MARKER_SHOULD_NOT_EXIST");
    writeFileSync(
      join(box.user, "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] }, enabledPlugins: { "evil@x": true }, mcpServers: { s: { command: `touch ${marker}` } } }),
    );
    const before = treeDigest(box.user);

    expect(configCli(scanArgs(box), box).status).toBe(0);

    expect(existsSync(marker)).toBe(false);
    expect(treeDigest(box.user)).toEqual(before);
    expect(readdirSync(box.root).sort()).toEqual(["cwd", "home", "home-config", "out", SECRET_DIR].sort());
  });

  it("adds nothing to the usage tables and never touches an existing database's usage data", async () => {
    const box = configBox();
    const store = openStore(box.db);
    const transcript = writeFile(box.root, "t/transcript.jsonl", syntheticTranscript());
    await scanAndIngest(store, [transcript]);
    store.close();
    const before = [countOf(box.db, "usage_records"), countOf(box.db, "scan_runs")];

    expect(configCli(scanArgs(box), box).status).toBe(0);

    expect([countOf(box.db, "usage_records"), countOf(box.db, "scan_runs")]).toEqual(before);
    expect(countOf(box.db, "config_files")).toBe(7);
  });

  it("keeps an existing database's mode (even 0644) and does not create a default database or use the environment", () => {
    const box = configBox();
    mkdirSync(join(box.root, "existing"));
    const existing = join(box.root, "existing", "usage.db");
    openStore(existing).close();
    chmodSync(existing, 0o644);
    const decoy = join(box.root, "decoy", "env.db");

    const r = configCli(scanArgs(box, existing), box, { CLAUDE_CONTROL_DB_PATH: decoy });

    expect(r.status).toBe(0);
    expect(statSync(existing).mode & 0o777).toBe(0o644);
    expect(existsSync(join(box.root, "decoy"))).toBe(false);
    expect(existsSync(join(box.home, "Library"))).toBe(false);
    expect(countOf(existing, "config_files")).toBe(7);
  });

  it.skipIf(isRoot)("an unreadable recognised file is a counted skip, not a failure", () => {
    const box = configBox();
    chmodSync(join(box.user, "rules", "style.md"), 0o000);
    try {
      const r = configCli(scanArgs(box), box);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Skipped \.+ EACCES 1/);
    } finally {
      chmodSync(join(box.user, "rules", "style.md"), 0o644);
    }
  });
});

describe("config scan rejections create nothing", () => {
  const cases: [string, (b: ReturnType<typeof configBox>) => string[], string][] = [
    ["no arguments", () => [], "ROOT_REQUIRED"],
    ["only --db", (b) => ["--db", b.db], "ROOT_REQUIRED"],
    ["a positional argument", (b) => [...scanArgs(b), b.user], "CONFIG_USAGE"],
    ["an unknown option", (b) => [...scanArgs(b), "--root", b.user], "INVALID_OPTION"],
    ["a duplicate option", (b) => [...scanArgs(b), "--db", b.db], "DUPLICATE_OPTION"],
    ["a missing option value", (b) => ["--user-root", "--db", b.db], "CONFIG_USAGE"],
    ["a dangling option", (b) => ["--db", b.db, "--user-root"], "CONFIG_USAGE"],
    ["a relative root", (b) => ["--user-root", "claude-config", "--db", b.db], "NOT_ABSOLUTE"],
    ["a root with ..", (b) => ["--user-root", `${b.user}/../home-config`, "--db", b.db], "PATH_NOT_NORMAL"],
    ["a root with a trailing slash", (b) => ["--user-root", `${b.user}/`, "--db", b.db], "PATH_NOT_NORMAL"],
    ["a wildcard root", (b) => ["--user-root", `${b.root}/*`, "--db", b.db], "GLOB_CHARACTER"],
    ["a root with a control character", (b) => ["--user-root", `${b.user}\u0007`, "--db", b.db], "CONTROL_CHARACTER"],
    ["an empty root", (b) => ["--user-root", "", "--db", b.db], "PATH_LENGTH"],
    ["a root that is the filesystem root", (b) => ["--user-root", "/", "--db", b.db], "PATH_NOT_NORMAL"],
    ["a missing root", (b) => ["--user-root", join(b.root, "nope"), "--db", b.db], "ROOT_NOT_FOUND"],
    ["a file as root", (b) => ["--user-root", join(b.user, "CLAUDE.md"), "--db", b.db], "ROOT_NOT_DIRECTORY"],
    ["a symlink root", (b) => ["--user-root", join(b.root, "link-root"), "--db", b.db], "ROOT_SYMLINK"],
    ["a root under a symlinked parent", (b) => ["--user-root", join(b.root, "link-parent", "home-config"), "--db", b.db], "ROOT_NOT_CANONICAL"],
    ["the same directory for both roots", (b) => ["--user-root", b.user, "--project-root", b.user, "--db", b.db], "ROOT_DUPLICATE"],
    ["no --db", (b) => ["--user-root", b.user], "DB_REQUIRED"],
    ["a relative --db", (b) => ["--user-root", b.user, "--db", "usage.db"], "DB_NOT_ABSOLUTE"],
    ["a --db with ..", (b) => ["--user-root", b.user, "--db", `${b.root}/out/../usage.db`], "DB_PATH_INVALID"],
    ["a --db inside the user root", (b) => ["--user-root", b.user, "--db", join(b.user, "usage.db")], "DB_INSIDE_ROOT"],
    ["a --db inside the project root, in a directory that does not exist", (b) => ["--project-root", b.project, "--db", join(b.project, "new", "usage.db")], "DB_INSIDE_ROOT"],
    ["a --db that is the directory of a root", (b) => ["--user-root", b.user, "--db", b.user], "DB_NOT_FILE"],
    ["a symlink --db", (b) => ["--user-root", b.user, "--db", join(b.root, "link-db.db")], "DB_SYMLINK"],
    ["a directory as --db", (b) => ["--user-root", b.user, "--db", join(b.root, "out")], "DB_NOT_FILE"],
    ["a --db under a symlinked parent", (b) => ["--user-root", b.user, "--db", join(b.root, "link-parent", "usage.db")], "DB_NOT_CANONICAL"],
    ["a --db with a second name", (b) => ["--user-root", b.user, "--db", join(b.root, "out", "alias.db")], "DB_MULTIPLE_LINKS"],
  ];

  it.each(cases)("rejects %s without side effects", (_name, args, code) => {
    const box = configBox();
    symlinkSync(box.user, join(box.root, "link-root"));
    symlinkSync(box.root, join(box.root, "link-parent"));
    symlinkSync(join(box.root, "out"), join(box.root, "link-db.db"));
    linkSync(join(box.user, "rules", "style.md"), join(box.root, "out", "alias.db"));
    const before = snapshotTree(box.root);
    const bytes = readFileSync(join(box.user, "rules", "style.md"));

    const r = configCli(args(box), box);

    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`^REJECTED \\[${code}\\] [^\\n]+\\nNothing was scanned or created\\.\\n$`));
    NO_LEAKS(r.stderr, box);
    expect(snapshotTree(box.root)).toEqual(before);
    expect(readFileSync(join(box.user, "rules", "style.md")).equals(bytes)).toBe(true);
    expect(existsSync(box.db)).toBe(false);
  });

  it("never turns an empty or recognised file inside a root into a database", () => {
    const box = configBox();
    const target = join(box.user, "settings.local.json");
    writeFileSync(target, "");
    const before = snapshotTree(box.root);

    const r = configCli(["--user-root", box.user, "--db", target], box);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("[DB_INSIDE_ROOT]");
    expect(statSync(target).size).toBe(0);
    expect(snapshotTree(box.root)).toEqual(before);
  });

  it("an existing file that is not a database is refused after open and left byte-identical", async () => {
    const box = configBox();
    mkdirSync(join(box.root, "notdb"));
    const notDb = join(box.root, "notdb", "other.db");
    writeFileSync(notDb, "this is not a sqlite database\n");

    const code = await main(["--user-root", box.user, "--db", notDb], { write: (_t, d) => d?.() }, { write: (_t, d) => d?.() });

    expect(code).toBe(3);
    expect(readFileSync(notDb, "utf8")).toBe("this is not a sqlite database\n");
  });
});

describe("config scan failures and races", () => {
  const sinks = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, sink: (target: string[]) => ({ write: (text: string, done?: (e?: Error | null) => void) => (target.push(text), done?.()) }) };
  };

  it("rejects a root swapped for a symlink after validation, before scanning, and writes no configuration", async () => {
    const box = configBox();
    const elsewhere = join(box.root, "elsewhere");
    writeTree(elsewhere, { "CLAUDE.md": `${CONFIG_CANARIES[0]}\n` });

    await expect(
      runConfigScan(
        { userRoot: box.user, projectRoot: null, dbPath: box.db },
        {
          beforeScan: () => {
            spawnSync("mv", [box.user, join(box.root, "moved-away")]);
            symlinkSync(elsewhere, box.user);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ROOT_CHANGED", afterDbOpen: true });

    expect(countOf(box.db, "config_scans")).toBe(0);
    expect(countOf(box.db, "config_files")).toBe(0);
  });

  it("reports SAVE_FAILED as a fixed code, with exit 3 and no database text, when the save is rolled back", async () => {
    const box = configBox();
    const store = openStore(box.db);
    store.db.exec("CREATE TRIGGER block BEFORE INSERT ON config_files BEGIN SELECT RAISE(ABORT, 'CANARY_DB_ERROR_TEXT /Users/q/secret'); END");
    store.close();
    const s = sinks();

    const code = await main(scanArgsFor(box), s.sink(s.out), s.sink(s.err));

    const stderr = s.err.join("");
    expect(code).toBe(3);
    expect(stderr).toMatch(/^FAILED \[SAVE_FAILED\] [^\n]+\nNo configuration rows were written by this run; the database file may already exist\.\n$/);
    expect(stderr + s.out.join("")).not.toMatch(/CANARY_DB_ERROR_TEXT|\/Users\/|\n\s+at /);
    expect(countOf(box.db, "config_files")).toBe(0);
    expect(rows(box.db, "SELECT COUNT(*) AS n FROM config_scans WHERE is_current = 1")[0]?.["n"]).toBe(0);
  });

  it("maps an unexpected error to INTERNAL_ERROR without its message, a path or a stack", async () => {
    const s = sinks();
    const code = await main(["--user-root", "/a", "--db", "/b.db"], s.sink(s.out), s.sink(s.err), () => Promise.reject(new Error("CANARY_PATH_9c1d /Users/x/secret")));

    expect(code).toBe(3);
    expect(s.err.join("")).toBe("FAILED [INTERNAL_ERROR] An unexpected error occurred. Nothing more is shown on purpose.\nIt is not known whether this run changed the database; inspect it before relying on it.\n");
    expect(s.out.join("")).toBe("");
  });

  it("a summary that cannot be written is a RECORDED notice on stderr, and the exit stays 0", async () => {
    const box = configBox();
    const s = sinks();

    const code = await main(scanArgsFor(box), { write: (_t, d) => d?.(new Error("EPIPE")) }, s.sink(s.err));

    expect(code).toBe(0);
    expect(s.err.join("")).toContain("CONFIG SCAN RECORDED");
    expect(countOf(box.db, "config_files")).toBe(7);
  });

  it("closed stdout as a real process: exit 0, a RECORDED notice, no stack trace, the scan is saved", () => {
    const box = configBox();
    const errFile = join(box.root, "stderr.txt");
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const script = `node --no-warnings ${q(CONFIG_CLI)} ${scanArgs(box).map(q).join(" ")} 2>${q(errFile)} | true; echo "status=\${PIPESTATUS[0]}"`;

    const r = spawnSync("bash", ["-c", script], { cwd: box.cwd, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: box.home }, encoding: "utf8", timeout: 60_000 });

    const err = readFileSync(errFile, "utf8");
    expect(r.stdout.trim()).toBe("status=0");
    expect(err).toContain("CONFIG SCAN RECORDED");
    expect(err).not.toMatch(/Unhandled|EPIPE|node:events|node:internal|\n\s+at /);
    expect(countOf(box.db, "config_files")).toBe(7);
  });

  it("is local only: no network, process or model module is imported by the command", () => {
    const files = ["config-main", "config-args", "config-path", "config-run", "output"].map((n) => readFileSync(join(ROOT, "src", "cli", `${n}.ts`), "utf8"));
    const core = readdirSync(join(ROOT, "src", "core", "config")).map((n) => readFileSync(join(ROOT, "src", "core", "config", n), "utf8"));
    for (const text of [...files, ...core]) {
      expect(text).not.toMatch(/node:(http|https|http2|net|tls|dns|dgram|child_process|worker_threads|cluster)\b/);
      expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|anthropic|openai/i);
    }
  });

  it("is wired into the package scripts and the CLI build without a new dependency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts["config:scan"]).toBe("tsc -p tsconfig.cli.json && node --no-warnings .cli-build/cli/config-main.js");
    expect(pkg.scripts["ingest"]).toBe("tsc -p tsconfig.cli.json && node --no-warnings .cli-build/cli/main.js");
    // recharts was added deliberately (charts on the dashboard); any other new runtime dependency still fails here.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["class-variance-authority", "clsx", "lucide-react", "next", "react", "react-dom", "recharts", "tailwind-merge"]);
    expect(existsSync(CONFIG_CLI)).toBe(true);
  });
});

describe("documentation", () => {
  it("README documents the command, its explicit inputs, rejections, exit codes and the snapshot rule", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
    const missing = [
      "pnpm config:scan --db /absolute/path/to/usage.db --user-root",
      "`pnpm config` is a built-in pnpm command",
      "no default database, no environment fallback",
      "Scan everything in one command",
      "SCAN_INCOMPLETE",
      "inside a scanned root",
      "Detected is not loaded",
    ].filter((phrase) => !readme.includes(phrase));
    expect(missing).toEqual([]);
  });

  it("the dashboard empty states point at the supported command, not at library functions", () => {
    const notice = readFileSync(join(ROOT, "src/components/dashboard/notice.tsx"), "utf8");
    expect(notice).toContain("pnpm config:scan --db <absolute database path> --user-root <absolute directory> --project-root <absolute directory>");
    expect(notice).not.toContain("saveConfigInventory");
  });

  it("every fixed hint is static text with an exit code of 2 or 3 and no path-shaped value", () => {
    for (const [code, { exit, hint }] of Object.entries(REJECTIONS)) {
      expect([2, 3], code).toContain(exit);
      expect(hint, code).not.toMatch(/\$\{|\/Users\/|\/tmp\/|\/private\//);
    }
  });
});

function scanArgsFor(box: { user: string; project: string; db: string }): string[] {
  return ["--user-root", box.user, "--project-root", box.project, "--db", box.db];
}
