import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { accountUsage, dedupeTools } from "./accounting";
import type { ByteSource } from "./lines";
import { addCounters, emptyCounters, scanStream, type ScanResult } from "./scan";
import { DEFAULT_MAX_LINE_BYTES, type ParseOptions, type ParseResult } from "./types";

function resolveMaxLineBytes(options: ParseOptions): number {
  const max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  return max;
}

function assemble(scans: readonly ScanResult[]): ParseResult {
  const observations = scans.flatMap((scan) => scan.usage);
  const { records, stats } = accountUsage(observations);
  const toolEvents = dedupeTools(scans.flatMap((scan) => scan.tools));
  const counters = scans.reduce((acc, scan) => addCounters(acc, scan.counters), emptyCounters());

  return {
    usageRecords: records,
    toolEvents,
    diagnostics: {
      ...counters,
      ...stats,
      sourcesScanned: scans.length,
      usageRecordsParsed: records.length,
      toolEventsParsed: scans.reduce((n, scan) => n + scan.tools.length, 0),
      toolEventsKept: toolEvents.length,
    },
  };
}

/**
 * Parses caller-supplied byte sources as ONE accounting scope: identity-based deduplication and
 * conflict detection span every source in the call, in the given order.
 */
export async function parseJsonlSources(
  sources: readonly ByteSource[],
  options: ParseOptions = {},
): Promise<ParseResult> {
  const maxLineBytes = resolveMaxLineBytes(options);
  const scans: ScanResult[] = [];
  for (const [index, source] of sources.entries()) {
    scans.push(await scanStream(source, maxLineBytes, index));
  }
  return assemble(scans);
}

export function parseJsonlStream(source: ByteSource, options: ParseOptions = {}): Promise<ParseResult> {
  return parseJsonlSources([source], options);
}

/** Reads exactly the files the caller names, read-only. No directory discovery. */
export async function parseJsonlFiles(
  filePaths: readonly string[],
  options: ParseOptions = {},
): Promise<ParseResult> {
  const maxLineBytes = resolveMaxLineBytes(options);
  const scans: ScanResult[] = [];
  for (const [index, filePath] of filePaths.entries()) {
    const info = await stat(filePath);
    if (!info.isFile()) throw new TypeError("parseJsonlFiles requires regular files");
    scans.push(await scanStream(createReadStream(filePath), maxLineBytes, index));
  }
  return assemble(scans);
}

export function parseJsonlFile(filePath: string, options: ParseOptions = {}): Promise<ParseResult> {
  return parseJsonlFiles([filePath], options);
}
