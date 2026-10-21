export type RawLine =
  | { readonly kind: "line"; readonly lineNumber: number; readonly text: string }
  | { readonly kind: "oversized"; readonly lineNumber: number };

export type ByteSource = AsyncIterable<Uint8Array | string>;

const NEWLINE = 0x0a;

function toBuffer(chunk: Uint8Array | string): Buffer {
  return typeof chunk === "string"
    ? Buffer.from(chunk, "utf8")
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Splits a byte stream into lines without ever buffering more than `maxLineBytes` of one line.
 * A line longer than the limit is discarded as it streams and reported as "oversized" (no content).
 * The limit counts raw bytes before the "\n", so a CRLF line's "\r" counts toward it.
 */
export async function* readBoundedLines(
  source: ByteSource,
  maxLineBytes: number,
): AsyncGenerator<RawLine> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overflow = false;
  let lineNumber = 0;

  for await (const chunk of source) {
    const buf = toBuffer(chunk);
    let start = 0;
    while (start < buf.length) {
      const newlineAt = buf.indexOf(NEWLINE, start);
      const end = newlineAt === -1 ? buf.length : newlineAt;
      const segmentBytes = end - start;

      if (!overflow) {
        if (pendingBytes + segmentBytes > maxLineBytes) {
          overflow = true;
          pending = [];
          pendingBytes = 0;
        } else if (segmentBytes > 0) {
          pending.push(buf.subarray(start, end));
          pendingBytes += segmentBytes;
        }
      }
      if (newlineAt === -1) break;

      lineNumber += 1;
      yield overflow
        ? { kind: "oversized", lineNumber }
        : { kind: "line", lineNumber, text: Buffer.concat(pending).toString("utf8") };
      pending = [];
      pendingBytes = 0;
      overflow = false;
      start = newlineAt + 1;
    }
  }

  if (overflow) {
    yield { kind: "oversized", lineNumber: lineNumber + 1 };
  } else if (pendingBytes > 0) {
    yield { kind: "line", lineNumber: lineNumber + 1, text: Buffer.concat(pending).toString("utf8") };
  }
}
