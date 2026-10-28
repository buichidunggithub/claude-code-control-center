/**
 * Read-only analysis operations. Calculations are the existing store/accounting functions; this layer
 * only selects, bounds, redacts and shapes. It performs no writes and accepts no SQL or paths.
 */
import type { DatabaseSync } from "node:sqlite";
import { TOKEN_FIELDS, type TokenFieldName } from "../parse/types";
import { RULES, isSafeEvidence } from "../config";
import { UNRECOGNIZED_MODEL_LABEL, compareCodeUnits, recognizeModelName, recommend, type EngineFinding, type EngineInput } from "../recommend";
import {
  accountingStateCounts,
  accountingSummary,
  completedUsageScanCount,
  configActivationCounts,
  configImportStatusCounts,
  configInventorySummary,
  identityUncertainSourceCount,
  sidechainStateCounts,
  configSkipCounts,
  currentConfigScanId,
  latestConfigScan,
  latestUsageScan,
  listConfigFindings,
  scanDiagnostics,
  settledByDate,
  settledByModel,
  settledBySession,
  tokenFieldStateCounts,
  currentSchemaVersion,
  type SettledGroup,
  type StoredFinding,
} from "../store";
import { analyticsSessionDetail, analyticsSessions, analyticsSummary, analyticsTools, analyticsTrends } from "./analytics";
import type { SessionDetailQuery, TrendsQuery } from "./analytics-params";
import type { AnalyticsSessionDetail, AnalyticsSessions, AnalyticsSummary, AnalyticsTools, AnalyticsTrends } from "./analytics-types";
import { SEVERITIES, type PageParams, type DayQuery, type FindingsQuery, type PagedSidechainQuery, type RecommendationsQuery, type RunDetailQuery, type RunsQuery, type SidechainQuery, type SourceDetailQuery, type SourcesQuery } from "./params";
import { countBy } from "./counts";
import { sourceCoverage, sourceDetail } from "./coverage";
import { runDetail, runHistory } from "./history";
import { withDatabase, type SectionGate } from "./reader";
import {
  CONFIG_NOTE,
  RECOMMENDATIONS_NOTE,
  FINDINGS_NOTE,
  type ApiEnvelope,
  type ConfigSummary,
  type DayBreakdown,
  type FindingItem,
  type FindingsPage,
  type ModelBreakdown,
  type RecommendationsPage,
  type RunDetailReport,
  type RunHistoryPage,
  type SessionBreakdown,
  type SourceCoveragePage,
  type SourceDetailReport,
  type SourceBreakdown,
  type StatusReport,
  type UsageQuality,
  type UsageSummary,
} from "./types";

const SESSION_ID_CHARS = 16;
const TEXT_CAP = 1000;

const usageReady = (db: DatabaseSync): boolean => completedUsageScanCount(db) > 0;
const configReady = (db: DatabaseSync): boolean => currentConfigScanId(db) !== null;
const ready = (db: DatabaseSync, gate: SectionGate): boolean =>
  gate === "usage" ? usageReady(db) : gate === "config" ? configReady(db) : gate === "any" ? usageReady(db) || configReady(db) : true;
const slice = <T,>(items: readonly T[], limit: number, offset: number): T[] => items.slice(offset, offset + limit);
const breakdown = (g: SettledGroup<string>): SourceBreakdown => ({ key: g.key, records: g.records, tokens: g.tokens });
const sidechainOptions = (q: SidechainQuery) => ({ includeSidechain: q.sidechain === "include" });

/**
 * Model names come from transcripts. Recognized identifiers are canonicalized (lower case) and rows that
 * share a canonical name are summed, exactly as the recommendation engine does. Anything that is not a
 * plain identifier is never echoed: all such names are merged into one placeholder row. The "no model
 * recorded" row (null key) stays separate. Totals are unchanged by the merging; rows are ordered by code
 * unit of the canonical name, then the placeholder, then the null row.
 */
function canonicalizeModelRows(items: readonly SourceBreakdown[]): SourceBreakdown[] {
  const add = (a: SourceBreakdown, b: SourceBreakdown): SourceBreakdown => ({
    key: a.key,
    records: a.records + b.records,
    tokens: Object.fromEntries(TOKEN_FIELDS.map((f) => [f, a.tokens[f] + b.tokens[f]])) as Record<TokenFieldName, number>,
  });
  const recognized = new Map<string, SourceBreakdown>();
  let unrecognized: SourceBreakdown | null = null;
  let none: SourceBreakdown | null = null;
  for (const item of items) {
    if (item.key === null) {
      none = none === null ? item : add(none, item);
      continue;
    }
    const canonical = recognizeModelName(item.key);
    if (canonical === null) {
      unrecognized = unrecognized === null ? { ...item, key: UNRECOGNIZED_MODEL_LABEL } : add(unrecognized, item);
      continue;
    }
    const prior = recognized.get(canonical);
    recognized.set(canonical, prior === undefined ? { ...item, key: canonical } : add(prior, item));
  }
  const ordered = [...recognized.values()].sort((a, b) => compareCodeUnits(a.key ?? "", b.key ?? ""));
  return [...ordered, ...(unrecognized ? [unrecognized] : []), ...(none ? [none] : [])];
}

const ACCOUNTING_STATES = ["accepted", "duplicate", "conflicting", "ambiguous"] as const;

/** Fails closed if the table holds a state this version does not know, instead of echoing database text. */
function knownStateCounts(db: DatabaseSync): Record<(typeof ACCOUNTING_STATES)[number], number> {
  const counts = accountingStateCounts(db);
  if (Object.keys(counts).some((k) => !(ACCOUNTING_STATES as readonly string[]).includes(k))) throw new TypeError("unknown accounting state");
  return counts;
}

/** Sidechain-flagged records by accounting state; fails closed on a state this version does not know. */
function knownSidechainCounts(db: DatabaseSync): Record<(typeof ACCOUNTING_STATES)[number], number> {
  const raw = sidechainStateCounts(db);
  if (Object.keys(raw).some((k) => !(ACCOUNTING_STATES as readonly string[]).includes(k))) throw new TypeError("unknown accounting state");
  return { accepted: raw["accepted"] ?? 0, duplicate: raw["duplicate"] ?? 0, conflicting: raw["conflicting"] ?? 0, ambiguous: raw["ambiguous"] ?? 0 };
}

function toFinding(f: StoredFinding): FindingItem {
  const safe = isSafeEvidence(f.evidence);
  return {
    id: f.key,
    ruleId: f.ruleId,
    ruleVersion: f.ruleVersion,
    ruleTitle: Object.hasOwn(RULES, f.ruleId) ? RULES[f.ruleId as keyof typeof RULES].title : null,
    severity: f.severity,
    confidence: f.confidence,
    sourceId: f.sourceId,
    relatedSourceId: f.relatedSourceId,
    evidence: safe ? f.evidence : {},
    evidenceRedacted: !safe,
    limitations: f.limitations.slice(0, TEXT_CAP),
    recommendation: f.recommendation.slice(0, TEXT_CAP),
  };
}

export interface Analysis {
  status(): ApiEnvelope<StatusReport>;
  usageSummary(q: SidechainQuery): ApiEnvelope<UsageSummary>;
  usageByModel(q: PagedSidechainQuery): ApiEnvelope<ModelBreakdown>;
  usageByDay(q: DayQuery): ApiEnvelope<DayBreakdown>;
  usageSessions(q: PagedSidechainQuery): ApiEnvelope<SessionBreakdown>;
  usageQuality(): ApiEnvelope<UsageQuality>;
  configSummary(): ApiEnvelope<ConfigSummary>;
  configFindings(q: FindingsQuery): ApiEnvelope<FindingsPage>;
  recommendations(q: RecommendationsQuery): ApiEnvelope<RecommendationsPage>;
  runHistory(q: RunsQuery): ApiEnvelope<RunHistoryPage>;
  runDetail(q: RunDetailQuery): ApiEnvelope<RunDetailReport>;
  sourceCoverage(q: SourcesQuery): ApiEnvelope<SourceCoveragePage>;
  sourceDetail(q: SourceDetailQuery): ApiEnvelope<SourceDetailReport>;
  analyticsSummary(): ApiEnvelope<AnalyticsSummary>;
  analyticsTrends(q: TrendsQuery): ApiEnvelope<AnalyticsTrends>;
  analyticsTools(): ApiEnvelope<AnalyticsTools>;
  analyticsSessions(q: PageParams): ApiEnvelope<AnalyticsSessions>;
  analyticsSessionDetail(q: SessionDetailQuery): ApiEnvelope<AnalyticsSessionDetail>;
}

const sumFieldStates = (counts: ReturnType<typeof tokenFieldStateCounts>, state: "invalid" | "missing"): number =>
  Object.values(counts).reduce((n, field) => n + field[state], 0);

function toEngineFinding(item: FindingItem): EngineFinding {
  return { id: item.id, sourceId: item.sourceId, ruleId: item.ruleId, ruleVersion: item.ruleVersion, severity: item.severity, confidence: item.confidence, evidence: item.evidence };
}

/** Gathers engine input from the existing core aggregates and findings; a section without a completed scan is null. */
function engineInput(db: DatabaseSync): EngineInput {
  const config = configReady(db)
    ? { findings: listConfigFindings(db).map(toFinding).map(toEngineFinding), activation: configActivationCounts(db) }
    : null;
  if (!usageReady(db)) return { config, usage: null };

  const summary = accountingSummary(db, { includeSidechain: true });
  const stateCounts = knownStateCounts(db);
  const sidechain = knownSidechainCounts(db);
  const fieldStates = tokenFieldStateCounts(db);
  return {
    config,
    usage: {
      settledRecords: summary.settled.records,
      settledSidechainRecords: sidechain.accepted,
      conflictingSidechainRecords: sidechain.conflicting,
      ambiguousSidechainRecords: sidechain.ambiguous,
      conflictingGroups: summary.conflicting.groups,
      // Records inside conflicting groups (all stored records, like the other unresolved figures here).
      conflictingRecords: stateCounts.conflicting,
      ambiguousRecords: summary.ambiguous.records,
      duplicates: summary.duplicates,
      identityUncertainSources: identityUncertainSourceCount(db),
      invalidCounterValues: sumFieldStates(fieldStates, "invalid"),
      missingCounterValues: sumFieldStates(fieldStates, "missing"),
      models: settledByModel(db, { includeSidechain: true }).map((g) => ({ name: g.key, records: g.records, outputTokens: g.tokens.outputTokens })),
    },
  };
}

/** `databasePath` is fixed at construction by the server; no request can change it. */
export function createAnalysis(databasePath: string): Analysis {
  const run = <T,>(gate: SectionGate, work: (db: DatabaseSync) => T) => withDatabase(databasePath, gate, ready, work);

  return {
    status: () =>
      run("none", (db): StatusReport => {
        const completed = completedUsageScanCount(db);
        return {
          schemaVersion: currentSchemaVersion(db),
          usage: { state: completed > 0 ? "ok" : "no-completed-scan", completedScans: completed, latestScan: latestUsageScan(db) },
          config: { state: currentConfigScanId(db) !== null ? "ok" : "no-completed-scan", latestScan: latestConfigScan(db) },
        };
      }),

    usageSummary: (q) =>
      run("usage", (db): UsageSummary => {
        const { settled, conflicting, ambiguous, duplicates } = accountingSummary(db, sidechainOptions(q));
        return { sidechain: q.sidechain, settled, conflicting, ambiguous, duplicates, stateCounts: knownStateCounts(db) };
      }),

    usageByModel: (q) =>
      run("usage", (db): ModelBreakdown => {
        const all = canonicalizeModelRows(settledByModel(db, sidechainOptions(q)).map(breakdown));
        return { sidechain: q.sidechain, limit: q.limit, offset: q.offset, total: all.length, items: slice(all, q.limit, q.offset) };
      }),

    usageByDay: (q) =>
      run("usage", (db): DayBreakdown => {
        const all = settledByDate(db, sidechainOptions(q));
        // Newest first. Core aggregates are ascending; ordering is applied before the range filter and paging.
        const dated = all
          .filter((g) => g.key !== null && (q.from === null || g.key >= q.from) && (q.to === null || g.key <= q.to))
          .sort((a, b) => (a.key === b.key ? 0 : (a.key ?? "") < (b.key ?? "") ? 1 : -1));
        const undated = all.find((g) => g.key === null);
        return {
          sidechain: q.sidechain,
          from: q.from,
          to: q.to,
          limit: q.limit,
          offset: q.offset,
          total: dated.length,
          items: slice(dated, q.limit, q.offset).map(breakdown),
          undated: undated ? breakdown(undated) : null,
        };
      }),

    usageSessions: (q) =>
      run("usage", (db): SessionBreakdown => {
        const all = settledBySession(db, sidechainOptions(q));
        return {
          sidechain: q.sidechain,
          limit: q.limit,
          offset: q.offset,
          total: all.length,
          items: slice(all, q.limit, q.offset).map((g) => ({
            id: g.key === null ? null : g.key.slice(0, SESSION_ID_CHARS),
            records: g.records,
            tokens: g.tokens,
            firstTimestamp: g.firstTimestamp,
            lastTimestamp: g.lastTimestamp,
          })),
        };
      }),

    usageQuality: () =>
      run("usage", (db): UsageQuality => {
        const diagnostics = scanDiagnostics(db);
        const sum = (pick: (s: NonNullable<typeof diagnostics>["sources"][number]) => number) => (diagnostics?.sources ?? []).reduce((total, s) => total + pick(s), 0);
        return {
          stateCounts: knownStateCounts(db),
          identityUncertainSources: identityUncertainSourceCount(db),
          tokenFieldStates: tokenFieldStateCounts(db),
          latestScan: diagnostics && {
            id: diagnostics.scanRunId,
            status: diagnostics.status,
            errorCode: diagnostics.errorCode,
            sources: diagnostics.sources.length,
            outcomes: countBy(diagnostics.sources, (s) => s.outcome),
            errorCodes: countBy(diagnostics.sources.filter((s) => s.errorCode !== null), (s) => s.errorCode ?? "UNKNOWN"),
            anonymousIdentityUncertainSources: diagnostics.sources.filter((s) => s.anonymousIdentityUncertain).length,
            skippedLines: {
              blank: sum((s) => s.skipped.blank),
              malformed: sum((s) => s.skipped.malformed),
              oversized: sum((s) => s.skipped.oversized),
              nonObject: sum((s) => s.skipped.nonObject),
              usageObjectsMalformed: sum((s) => s.skipped.usageObjectsMalformed),
            },
            eventsWithoutUsage: sum((s) => s.eventsWithoutUsage),
            unusableTimestamps: sum((s) => s.unusableTimestamps),
            unrecognizedUsageKeys: sum((s) => s.unrecognizedUsageKeyCount),
          },
        };
      }),

    configSummary: () =>
      run("config", (db): ConfigSummary => ({
        scan: latestConfigScan(db),
        rows: configInventorySummary(db),
        activation: configActivationCounts(db),
        skippedByCode: configSkipCounts(db),
        importsByStatus: configImportStatusCounts(db),
        note: CONFIG_NOTE,
      })),

    configFindings: (q) =>
      run("config", (db): FindingsPage => {
        const all = listConfigFindings(db).map(toFinding);
        const filtered = all.filter((f) => (q.severity === null || f.severity === q.severity) && (q.ruleId === null || f.ruleId === q.ruleId));
        const bySeverity = countBy(all, (f) => f.severity);
        return {
          limit: q.limit,
          offset: q.offset,
          total: filtered.length,
          filter: { severity: q.severity, ruleId: q.ruleId },
          items: slice(filtered, q.limit, q.offset),
          bySeverity: Object.fromEntries(SEVERITIES.filter((s) => bySeverity[s]).map((s) => [s, bySeverity[s] ?? 0])),
          byRule: countBy(all, (f) => f.ruleId),
          note: FINDINGS_NOTE,
        };
      }),

    // History is meaningful without a completed scan (a failed run is exactly what it must show), so no gate.
    runHistory: (q) => run("none", (db) => runHistory(db, q)),

    runDetail: (q) => run("none", (db) => runDetail(db, q)),

    sourceCoverage: (q) => run("none", (db) => sourceCoverage(db, q)),

    sourceDetail: (q) => run("none", (db) => sourceDetail(db, q)),

    // Event facts depend on a completed scan like usage does; "no facts collected" is a state inside the payload.
    analyticsSummary: () => run("usage", analyticsSummary),
    analyticsTrends: (q) => run("usage", (db) => analyticsTrends(db, q)),
    analyticsTools: () => run("usage", analyticsTools),
    analyticsSessions: (q) => run("usage", (db) => analyticsSessions(db, q)),
    analyticsSessionDetail: (q) => run("usage", (db) => analyticsSessionDetail(db, q)),

    recommendations: (q) =>
      run("any", (db): RecommendationsPage => {
        const input = engineInput(db);
        const result = recommend(input);
        const all = result.recommendations;
        const matching = all.filter((r) => (q.category === null || r.category === q.category) && (q.priority === null || r.priority === q.priority));
        return {
          limit: q.limit,
          offset: q.offset,
          total: matching.length,
          filter: { category: q.category, priority: q.priority },
          items: slice(matching, q.limit, q.offset),
          byCategory: countBy(all, (r) => r.category),
          byPriority: countBy(all, (r) => r.priority),
          rules: result.rules,
          availability: { usage: input.usage !== null, config: input.config !== null },
          note: RECOMMENDATIONS_NOTE,
        };
      }),
  };
}
