/** `write` must call `done` once the text was handled or failed (Node streams do). */
export interface Sink {
  write(text: string, done?: (error?: Error | null) => void): unknown;
}

const WRITE_TIMEOUT_MS = 10_000;

/**
 * Writes and waits for the stream's own verdict, so a closed pipe (EPIPE) is a returned `false`, never an
 * exception that escapes later. A sink that throws or never answers also yields `false`.
 */
export function emit(sink: Sink, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), WRITE_TIMEOUT_MS);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      sink.write(text, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

