import type { MetaIssue } from "./frontmatter";
import type { SettingsFacts } from "./settings";
import type { BodyLine, Directive, RawImport } from "./text";
import type { ConfigFileRecord } from "./types";

/** In-memory working view of one inventoried file. Never persisted or exported. */
export interface Entry {
  readonly record: ConfigFileRecord;
  /** Path relative to the config directory equivalent. Memory only; not stored. */
  readonly layoutRel: string;
  readonly canonicalPath: string | null;
  readonly body: readonly BodyLine[];
  readonly pathGlobs: readonly string[];
  readonly directives: readonly Directive[];
  readonly settings: SettingsFacts | null;
  readonly metaIssues: readonly MetaIssue[];
  readonly rawImports: readonly RawImport[];
}

export const TEXT_CATEGORIES: ReadonlySet<string> = new Set(["claude_md", "rule", "agent", "skill", "imported"]);

export const isAnalyzedText = (e: Entry): boolean => e.record.status === "ok" && TEXT_CATEGORIES.has(e.record.category);
