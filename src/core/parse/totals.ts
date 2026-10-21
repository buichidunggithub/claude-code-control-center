import { counterValue, snapshotKey } from "./accounting";
import { TOKEN_FIELDS, type TokenFieldName, type UsageRecord } from "./types";

export type TokenSums = Readonly<Record<TokenFieldName, number>>;

export interface AccountingSummary {
  /** Accepted records only: each identity counted once, with no unresolved disagreement. */
  readonly settled: TokenSums & { readonly records: number };
  /** Identities seen with differing counters. Real usage lies in [lower, upper] per field, assuming one of the snapshots is right. */
  readonly conflicting: { readonly groups: number; readonly lower: TokenSums; readonly upper: TokenSums };
  /**
   * No-identity records. `ifRepeats` counts each distinct counter tuple once (identical lines are
   * repeats); `ifDistinct` counts every line (identical lines are separate calls).
   */
  readonly ambiguous: {
    readonly records: number;
    readonly ifRepeats: TokenSums;
    readonly ifDistinct: TokenSums;
  };
  readonly duplicates: number;
}

export interface SummaryOptions {
  readonly includeSidechain?: boolean;
}

const ZERO: TokenSums = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function addSums(a: TokenSums, b: TokenSums): TokenSums {
  const total = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, a[f] + b[f]])) as Record<TokenFieldName, number>;
  for (const value of Object.values(total)) {
    if (!Number.isSafeInteger(value)) throw new RangeError("token total exceeds safe integer range");
  }
  return total;
}

/** Missing, null and invalid counters contribute 0 here; the raw states stay on each record. */
function sumsOf(record: UsageRecord): TokenSums {
  return Object.fromEntries(TOKEN_FIELDS.map((f) => [f, counterValue(record.tokens[f])])) as Record<TokenFieldName, number>;
}

function combine(sums: readonly TokenSums[], pick: (a: number, b: number) => number): TokenSums {
  const [head, ...rest] = sums;
  if (!head) return ZERO;
  return rest.reduce<TokenSums>(
    (acc, next) => Object.fromEntries(TOKEN_FIELDS.map((f) => [f, pick(acc[f], next[f])])) as Record<TokenFieldName, number>,
    head,
  );
}

const total = (sums: readonly TokenSums[]): TokenSums => sums.reduce(addSums, ZERO);

export function summarizeAccounting(
  records: readonly UsageRecord[],
  options: SummaryOptions = {},
): AccountingSummary {
  const { includeSidechain = true } = options;
  const selected = records.filter((r) => includeSidechain || r.isSidechain !== true);
  const state = (s: UsageRecord["accounting"]) => selected.filter((r) => r.accounting === s);

  const accepted = state("accepted");
  const conflictsByIdentity = new Map<string, Map<string, TokenSums>>();
  for (const record of state("conflicting")) {
    const snapshots = conflictsByIdentity.get(record.eventKey ?? "") ?? new Map<string, TokenSums>();
    snapshots.set(snapshotKey(record.tokens), sumsOf(record));
    conflictsByIdentity.set(record.eventKey ?? "", snapshots);
  }
  const ranges = [...conflictsByIdentity.values()].map((s) => [...s.values()]);

  const ambiguous = state("ambiguous");
  const distinctPayloads = new Map(ambiguous.map((r) => [snapshotKey(r.tokens), sumsOf(r)]));

  return {
    settled: { ...total(accepted.map(sumsOf)), records: accepted.length },
    conflicting: {
      groups: ranges.length,
      lower: total(ranges.map((snapshots) => combine(snapshots, Math.min))),
      upper: total(ranges.map((snapshots) => combine(snapshots, Math.max))),
    },
    ambiguous: {
      records: ambiguous.length,
      ifRepeats: total([...distinctPayloads.values()]),
      ifDistinct: total(ambiguous.map(sumsOf)),
    },
    duplicates: state("duplicate").length,
  };
}
