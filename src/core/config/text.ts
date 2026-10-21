import { plainHash } from "../fingerprint";

export function splitLines(text: string): string[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (clean === "") return [];
  const lines = clean.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export interface BodyLine {
  /** 1-based line number in the original file. */
  readonly line: number;
  readonly normalized: string;
}

/** Non-blank lines outside fenced code, normalized for comparison. Text stays in memory only. */
export function bodyLines(lines: readonly string[], startIndex: number): BodyLine[] {
  const out: BodyLine[] = [];
  let fence: string | null = null;
  lines.forEach((raw, index) => {
    if (index < startIndex) return;
    const marker = FENCE.exec(raw)?.[1];
    if (marker) {
      fence = fence === null ? marker[0] ?? null : fence === marker[0] ? null : fence;
      return;
    }
    if (fence !== null) return;
    const normalized = raw
      .toLowerCase()
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized !== "") out.push({ line: index + 1, normalized });
  });
  return out;
}

export interface RawImport {
  readonly line: number;
  readonly target: string;
}

const IMPORT_TOKEN = /(^|\s)@([^\s]+)/g;
const IMPORT_SHAPE = /^[\w.~/-]+$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Heuristic `@path` import extraction: outside code, preceded by whitespace (so emails are skipped) and
 * containing a "/" or a file extension (so @mentions are skipped). It can still misread prose.
 */
export function extractImports(lines: readonly string[], startIndex: number, maxImports: number): RawImport[] {
  const out: RawImport[] = [];
  let fence: string | null = null;
  for (const [index, raw] of lines.entries()) {
    if (index < startIndex) continue;
    const marker = FENCE.exec(raw)?.[1];
    if (marker) {
      fence = fence === null ? marker[0] ?? null : fence === marker[0] ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    for (const match of raw.replace(/`[^`]*`/g, "").matchAll(IMPORT_TOKEN)) {
      const target = (match[2] ?? "").replace(/[.,;:!?)\]]+$/, "");
      if (target === "" || !IMPORT_SHAPE.test(target) || !(target.includes("/") || HAS_EXTENSION.test(target))) continue;
      if (out.length >= maxImports) return out;
      out.push({ line: index + 1, target });
    }
  }
  return out;
}

export interface Directive {
  readonly polarity: "always" | "never";
  /** Unsalted hash of the instruction remainder. Memory only; never persisted. */
  readonly remainderKey: string;
  readonly remainderWords: number;
  readonly line: number;
}

const ALWAYS = /^(?:you\s+)?(?:must\s+)?always\s+(.+)$/;
const NEVER = /^(?:you\s+)?(?:must\s+)?(?:never|do not|don't|dont)\s+(.+)$/;
const MIN_REMAINDER_WORDS = 3;

export function extractDirectives(body: readonly BodyLine[]): Directive[] {
  return body.flatMap(({ line, normalized }): Directive[] => {
    const always = ALWAYS.exec(normalized);
    const never = always ? null : NEVER.exec(normalized);
    const remainder = (always?.[1] ?? never?.[1] ?? "").replace(/[.;:!]+$/, "").trim();
    const words = remainder === "" ? 0 : remainder.split(" ").length;
    if (words < MIN_REMAINDER_WORDS) return [];
    return [{ polarity: always ? "always" : "never", remainderKey: plainHash(remainder), remainderWords: words, line }];
  });
}
