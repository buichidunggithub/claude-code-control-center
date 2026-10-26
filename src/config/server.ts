/** The only host the app may bind to. There is intentionally no override. */
export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3210;

/**
 * Optional override of the port the Host check expects. It only changes which Host header is accepted
 * (used by tests that start the server on a free port); the start scripts still pin `-p 3210`.
 */
export const PORT_ENV = "CLAUDE_CONTROL_PORT";

/** Hostnames a local browser can legitimately send. IPv6 is not listed because the server never binds to it. */
export const ALLOWED_HOSTNAMES = [LOOPBACK_HOST, "localhost"] as const;

const MAX_PORT = 65535;

export function resolveAllowedPort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[PORT_ENV];
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) return DEFAULT_PORT;
  const port = Number(raw);
  return port >= 1 && port <= MAX_PORT ? port : DEFAULT_PORT;
}

/**
 * Exact match against `<allowed hostname>:<port>` (hostname compared case-insensitively). A missing header,
 * a list produced by duplicate Host headers ("a, b"), a userinfo/path form or any other host is rejected.
 * Forwarding headers such as X-Forwarded-Host are never consulted.
 */
export function isAllowedHost(hostHeader: string | null | undefined, port: number = DEFAULT_PORT): boolean {
  if (typeof hostHeader !== "string") return false;
  const candidate = hostHeader.toLowerCase();
  return ALLOWED_HOSTNAMES.some((name) => candidate === `${name}:${port}`);
}
