/**
 * Public types for the read-only configuration inventory.
 *
 * ASSUMPTION: the file layout below follows the documented Claude Code layout as understood when
 * this was written. It is validated only against synthetic trees. Detecting a file never means it
 * is loaded: `activation` never claims a file is active.
 */

export type RootKind = "user-config" | "project";
export type ConfigScope = "user" | "project";
export type ConfigCategory = "claude_md" | "rule" | "agent" | "skill" | "settings" | "imported";

/** What we can honestly say about activation. There is deliberately no "loaded" value. */
export type ActivationStatus = "unverified-candidate" | "conditional" | "on-demand" | "import-only" | "unknown";

export type Severity = "info" | "low" | "medium" | "high";
export type Confidence = "high" | "medium" | "low";

/** Caller-supplied, explicit root. `user-config` is the user's Claude config directory itself. */
export interface ConfigRoot {
  readonly kind: RootKind;
  readonly dir: string;
}

export const LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxFiles: 500,
  maxImportedFiles: 200,
  maxDirEntries: 1000,
  maxEnumDepth: 6,
  maxImportDepth: 5,
  maxJsonDepth: 32,
  maxFrontmatterLines: 100,
  maxFrontmatterKeys: 50,
  maxFieldChars: 2048,
  maxImportsPerFile: 100,
  largeLines: 300,
  largeTokens: 4000,
  veryLargeTokens: 12000,
  exactDupMinBytes: 120,
  nearDupMinLines: 8,
  nearDupMinLineChars: 12,
  nearDupThreshold: 0.8,
  maxNearDupFiles: 300,
  maxSharedLineFanout: 50,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

/** Evidence is structural only: numbers, booleans and short code words. Never file text. */
export type Evidence = Readonly<Record<string, number | boolean | string>>;

export interface Finding {
  /** Stable across scans of the same inventory (derived from rule, files and discriminator). */
  readonly key: string;
  readonly ruleId: string;
  /** Version of the detection logic that produced this finding. */
  readonly ruleVersion: number;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly sourceId: string | null;
  readonly relatedSourceId: string | null;
  readonly evidence: Evidence;
  readonly limitations: string;
  readonly recommendation: string;
}

export type FrontmatterState = "none" | "valid" | "malformed";

export interface SafeMetadata {
  readonly name?: string;
  readonly model?: string;
  readonly descriptionLength?: number;
  readonly toolCount?: number;
  readonly pathGlobCount?: number;
}

/** Structural facts about a settings file. No command, env or permission values. */
export interface SettingsDetail {
  readonly knownKeys: readonly string[];
  readonly unknownKeyCount: number;
  readonly permissions: { readonly allow: number; readonly deny: number; readonly ask: number };
  readonly hooks: Readonly<Record<string, { readonly matchers: number; readonly hooks: number; readonly commandHooks: number }>>;
  readonly unknownHookEvents: number;
  readonly envKeyCount: number;
}

export interface ConfigFileRecord {
  /** Opaque id derived from the salted fingerprint. Safe to show and to persist. */
  readonly sourceId: string;
  readonly fingerprint: string;
  readonly scope: ConfigScope;
  readonly category: ConfigCategory;
  readonly status: "ok" | "skipped";
  /** Fixed code word only, never an error message. */
  readonly errorCode: string | null;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly contentHash: string | null;
  /** Rough estimate (bytes / 4). Not a tokenizer result. */
  readonly estimatedTokens: number;
  readonly activation: ActivationStatus;
  readonly activationBasis: string;
  readonly frontmatterState: FrontmatterState;
  readonly metadata: SafeMetadata;
  readonly detail: SettingsDetail | null;
  readonly importDepth: number;
  /** Basename, present only when the caller opted in with `includeLabels`. */
  readonly label: string | null;
}

export type ImportStatus = "resolved" | "broken" | "outside-roots" | "unresolvable" | "cycle" | "too-deep" | "skipped";

export interface ImportRecord {
  readonly sourceId: string;
  readonly line: number;
  readonly status: ImportStatus;
  readonly targetSourceId: string | null;
  readonly depth: number;
}

export interface RootResult {
  readonly kind: RootKind;
  readonly status: "ok" | "unavailable";
  readonly errorCode: string | null;
}

export interface ConfigInventory {
  readonly status: "complete" | "partial" | "failed";
  readonly roots: readonly RootResult[];
  readonly files: readonly ConfigFileRecord[];
  readonly imports: readonly ImportRecord[];
  readonly findings: readonly Finding[];
}

export interface ScanOptions {
  /** Local secret for fingerprints and content hashes. */
  readonly salt: Buffer;
  readonly includeLabels?: boolean;
  readonly limits?: Partial<Limits>;
}
