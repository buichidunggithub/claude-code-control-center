import type { ConfigCategory, Limits, SafeMetadata } from "./types";

export type FieldValue = string | readonly string[] | "unsupported";

export interface Frontmatter {
  readonly state: "none" | "valid" | "malformed";
  readonly fields: ReadonlyMap<string, FieldValue>;
  /** Fixed code words only. */
  readonly issues: readonly string[];
  /** 0-based index of the first body line (just after the closing delimiter), or 0 when none. */
  readonly bodyStart: number;
}

const NONE: Frontmatter = { state: "none", fields: new Map(), issues: [], bodyStart: 0 };
const KEY = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  const quote = v[0];
  return v.length >= 2 && (quote === '"' || quote === "'") && v.endsWith(quote) ? v.slice(1, -1) : v;
}

/**
 * Parses a deliberately small YAML subset: `key: scalar`, `key: [a, b]`, block lists and `|` / `>` block
 * scalars. Flow maps and anything else are marked "unsupported" rather than guessed at.
 */
export function parseFrontmatter(lines: readonly string[], limits: Limits): Frontmatter {
  if (lines[0]?.trim() !== "---") return NONE;
  const close = lines.findIndex((line, i) => i > 0 && i <= limits.maxFrontmatterLines && line.trim() === "---");
  if (close === -1) return { state: "malformed", fields: new Map(), issues: ["unterminated"], bodyStart: 0 };

  const fields = new Map<string, FieldValue>();
  const issues: string[] = [];
  let listKey: string | null = null;

  for (let i = 1; i < close; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey !== null) {
      const current = fields.get(listKey);
      if (Array.isArray(current)) fields.set(listKey, [...current, unquote(item[1] ?? "")]);
      continue;
    }
    const match = KEY.exec(raw);
    if (!match || /^\s/.test(raw)) {
      issues.push("unparseable-line");
      listKey = null;
      continue;
    }
    const [, key = "", value = ""] = match;
    if (fields.has(key)) {
      issues.push("duplicate-key");
      listKey = null;
      continue;
    }
    if (fields.size >= limits.maxFrontmatterKeys) {
      issues.push("too-many-keys");
      break;
    }
    listKey = null;
    if (value === "") {
      fields.set(key, []);
      listKey = key;
    } else if (/^[|>][+-]?$/.test(value)) {
      // Block scalar: consume the indented lines that follow as the value.
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < close && /^(\s|$)/.test(lines[i + 1] ?? "x")) {
        i += 1;
        block.push((lines[i] ?? "").trim());
      }
      const text = block.filter((l) => l !== "").join(folded ? " " : "\n");
      if (text.length > limits.maxFieldChars) {
        issues.push("value-too-long");
        fields.set(key, "unsupported");
      } else fields.set(key, text);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      fields.set(key, value.slice(1, -1).split(",").map(unquote).filter((v) => v !== ""));
    } else if (value.startsWith("{")) {
      fields.set(key, "unsupported");
    } else if (value.length > limits.maxFieldChars) {
      issues.push("value-too-long");
      fields.set(key, "unsupported");
    } else {
      fields.set(key, unquote(value));
    }
  }
  return { state: issues.length === 0 ? "valid" : "malformed", fields, issues, bodyStart: close + 1 };
}

export interface MetaIssue {
  readonly ruleId: "CFG-META-001" | "CFG-META-002" | "CFG-META-003";
  /** Fixed vocabulary: a field name from the schema below or "frontmatter". */
  readonly field: string;
  readonly reason: string;
}

export interface Validated {
  readonly metadata: SafeMetadata;
  readonly issues: readonly MetaIssue[];
  /** Normalized rule `paths` globs, kept in memory for overlap checks only. */
  readonly pathGlobs: readonly string[];
}

// ASSUMED schemas (from documented conventions); unverified against live Claude Code behavior.
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const MAX_SKILL_DESCRIPTION = 1024;
const MAX_GLOB_CHARS = 256;

const scalar = (v: FieldValue | undefined): string | null => (typeof v === "string" ? v.trim() : null);
const asList = (v: FieldValue | undefined): string[] | null =>
  Array.isArray(v) ? [...v] : typeof v === "string" && v.trim() !== "" ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;

export function validateMetadata(category: ConfigCategory, fm: Frontmatter): Validated {
  const issues: MetaIssue[] = [];
  if (fm.state === "malformed") {
    return { metadata: {}, issues: [{ ruleId: "CFG-META-001", field: "frontmatter", reason: fm.issues[0] ?? "malformed" }], pathGlobs: [] };
  }
  const metadata: { -readonly [K in keyof SafeMetadata]: SafeMetadata[K] } = {};
  let pathGlobs: string[] = [];

  const requireText = (field: "name" | "description"): string | null => {
    const value = fm.fields.get(field);
    if (fm.state === "none") issues.push({ ruleId: "CFG-META-002", field, reason: "no-frontmatter" });
    else if (value === undefined) issues.push({ ruleId: "CFG-META-002", field, reason: "missing" });
    else if (value === "unsupported" || Array.isArray(value)) issues.push({ ruleId: "CFG-META-003", field, reason: "not-a-string" });
    else if (scalar(value) === "") issues.push({ ruleId: "CFG-META-002", field, reason: "empty" });
    else return scalar(value);
    return null;
  };

  if (category === "agent" || category === "skill") {
    const name = requireText("name");
    if (name !== null) {
      if (NAME.test(name)) metadata.name = name;
      else issues.push({ ruleId: "CFG-META-003", field: "name", reason: "bad-format" });
    }
    const description = requireText("description");
    if (description !== null) {
      metadata.descriptionLength = description.length;
      if (category === "skill" && description.length > MAX_SKILL_DESCRIPTION) {
        issues.push({ ruleId: "CFG-META-003", field: "description", reason: "too-long" });
      }
    }
    const model = scalar(fm.fields.get("model"));
    if (fm.fields.has("model")) {
      if (model !== null && MODEL.test(model)) metadata.model = model;
      else issues.push({ ruleId: "CFG-META-003", field: "model", reason: "bad-format" });
    }
    const tools = asList(fm.fields.get("tools"));
    if (fm.fields.has("tools")) {
      if (tools === null) issues.push({ ruleId: "CFG-META-003", field: "tools", reason: "not-a-list" });
      else metadata.toolCount = tools.length;
    }
  }
  if (category === "rule" && fm.fields.has("paths")) {
    const globs = asList(fm.fields.get("paths"));
    if (globs === null || globs.length === 0) issues.push({ ruleId: "CFG-META-003", field: "paths", reason: "not-a-list" });
    else if (globs.some((g) => g.length > MAX_GLOB_CHARS)) issues.push({ ruleId: "CFG-META-003", field: "paths", reason: "too-long" });
    else {
      pathGlobs = [...new Set(globs.map((g) => unquote(g)))].sort();
      metadata.pathGlobCount = pathGlobs.length;
    }
  }
  return { metadata, issues, pathGlobs };
}
