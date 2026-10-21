import { createHash, createHmac } from "node:crypto";

/** Salted, domain-separated fingerprint. Not anonymization: low-entropy inputs can be guessed with the salt. */
export function fingerprint(salt: Buffer, namespace: string, value: string): string {
  return createHmac("sha256", salt).update(`${namespace}\0${value}`).digest("hex");
}

/** A SHA-256 already seeded with the salt, for hashing streamed content. */
export function keyedHash(salt: Buffer) {
  return createHash("sha256").update(salt);
}

/** Unsalted hash for in-memory comparisons only. Never persist its output. */
export function plainHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
