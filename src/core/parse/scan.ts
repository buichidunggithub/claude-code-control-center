import { readBoundedLines, type ByteSource } from "./lines";
import { isRecord, normalizeEvent } from "./normalize";
import {
  EVENT_TYPE_BUCKETS,
  TOKEN_FIELDS,
  type EventTypeBucket,
  type TokenFieldIssues,
  type TokenFieldName,
  type ToolEvent,
  type UsageObservation,
  type SourceUserEventFact,
} from "./types";

const UTF8_BOM = "﻿";

export interface ScanCounters {
  readonly linesRead: number;
  readonly blankLines: number;
  readonly malformedLines: number;
  readonly oversizedLines: number;
  readonly nonObjectLines: number;
  readonly eventsWithoutUsage: number;
  readonly usageObjectsMalformed: number;
  readonly unusableTimestamps: number;
  readonly missingSessionIds: number;
  readonly missingModels: number;
  readonly sidechainRecords: number;
  readonly unrecognizedUsageKeyCount: number;
  readonly eventsByType: Readonly<Record<EventTypeBucket, number>>;
  readonly tokenFieldIssues: Readonly<Record<TokenFieldName, TokenFieldIssues>>;
}

export interface ScanResult {
  readonly usage: readonly UsageObservation[];
  readonly tools: readonly ToolEvent[];
  readonly userEvents: readonly SourceUserEventFact[];
  readonly counters: ScanCounters;
}

const SCALAR_COUNTERS = [
  "linesRead",
  "blankLines",
  "malformedLines",
  "oversizedLines",
  "nonObjectLines",
  "eventsWithoutUsage",
  "usageObjectsMalformed",
  "unusableTimestamps",
  "missingSessionIds",
  "missingModels",
  "sidechainRecords",
  "unrecognizedUsageKeyCount",
] as const;

export function emptyCounters(): ScanCounters {
  return {
    ...(Object.fromEntries(SCALAR_COUNTERS.map((k) => [k, 0])) as Record<(typeof SCALAR_COUNTERS)[number], number>),
    eventsByType: Object.fromEntries(EVENT_TYPE_BUCKETS.map((b) => [b, 0])) as Record<EventTypeBucket, number>,
    tokenFieldIssues: Object.fromEntries(
      TOKEN_FIELDS.map((f) => [f, { missing: 0, null: 0, invalid: 0 }]),
    ) as Record<TokenFieldName, TokenFieldIssues>,
  };
}

export function addCounters(a: ScanCounters, b: ScanCounters): ScanCounters {
  return {
    ...(Object.fromEntries(SCALAR_COUNTERS.map((k) => [k, a[k] + b[k]])) as Record<(typeof SCALAR_COUNTERS)[number], number>),
    eventsByType: Object.fromEntries(EVENT_TYPE_BUCKETS.map((k) => [k, a.eventsByType[k] + b.eventsByType[k]])) as Record<EventTypeBucket, number>,
    tokenFieldIssues: Object.fromEntries(
      TOKEN_FIELDS.map((f) => [
        f,
        {
          missing: a.tokenFieldIssues[f].missing + b.tokenFieldIssues[f].missing,
          null: a.tokenFieldIssues[f].null + b.tokenFieldIssues[f].null,
          invalid: a.tokenFieldIssues[f].invalid + b.tokenFieldIssues[f].invalid,
        },
      ]),
    ) as Record<TokenFieldName, TokenFieldIssues>,
  };
}

/** Scans one byte source. Counters are accumulated locally and returned as plain numbers. */
export async function scanStream(
  source: ByteSource,
  maxLineBytes: number,
  sourceIndex: number,
  options: { readonly readPromptLength?: boolean } = {},
): Promise<ScanResult> {
  const usage: UsageObservation[] = [];
  const tools: ToolEvent[] = [];
  const userEvents: SourceUserEventFact[] = [];
  const c = { ...emptyCounters() } as { -readonly [K in keyof ScanCounters]: ScanCounters[K] };
  const eventsByType = { ...c.eventsByType };
  const issues = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, { missing: 0, null: 0, invalid: 0 }])) as Record<
    TokenFieldName,
    { missing: number; null: number; invalid: number }
  >;

  for await (const line of readBoundedLines(source, maxLineBytes)) {
    c.linesRead += 1;
    if (line.kind === "oversized") {
      c.oversizedLines += 1;
      continue;
    }
    const text = (line.lineNumber === 1 && line.text.startsWith(UTF8_BOM) ? line.text.slice(1) : line.text).replace(/\r$/, "");
    if (text.trim() === "") {
      c.blankLines += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Counted, never logged: the error message could quote source text.
      c.malformedLines += 1;
      continue;
    }
    if (!isRecord(value)) {
      c.nonObjectLines += 1;
      continue;
    }

    const observation = normalizeEvent(
      value,
      { sourceIndex, lineNumber: line.lineNumber },
      { readPromptLength: options.readPromptLength === true },
    );
    eventsByType[observation.eventType] += 1;
    tools.push(...observation.tools);
    if (observation.userEvent !== null) userEvents.push(observation.userEvent);
    c.unrecognizedUsageKeyCount += observation.unrecognizedUsageKeyCount;
    if (observation.usageStatus === "absent") c.eventsWithoutUsage += 1;
    if (observation.usageStatus === "malformed") c.usageObjectsMalformed += 1;

    const record = observation.usage;
    if (record === null) continue;
    usage.push(record);
    if (record.timestamp === null) c.unusableTimestamps += 1;
    if (record.sessionId === null) c.missingSessionIds += 1;
    if (record.model === null) c.missingModels += 1;
    if (record.isSidechain === true) c.sidechainRecords += 1;
    for (const field of TOKEN_FIELDS) {
      const kind = record.tokens[field].kind;
      if (kind !== "value") issues[field][kind] += 1;
    }
  }
  return { usage, tools, userEvents, counters: { ...c, eventsByType, tokenFieldIssues: issues } };
}
