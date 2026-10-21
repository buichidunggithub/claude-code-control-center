import type { Store } from "./database";
import { ingestSources, type IngestOptions, type IngestSummary } from "./ingest";
import { readSource, type ReadSourceOptions } from "./source-reader";

/** Reads exactly the listed files (no discovery), then ingests them as one atomic scan. */
export async function scanAndIngest(
  store: Store,
  filePaths: readonly string[],
  options: ReadSourceOptions & IngestOptions = {},
): Promise<IngestSummary> {
  const inputs = [];
  for (const filePath of filePaths) inputs.push(await readSource(store, filePath, options));
  return ingestSources(store, inputs, options);
}
