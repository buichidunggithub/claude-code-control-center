import {
  TOKEN_FIELDS,
  type AccountingState,
  type TokenCount,
  type ToolEvent,
  type UsageObservation,
  type UsageRecord,
} from "./types";

export interface AccountingStats {
  readonly accounting: Readonly<Record<AccountingState, number>>;
  readonly conflictGroups: number;
  readonly conflictGroupsComparable: number;
  readonly conflictGroupsContradictory: number;
  readonly duplicateMetadataMismatches: number;
  readonly identicalPayloadDistinctIdentities: number;
}

export interface AccountedUsage {
  readonly records: readonly UsageRecord[];
  readonly stats: AccountingStats;
}

type Observations = readonly UsageObservation[];

export function counterValue(count: TokenCount): number {
  return count.kind === "value" ? count.value : 0;
}

/** Exact counter state tuple, so missing, null, invalid and 0 stay distinct. */
export function snapshotKey(tokens: UsageObservation["tokens"]): string {
  return TOKEN_FIELDS.map((field) => {
    const count = tokens[field];
    return count.kind === "value" ? `v${count.value}` : count.kind;
  }).join("|");
}

function groupIndicesByIdentity(observations: Observations): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  observations.forEach((observation, index) => {
    if (observation.eventKey === null) return;
    const members = groups.get(observation.eventKey);
    if (members) members.push(index);
    else groups.set(observation.eventKey, [index]);
  });
  return groups;
}

function vectorOf(observation: UsageObservation): readonly number[] {
  return TOKEN_FIELDS.map((field) => counterValue(observation.tokens[field]));
}

function isOrdered(a: readonly number[], b: readonly number[]): boolean {
  return a.every((v, i) => v <= (b[i] ?? 0)) || b.every((v, i) => v <= (a[i] ?? 0));
}

/** True when every pair of distinct snapshots is field-wise ordered. Says nothing about which is final. */
function snapshotsComparable(snapshots: Observations): boolean {
  const vectors = snapshots.map(vectorOf);
  return vectors.every((a, i) => vectors.slice(i + 1).every((b) => isOrdered(a, b)));
}

function metadataDiffers(a: UsageObservation, b: UsageObservation): boolean {
  return a.sessionId !== b.sessionId || a.model !== b.model || a.isSidechain !== b.isSidechain;
}

/**
 * Assigns an accounting state to every usage event. Input order is the only tie-breaker, and it is
 * used solely to pick which of several IDENTICAL records represents the group, so the result for
 * totals is independent of source order. Counter conflicts are never resolved by position.
 */
export function accountUsage(observations: Observations): AccountedUsage {
  const assigned = observations.map(() => ({
    accounting: "ambiguous" as AccountingState,
    groupSize: 1,
  }));
  let conflictGroups = 0;
  let conflictGroupsComparable = 0;
  let duplicateMetadataMismatches = 0;
  const identitiesByPayload = new Map<string, number>();

  for (const indices of groupIndicesByIdentity(observations).values()) {
    const members = indices.flatMap((i) => {
      const member = observations[i];
      return member ? [member] : [];
    });
    const first = members[0];
    if (!first) continue;

    const distinct = new Map(members.map((m) => [snapshotKey(m.tokens), m]));
    if (distinct.size === 1) {
      const payload = snapshotKey(first.tokens);
      identitiesByPayload.set(payload, (identitiesByPayload.get(payload) ?? 0) + 1);
    }
    indices.forEach((memberIndex, position) => {
      const member = observations[memberIndex];
      const accounting: AccountingState =
        distinct.size > 1 ? "conflicting" : position === 0 ? "accepted" : "duplicate";
      assigned[memberIndex] = { accounting, groupSize: indices.length };
      if (accounting === "duplicate" && member && metadataDiffers(first, member)) {
        duplicateMetadataMismatches += 1;
      }
    });
    if (distinct.size > 1) {
      conflictGroups += 1;
      if (snapshotsComparable([...distinct.values()])) conflictGroupsComparable += 1;
    }
  }

  const records = observations.map((observation, index) => ({
    ...observation,
    accounting: assigned[index]?.accounting ?? "ambiguous",
    groupSize: assigned[index]?.groupSize ?? 1,
  }));
  const counts = { accepted: 0, duplicate: 0, conflicting: 0, ambiguous: 0 };
  for (const record of records) counts[record.accounting] += 1;

  return {
    records,
    stats: {
      accounting: counts,
      conflictGroups,
      conflictGroupsComparable,
      conflictGroupsContradictory: conflictGroups - conflictGroupsComparable,
      duplicateMetadataMismatches,
      identicalPayloadDistinctIdentities: [...identitiesByPayload.values()].filter((n) => n > 1).length,
    },
  };
}

/** Tool events are keyed by tool_use id; events without an id are kept. */
export function dedupeTools(events: readonly ToolEvent[]): readonly ToolEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.toolUseId === null) return true;
    if (seen.has(event.toolUseId)) return false;
    seen.add(event.toolUseId);
    return true;
  });
}
