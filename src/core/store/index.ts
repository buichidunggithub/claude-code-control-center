export * from "./aggregate";
export {
  latestCommittedRunId,
  listSourceCoverage,
  listSourceIdentities,
  listSourceResults,
  sourceCount,
  sourceCoverageById,
  sourceResultCount,
  type SourceCoverageRow,
  type SourceResultRow,
} from "./coverage";
export { fingerprint, openStore, type Store } from "./database";
export { IngestError, ingestSources, type IngestSummary, type SourceOutcome, type SourceReport } from "./ingest";
export { LATEST_SCHEMA_VERSION, MIGRATIONS, SchemaVersionError, migrate } from "./migrations";
export { CURRENT_FACTS_VERSION, recomputeToolDedup } from "./facts-store";
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
export {
  completedUsageScanCount,
  configActivationCounts,
  configImportStatusCounts,
  configSkipCounts,
  identityUncertainSourceCount,
  latestConfigScan,
  latestUsageScan,
  listUsageRuns,
  usageRunById,
  usageRunCount,
  sidechainStateCounts,
  type ConfigScanStatus,
  type UsageRunRow,
  type UsageScanStatus,
} from "./status";
export { currentSchemaVersion } from "./migrations";
