import type { ApiEnvelope, DataState } from "@/core/analysis";

export type Section = "usage" | "config" | "database" | "any";

const NEXT_STEP: Record<Section, string> = {
  usage:
    "Usage data appears only after you explicitly ingest one transcript file you choose: run `pnpm ingest preview <absolute path>`, then `pnpm ingest run --db <absolute database path> --token <token> <absolute path>` (see the README). The dashboard never searches for transcripts.",
  config:
    "Configuration data appears only after you explicitly scan roots you choose: `pnpm config:scan --db <absolute database path> --user-root <absolute directory> --project-root <absolute directory>` (at least one root; see the README). The dashboard never searches for configuration.",
  any: "Add data explicitly: ingest one transcript file you choose with `pnpm ingest preview` then `pnpm ingest run` (see the README), and/or scan configuration roots you choose with `pnpm config:scan --db <absolute database path> --user-root <absolute directory> --project-root <absolute directory>` (see the README). The dashboard never searches for either.",
  database:
    "Create the database explicitly: `pnpm ingest run --db <absolute path> …` creates it when it ingests a transcript (see the README), or point CLAUDE_CONTROL_DB_PATH at an existing one. The dashboard never creates it.",
};

const UNAVAILABLE_TEXT: Readonly<Record<string, string>> = {
  SCHEMA_OUTDATED: "The database schema is older than this version expects. Open it explicitly (`pnpm ingest run --db <this database> …` or openStore) to migrate it; the dashboard never migrates.",
  SCHEMA_NEWER: "The database was written by a newer version of this app.",
  NOT_INITIALIZED: "The file exists but is not an initialized database.",
  DB_CORRUPT: "The file could not be read as a SQLite database.",
  INVALID_DATABASE_PATH: "The configured database path is not absolute.",
  NOT_A_FILE: "The configured database location is not a regular file.",
  QUERY_FAILED: "A query failed against the database.",
};

/**
 * Shown when no scan has completed but the latest usage scan was partial or failed. A partial scan commits
 * the sources it could read, so records may already be stored; the figures stay hidden until a scan
 * completes. No count is given: the only count available (records inserted by the latest scan) is not the
 * number of records stored.
 */
export function incompleteScanNote(usageScanStatus: string | null | undefined): string | null {
  if (usageScanStatus !== "partial" && usageScanStatus !== "failed") return null;
  return `The latest usage scan is ${usageScanStatus}. Records from sources that were read successfully may already be stored in the database, but no usage figures are shown until a scan completes. Check the scan status on Data quality, then re-run the ingest with a file list in which every file can be read.`;
}

export function describe(state: DataState, errorCode: string | null, section: Section, usageScanStatus?: string | null): { title: string; body: string } {
  const incomplete = (section === "usage" || section === "any") && state === "no-completed-scan" ? incompleteScanNote(usageScanStatus) : null;
  const base = describeState(state, errorCode, section);
  return incomplete ? { title: base.title, body: `${base.body} ${incomplete}` } : base;
}

function describeState(state: DataState, errorCode: string | null, section: Section): { title: string; body: string } {
  if (state === "no-database") return { title: "No database yet", body: `Nothing has been scanned and nothing was created. ${NEXT_STEP.database}${section === "database" ? "" : ` Then: ${NEXT_STEP[section]}`}` };
  if (state === "no-completed-scan" && section === "any") {
    return { title: "No completed scan", body: `The database is usable but contains no completed usage or configuration scan, so there is nothing to base recommendations on. ${NEXT_STEP.any}` };
  }
  if (state === "no-completed-scan") {
    const what = section === "config" ? "configuration" : "usage";
    return { title: `No completed ${what} scan`, body: `The database is usable but contains no completed ${what} scan, so no ${what} figures are shown. ${NEXT_STEP[section]}` };
  }
  return { title: "Database unavailable", body: `${UNAVAILABLE_TEXT[errorCode ?? ""] ?? "The database could not be used."} Code: ${errorCode ?? "UNKNOWN"}.` };
}

export function StateNotice({ envelope, section, usageScanStatus }: { envelope: Pick<ApiEnvelope<unknown>, "state" | "errorCode">; section: Section; usageScanStatus?: string | null }) {
  const { title, body } = describe(envelope.state, envelope.errorCode, section, usageScanStatus);
  return (
    <div role={envelope.state === "unavailable" ? "alert" : "status"} className="rounded-lg border border-dashed border-neutral-400 p-4 dark:border-neutral-600">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{body}</p>
    </div>
  );
}

/** Renders the notice unless the envelope holds data; otherwise renders `children(data)`. */
export function Gate<T>({ envelope, section, usageScanStatus, children }: { envelope: ApiEnvelope<T>; section: Section; usageScanStatus?: string | null; children: (data: T) => React.ReactNode }) {
  return envelope.state === "ok" && envelope.data !== null ? <>{children(envelope.data)}</> : <StateNotice envelope={envelope} section={section} usageScanStatus={usageScanStatus} />;
}

export const Note = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-neutral-600 dark:text-neutral-400">{children}</p>;

