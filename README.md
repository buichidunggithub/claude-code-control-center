# Claude Code Control Center

Local-first, **read-only** analyzer for Claude Code usage and configuration. macOS only (MVP).

Status: M0 scaffold. No transcript parsing, discovery, pricing or analysis yet.

## Principles
- Runs on `127.0.0.1` only; no LAN/public bind option.
- No telemetry, CDN assets, external APIs or update checks at runtime.
- Never stores prompts, responses, tool arguments or transcript contents.
- App data lives outside the repo (macOS Application Support).
- Tests use synthetic fixtures only (`tests/fixtures/synthetic/`).

## Commands
```
pnpm install
pnpm dev        # http://127.0.0.1:3210
pnpm lint
pnpm typecheck
pnpm test
```

The loopback test checks configuration (scripts and constants). It does not prove runtime network isolation.

## Local store (M2)

Usage accounting is persisted with the built-in `node:sqlite` (no native dependency) at
`~/Library/Application Support/claude-code-control-center/usage.db` (directory `0700`, file `0600`).
Nothing is created until `openStore` is called. Only structure is stored: salted fingerprints, model
names, timestamps, counters with their raw states (missing / null / invalid / value) and accounting
states. No prompts, responses, tool arguments, file paths or env values.

- **Identity:** events with a message id (else a line uuid) are grouped across all sources; anonymous
  events are keyed by (source fingerprint, line number) and are never merged on payload equality.
- **Rescans:** unchanged sources write nothing; changed sources are replaced inside one transaction and
  affected groups are recomputed. A failed or missing source never deletes its prior records.
- **Totals:** settled = accepted only. Conflicting usage is a lower/upper range; anonymous usage is shown
  as `ifRepeats` / `ifDistinct`. See `src/core/store/ingest.ts` for the full semantics and limits.
- **Limits:** the same bytes copied to another path collapse for identity-bearing events but double the
  anonymous rows; sessions replayed under fresh message ids are not recognized. Fingerprints are salted
  but not anonymization: the salt lives in the same database file.

## Configuration inventory (M3)

`scanConfig(roots, { salt })` (in `src/core/config`) is a read-only static audit of explicitly supplied
roots: a `user-config` root (the user's Claude config directory) and/or `project` roots. It never
discovers roots itself. Paths are canonicalized, nothing outside the supplied roots is opened (including
through symlinks or `..`), files above 1 MiB or containing binary data are skipped, and JSON/frontmatter
depth is bounded.

- **Detected is not loaded.** `activation` is one of `unverified-candidate`, `conditional`, `on-demand`,
  `import-only`, `unknown`; there is deliberately no "loaded" value.
- **Findings** carry a stable rule id (`CFG-*`), severity, confidence, structural evidence (counts and line
  numbers), limitations and a recommendation. No external model is used and no token saving is claimed;
  token figures are bytes / 4 estimates.
- **Stored (schema v2):** salted fingerprints, sizes, line counts, keyed content hashes, estimated tokens,
  validated frontmatter names/lengths, settings structure as counts, and findings. Never file text, paths,
  hook commands, env values or permission rules. Only a complete scan replaces the current snapshot.
- **Assumed layouts** (rules, agents, skills, settings, CLAUDE.md, `@path` imports) follow documented
  conventions and are validated only against synthetic trees.
