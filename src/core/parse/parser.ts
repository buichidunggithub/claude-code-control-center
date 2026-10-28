import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { accountUsage, dedupeTools } from "./accounting";
import type { ByteSource } from "./lines";
import { TEXT_LENGTH_STATES, TOOL_BUCKETS } from "./facts";
import { addCounters, emptyCounters, scanStream, type ScanResult } from "./scan";
import {
  DEFAULT_MAX_LINE_BYTES,
  type ParseFacts,
  type ParseOptions,
  type ParseResult,
  type ToolCallFact,
  type ToolEvent,
} from "./types";

function resolveMaxLineBytes(options: ParseOptions): number {
  const max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  return max;
}

/** Drops the raw tool name: only the bucket survives into facts. */
function toToolCallFact(event: ToolEvent): ToolCallFact {
  return {
    sourceIndex: event.sourceIndex,
    lineNumber: event.lineNumber,
    blockIndex: event.blockIndex,
    toolUseId: event.toolUseId,
    toolBucket: event.toolBucket,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    isSidechain: event.isSidechain,
  };
}

function countBy<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

function assemble(scans: readonly ScanResult[], readPromptLength: boolean): ParseResult {
  const observations = scans.flatMap((scan) => scan.usage);
  const { records, stats } = accountUsage(observations);
  const toolEvents = dedupeTools(scans.flatMap((scan) => scan.tools));
  const facts: ParseFacts = {
    sourceUserEvents: scans.flatMap((scan) => scan.userEvents),
    toolCalls: toolEvents.map(toToolCallFact),
  };
  const counters = scans.reduce((acc, scan) => addCounters(acc, scan.counters), emptyCounters());

  return {
    usageRecords: records,
    toolEvents,
    facts,
    diagnostics: {
      ...counters,
      ...stats,
      sourcesScanned: scans.length,
      usageRecordsParsed: records.length,
      toolEventsParsed: scans.reduce((n, scan) => n + scan.tools.length, 0),
      toolEventsKept: toolEvents.length,
      promptLengthEnabled: readPromptLength,
      sourceUserEventFacts: facts.sourceUserEvents.length,
      textLengthStates: countBy(
        TEXT_LENGTH_STATES,
        facts.sourceUserEvents.map((event) => event.textLength),
      ),
      toolCallsByBucket: countBy(
        TOOL_BUCKETS,
        facts.toolCalls.map((call) => call.toolBucket),
      ),
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
  const readPromptLength = options.readPromptLength === true;
  const scans: ScanResult[] = [];
  for (const [index, source] of sources.entries()) {
    scans.push(await scanStream(source, maxLineBytes, index, { readPromptLength }));
  }
  return assemble(scans, readPromptLength);
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
  const readPromptLength = options.readPromptLength === true;
  const scans: ScanResult[] = [];
  for (const [index, filePath] of filePaths.entries()) {
    const info = await stat(filePath);
    if (!info.isFile()) throw new TypeError("parseJsonlFiles requires regular files");
    scans.push(await scanStream(createReadStream(filePath), maxLineBytes, index, { readPromptLength }));
  }
  return assemble(scans, readPromptLength);
}

export function parseJsonlFile(filePath: string, options: ParseOptions = {}): Promise<ParseResult> {
  return parseJsonlFiles([filePath], options);
}
