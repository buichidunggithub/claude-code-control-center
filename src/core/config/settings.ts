import { plainHash } from "../fingerprint";
import type { Limits, SettingsDetail } from "./types";

const KNOWN_KEYS = [
  "permissions", "hooks", "env", "model", "statusLine", "includeCoAuthoredBy", "enabledPlugins",
  "apiKeyHelper", "cleanupPeriodDays", "outputStyle", "disableAllHooks",
] as const;
const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact",
]);

export type SettingsFacts =
  | {
      readonly valid: true;
      readonly detail: SettingsDetail;
      /** Unsalted hashes for in-memory comparison only. */
      readonly allowHashes: ReadonlySet<string>;
      readonly denyHashes: ReadonlySet<string>;
      readonly hookKeys: readonly string[];
    }
  | { readonly valid: false; readonly reason: "invalid-json" | "invalid-shape" | "too-deep" };

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Iterative depth check, so a hostile document cannot exhaust the call stack. */
function exceedsDepth(root: Json, limit: number): boolean {
  const stack: Array<{ value: Json; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (item.depth > limit) return true;
    if (Array.isArray(item.value)) item.value.forEach((v) => stack.push({ value: v, depth: item.depth + 1 }));
    else if (isObject(item.value)) Object.values(item.value).forEach((v) => stack.push({ value: v, depth: item.depth + 1 }));
  }
  return false;
}

const strings = (v: Json): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function analyzeSettings(text: string, limits: Limits): SettingsFacts {
  let parsed: Json;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false, reason: "invalid-json" };
  }
  if (!isObject(parsed)) return { valid: false, reason: "invalid-shape" };
  if (exceedsDepth(parsed, limits.maxJsonDepth)) return { valid: false, reason: "too-deep" };

  const permissions = isObject(parsed["permissions"]) ? parsed["permissions"] : {};
  const allow = strings(permissions["allow"]);
  const deny = strings(permissions["deny"]);
  const hooksValue = isObject(parsed["hooks"]) ? parsed["hooks"] : {};

  const hooks: Record<string, { matchers: number; hooks: number; commandHooks: number }> = {};
  const hookKeys: string[] = [];
  let unknownHookEvents = 0;
  for (const [event, matchers] of Object.entries(hooksValue)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) {
      unknownHookEvents += 1;
      continue;
    }
    const groups = Array.isArray(matchers) ? matchers.filter(isObject) : [];
    const entries = groups.flatMap((g) => (Array.isArray(g["hooks"]) ? g["hooks"].filter(isObject) : []));
    const commands = entries.filter((h) => h["type"] === "command" && typeof h["command"] === "string");
    hooks[event] = { matchers: groups.length, hooks: entries.length, commandHooks: commands.length };
    for (const h of commands) hookKeys.push(`${event}|${plainHash(String(h["command"]))}`);
  }

  const keys = Object.keys(parsed);
  return {
    valid: true,
    detail: {
      knownKeys: KNOWN_KEYS.filter((k) => keys.includes(k)),
      unknownKeyCount: keys.filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k)).length,
      permissions: { allow: allow.length, deny: deny.length, ask: strings(permissions["ask"]).length },
      hooks,
      unknownHookEvents,
      envKeyCount: isObject(parsed["env"]) ? Object.keys(parsed["env"]).length : 0,
    },
    allowHashes: new Set(allow.map(plainHash)),
    denyHashes: new Set(deny.map(plainHash)),
    hookKeys,
  };
}
