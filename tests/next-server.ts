import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer, connect } from "node:net";
import { resolve } from "node:path";

const NEXT_BIN = resolve("node_modules/next/dist/bin/next");
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 150;

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export function buildProduction(): void {
  const result = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (result.status !== 0) throw new Error(`next build failed (${result.status})\n${result.stdout}\n${result.stderr}`);
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<HttpResult> {
  return new Promise((resolveResult, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolveResult({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Sends exact bytes, so Host headers can be missing or duplicated. Returns the status line's code. */
export function raw(port: number, payload: string): Promise<{ status: number; text: string }> {
  return new Promise((resolveRaw, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(payload));
    let text = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("socket timeout")));
    socket.on("data", (d) => (text += d.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => resolveRaw({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0), text }));
  });
}

export interface RunningServer {
  readonly port: number;
  stop(): void;
}

export async function startServer(databasePath: string): Promise<RunningServer> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CLAUDE_CONTROL_DB_PATH: databasePath, CLAUDE_CONTROL_PORT: String(port) },
    stdio: "ignore",
    detached: true,
  });
  const stop = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await get(port, "/api/status")).status > 0) return { port, stop };
    } catch {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  stop();
  throw new Error("next start did not become ready");
}
