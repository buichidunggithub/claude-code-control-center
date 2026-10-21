import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CANARIES = [
  "CANARY_PROMPT_7f3a",
  "CANARY_RESPONSE_2d90",
  "CANARY_PATH_9c1d",
  "CANARY_CMD_a7e1",
  "CANARY_RESULT_61bb",
  "CANARY_UNKNOWN_44b2",
  "CANARY_BADUSAGE_0f12",
  "CANARY_MALFORMED_5e8d",
  "CANARY_GREP_3b77",
] as const;

export function fixturePath(name: string): string {
  return resolve("tests/fixtures/synthetic", name);
}

export function fixtureBytes(name: string): Buffer {
  return readFileSync(fixturePath(name));
}

export async function* chunked(bytes: Uint8Array, sizes: readonly number[]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = Math.max(1, sizes[i % sizes.length] ?? 1);
    yield bytes.subarray(offset, offset + size);
    offset += size;
    i += 1;
  }
}

/** Small deterministic PRNG so property-style tests are reproducible without extra dependencies. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
