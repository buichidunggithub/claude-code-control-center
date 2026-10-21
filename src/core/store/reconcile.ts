import type { DatabaseSync } from "node:sqlite";
import { accountUsage } from "../parse/accounting";
import {
  TOKEN_FIELDS,
  type EventTypeBucket,
  type IdentityKind,
  type TokenCount,
  type TokenFieldName,
  type UsageObservation,
} from "../parse/types";
import { all, num, optNum, optStr, run, str, type Row } from "./sql";

export const TOKEN_COLUMN_PREFIX: Readonly<Record<TokenFieldName, string>> = {
  inputTokens: "in",
  outputTokens: "out",
  cacheReadTokens: "cr",
  cacheCreationTokens: "cc",
};

function tokenFromColumns(row: Row, prefix: string): TokenCount {
  const state = str(row, `${prefix}_state`);
  if (state === "value") return { kind: "value", value: num(row, `${prefix}_value`) };
  if (state === "missing" || state === "null" || state === "invalid") return { kind: state };
  throw new TypeError("unknown token state");
}

function observationFromRow(row: Row, eventKey: string): UsageObservation {
  const sidechain = optNum(row, "is_sidechain");
  return {
    sourceIndex: 0,
    lineNumber: num(row, "line_number"),
    eventKey,
    identity: str(row, "identity_kind") as IdentityKind,
    eventType: str(row, "event_type") as EventTypeBucket,
    timestamp: optStr(row, "ts"),
    sessionId: row["session_id"] === null ? null : String(num(row, "session_id")),
    model: optStr(row, "model"),
    isSidechain: sidechain === null ? null : sidechain === 1,
    tokens: Object.fromEntries(
      TOKEN_FIELDS.map((field) => [field, tokenFromColumns(row, TOKEN_COLUMN_PREFIX[field])]),
    ) as Record<TokenFieldName, TokenCount>,
  };
}

/**
 * Recomputes the accounting state of every record sharing one of the given identities, across ALL
 * sources, with the same M1.1 policy as the in-memory parser. Representative choice for identical
 * repeats is ordered by source fingerprint then line, so totals never depend on ingestion order.
 */
export function recomputeAccounting(db: DatabaseSync, eventKeyFingerprints: ReadonlySet<string>): void {
  for (const eventKeyFp of [...eventKeyFingerprints].sort()) {
    const rows = all(
      db,
      `SELECT ur.*, sf.fingerprint AS source_fp
         FROM usage_records ur JOIN source_files sf ON sf.id = ur.source_file_id
        WHERE ur.event_key_fp = ?
        ORDER BY sf.fingerprint, ur.line_number`,
      eventKeyFp,
    );
    const { records } = accountUsage(rows.map((row) => observationFromRow(row, eventKeyFp)));
    rows.forEach((row, index) => {
      const record = records[index];
      if (!record) return;
      if (str(row, "accounting") === record.accounting && num(row, "group_size") === record.groupSize) return;
      run(db, "UPDATE usage_records SET accounting = ?, group_size = ? WHERE id = ?", record.accounting, record.groupSize, num(row, "id"));
    });
  }
}
