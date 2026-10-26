import { MAX_FILE_BYTES } from "./limits";
import { inspectSource } from "./path-check";
import { fileToken } from "./token";

export interface Preview {
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedIso: string;
  readonly changedIso: string;
  readonly hardLinks: number;
  readonly maxBytes: number;
  readonly token: string;
}

const isoOf = (ns: bigint): string => new Date(Number(ns / 1_000_000n)).toISOString();

/** Metadata only: lstat and realpath. The file is never opened, read or parsed; nothing is created. */
export function previewSource(path: string, maxBytes: number = MAX_FILE_BYTES): Preview {
  const stats = inspectSource(path, maxBytes);
  return {
    path,
    sizeBytes: Number(stats.size),
    modifiedIso: isoOf(stats.mtimeNs),
    changedIso: isoOf(stats.ctimeNs),
    hardLinks: Number(stats.nlink),
    maxBytes,
    token: fileToken(path, stats),
  };
}

/** Quotes a path for a POSIX shell so the suggested command can be pasted as printed. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const mib = (n: number): string => (n / (1024 * 1024)).toFixed(1);

export function renderPreview(p: Preview): string {
  return `PREVIEW (metadata only: the file has NOT been opened and its content has NOT been read)

Path ........ ${p.path}
Type ........ regular file, not a symlink, extension .jsonl, real path (no symlink in it)
Size ........ ${p.sizeBytes} bytes (${mib(p.sizeBytes)} MiB)${p.sizeBytes === 0 ? "  [empty file]" : ""}
Limit ....... ${p.maxBytes} bytes (${mib(p.maxBytes)} MiB) total per file; within the limit
Modified .... ${p.modifiedIso}
Changed ..... ${p.changedIso}
Hard links .. ${p.hardLinks}${p.hardLinks > 1 ? "  [warning: more than one name for this file]" : ""}

PLANNED READ SCOPE (only when you run the second command)
  - this one file, streamed once from start to end, line by line;
  - each line is capped at 4194304 bytes; longer lines are skipped and counted, not stored;
  - no other file, no directory listing, no configuration, no settings, no network.

WOULD BE STORED (in the database you name with --db; no database exists or is created by this preview)
  - a salted fingerprint of the path (the path itself is not stored), a content hash, the size in bytes;
  - per usage record: model name only if it is a plain identifier, timestamp and UTC day, sidechain flag,
    the four token counters with their raw state (value / missing / null / invalid), accounting state;
  - per-scan counts and fixed error codes.
NEVER STORED: prompts, responses, tool arguments, file contents, paths, environment values, secrets.

No database was created. No transcript content was read. Nothing was written anywhere.

To ingest exactly this file state, choose a database path and run:
  pnpm ingest run --db <absolute-db-path> --token ${p.token} ${shellQuote(p.path)}
The token binds this path and the file's size, timestamps and identity. It is a consistency check, not authentication.`;
}
