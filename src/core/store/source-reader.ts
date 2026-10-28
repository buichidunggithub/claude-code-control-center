import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { scanStream, type ScanResult } from "../parse/scan";
import { DEFAULT_MAX_LINE_BYTES } from "../parse/types";
import { fingerprint, keyedHash, type Store } from "./database";
import { num, one } from "./sql";

export type SourceErrorCode = "ENOENT" | "EACCES" | "NOT_REGULAR_FILE" | "READ_ERROR";

export interface SourceScan {
  readonly kind: "ok";
  readonly fingerprint: string;
  readonly label: string | null;
  /** Keyed hash of the whole content, for change detection only. */
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly endedWithNewline: boolean;
  /** Keyed hash of the first `size` bytes, where `size` was the previously stored size. */
  readonly prefixCheck: { readonly size: number; readonly hash: string } | null;
  readonly scan: ScanResult;
}

export interface SourceFailure {
  readonly kind: "failed";
  readonly fingerprint: string | null;
  readonly errorCode: SourceErrorCode;
}

export type SourceInput = SourceScan | SourceFailure;

export interface ReadSourceOptions {
  readonly label?: string;
  readonly maxLineBytes?: number;
  /**
   * Optional cap on the TOTAL bytes streamed. When the stream delivers more than this, reading stops at
   * once (the stream is destroyed) and the source is reported as a read failure. Unset: no cap, as before.
   */
  readonly maxBytes?: number;
  /**
   * Opt-in, default false. Passed to the parse layer, which then reads user-event content in memory only to
   * compute a coarse length bucket. Never inferred, so a normal ingest stores `not-read`.
   */
  readonly readPromptLength?: boolean;
}

const NEWLINE = 0x0a;

interface Digest {
  sizeBytes: number;
  endedWithNewline: boolean;
  contentHash: string;
  prefixHash: string | null;
}

async function* hashing(
  source: AsyncIterable<Buffer | string>,
  salt: Buffer,
  prefixSize: number | null,
  out: { digest?: Digest },
  maxBytes: number | null = null,
): AsyncGenerator<Buffer> {
  const full = keyedHash(salt);
  let sizeBytes = 0;
  let lastByte = NEWLINE;
  let prefixHash = prefixSize === 0 ? full.copy().digest("hex") : null;

  for await (const chunk of source) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buf.length === 0) continue;
    if (prefixSize !== null && prefixHash === null && sizeBytes + buf.length >= prefixSize) {
      const take = prefixSize - sizeBytes;
      full.update(buf.subarray(0, take));
      prefixHash = full.copy().digest("hex");
      full.update(buf.subarray(take));
    } else {
      full.update(buf);
    }
    sizeBytes += buf.length;
    // Throwing here ends the consuming loop, which destroys the underlying file stream: no further bytes are read.
    if (maxBytes !== null && sizeBytes > maxBytes) throw new RangeError("source exceeds the byte limit");
    lastByte = buf[buf.length - 1] ?? lastByte;
    yield buf;
  }
  out.digest = {
    sizeBytes,
    endedWithNewline: lastByte === NEWLINE,
    contentHash: full.digest("hex"),
    prefixHash,
  };
}

function errorCodeOf(error: unknown): SourceErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "EACCES" ? code : "READ_ERROR";
}

/** The source's identity is its path with the parent directory canonicalized; the file itself may be gone. */
async function canonicalPath(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

/**
 * Reads exactly the file the caller names, read-only, in one pass: hashing and scanning share the
 * stream. Failures are reduced to a fixed error code; messages (which can contain paths) are dropped.
 */
export async function readSource(
  store: Store,
  filePath: string,
  options: ReadSourceOptions = {},
): Promise<SourceInput> {
  let canonical: string;
  try {
    canonical = await canonicalPath(filePath);
  } catch (error) {
    return { kind: "failed", fingerprint: null, errorCode: errorCodeOf(error) };
  }
  const sourceFingerprint = fingerprint(store.salt, "source", canonical);
  const fail = (errorCode: SourceErrorCode): SourceFailure => ({
    kind: "failed",
    fingerprint: sourceFingerprint,
    errorCode,
  });

  try {
    if (!(await stat(canonical)).isFile()) return fail("NOT_REGULAR_FILE");
    const prior = one(store.db, "SELECT size_bytes FROM source_files WHERE fingerprint = ?", sourceFingerprint);
    const prefixSize = prior ? num(prior, "size_bytes") : null;

    const out: { digest?: Digest } = {};
    const scan = await scanStream(
      hashing(createReadStream(canonical), store.salt, prefixSize, out, options.maxBytes ?? null),
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      0,
      { readPromptLength: options.readPromptLength === true },
    );
    const { digest } = out;
    if (!digest) return fail("READ_ERROR");

    return {
      kind: "ok",
      fingerprint: sourceFingerprint,
      label: options.label ?? null,
      contentHash: digest.contentHash,
      sizeBytes: digest.sizeBytes,
      endedWithNewline: digest.endedWithNewline,
      prefixCheck:
        prefixSize !== null && digest.prefixHash !== null ? { size: prefixSize, hash: digest.prefixHash } : null,
      scan,
    };
  } catch (error) {
    return fail(errorCodeOf(error));
  }
}
