import { createHash, timingSafeEqual } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { CliError } from "./codes";

const DOMAIN = "claude-code-control-center ingest token v1";
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

/**
 * SHA-256 over the exact path and the file's identity and change metadata (device, inode, size, and the
 * modification and status-change times in nanoseconds). It is a consistency check between preview and run,
 * not authentication: anyone who can read the preview output can compute it. It cannot detect a change that
 * leaves all of those values identical, and it does not cover file content (preview never reads content).
 * The status-change time cannot be set by ordinary tools, so restoring the modification time after an edit
 * is still detected.
 */
export function fileToken(path: string, stats: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">): string {
  return createHash("sha256")
    .update([DOMAIN, path, stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join("\0"))
    .digest("hex");
}

export function checkToken(given: string | null, expected: string): void {
  if (given === null || given === "") throw new CliError("TOKEN_MISSING");
  if (!TOKEN_FORMAT.test(given)) throw new CliError("TOKEN_MALFORMED");
  if (!timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"))) throw new CliError("TOKEN_MISMATCH");
}
