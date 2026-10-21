export * from "./aggregate";
export { fingerprint, openStore, type Store } from "./database";
export { IngestError, ingestSources, type IngestSummary, type SourceOutcome, type SourceReport } from "./ingest";
export { LATEST_SCHEMA_VERSION, MIGRATIONS, SchemaVersionError, migrate } from "./migrations";
export { defaultDatabasePath } from "./paths";
export { scanAndIngest } from "./scan";
export { readSource, type SourceInput, type SourceScan } from "./source-reader";
export {
  ConfigStoreError,
  configInventorySummary,
  currentConfigScanId,
  listConfigFindings,
  saveConfigInventory,
  type ConfigSummaryRow,
  type StoredFinding,
} from "./config-store";
