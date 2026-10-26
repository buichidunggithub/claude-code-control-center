import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export type SkipCode =
  | "ENOENT"
  | "EACCES"
  | "NOT_REGULAR_FILE"
  | "TOO_LARGE"
  | "OUTSIDE_ROOTS"
  | "SYMLINK_LOOP"
  | "BINARY"
  | "INVALID_ENCODING"
  | "READ_ERROR";

/** Strict decoder: invalid UTF-8 is reported instead of silently replaced. A BOM is kept for the caller. */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type SafeRead =
  | { readonly kind: "ok"; readonly text: string; readonly sizeBytes: number; readonly canonicalPath: string }
  | { readonly kind: "skipped"; readonly code: SkipCode; readonly sizeBytes: number; readonly canonicalPath: string | null };

/** True when `child` is `parent` or lies below it. Purely lexical: callers canonicalize first. */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function withinAny(child: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(child, root));
}

function codeOf(error: unknown): SkipCode {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "ENOENT";
  if (code === "EACCES" || code === "EPERM") return "EACCES";
  if (code === "ELOOP") return "SYMLINK_LOOP";
  return "READ_ERROR";
}

export type CanonicalRoot =
  | { readonly ok: true; readonly real: string }
  | { readonly ok: false; readonly code: SkipCode };

/** Roots must be absolute existing directories. A symlinked root is accepted: the caller chose it. */
export async function canonicalRoot(dir: string): Promise<CanonicalRoot> {
  if (!isAbsolute(dir)) return { ok: false, code: "READ_ERROR" };
  try {
    const real = await realpath(dir);
    return (await stat(real)).isDirectory() ? { ok: true, real } : { ok: false, code: "NOT_REGULAR_FILE" };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}

export type PathKind = "missing" | "file" | "dir" | "symlink" | "other";

export async function lstatKind(path: string): Promise<PathKind> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "dir";
    return info.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

/**
 * Reads one file read-only. The path is canonicalized and must resolve inside an allowed root, so
 * traversal and symlinks pointing outside are refused BEFORE the file is opened. The open uses
 * O_NOFOLLOW on the canonical path, and size is enforced on the descriptor and while reading.
 * Failures are reduced to a fixed code; error messages (which contain paths) are never kept.
 */
export async function readConfigFile(candidate: string, allowedRoots: readonly string[], maxBytes: number): Promise<SafeRead> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    return { kind: "skipped", code: codeOf(error), sizeBytes: 0, canonicalPath: null };
  }
  if (!withinAny(real, allowedRoots)) return { kind: "skipped", code: "OUTSIDE_ROOTS", sizeBytes: 0, canonicalPath: null };

  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "skipped", code: "NOT_REGULAR_FILE", sizeBytes: 0, canonicalPath: real };
    if (info.size > maxBytes) return { kind: "skipped", code: "TOO_LARGE", sizeBytes: info.size, canonicalPath: real };

    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { kind: "skipped", code: "TOO_LARGE", sizeBytes: bytesRead, canonicalPath: real };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { kind: "skipped", code: "BINARY", sizeBytes: bytesRead, canonicalPath: real };
    try {
      return { kind: "ok", text: UTF8_STRICT.decode(bytes), sizeBytes: bytesRead, canonicalPath: real };
    } catch {
      return { kind: "skipped", code: "INVALID_ENCODING", sizeBytes: bytesRead, canonicalPath: real };
    }
  } catch (error) {
    return { kind: "skipped", code: codeOf(error), sizeBytes: 0, canonicalPath: real };
  } finally {
    await handle?.close();
  }
}
