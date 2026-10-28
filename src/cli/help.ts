/** Fixed help text. It is the one place the scope and the prompt-size opt-in are spelled out for the command line. */
export const HELP_TEXT = `ingest: explicit, one-file ingest of a Claude Code transcript (local, read-only on the transcript)

USAGE
  ingest help
  ingest preview <absolute-path>
  ingest run --db <absolute-db-path> --token <token-from-preview> [--prompt-size] <absolute-path>

SCOPE
  Each run handles exactly ONE .jsonl file that you name. Nothing is discovered, no directory is listed,
  and no other file is read. Re-running the same command on the same file is safe: usage records are not
  duplicated, and the result is the same.

REFRESHING EVENT FACTS (repeat a run)
  A database created before event facts existed, or a source ingested earlier, has no facts collected for
  it. Run the same \`run\` command again for that file: usage records and totals are left exactly as they are,
  and only that file's event facts (counts and safe tool-name buckets) are collected or replaced, inside the
  same single transaction. A file you do not name is never touched. Nothing is deleted.

--prompt-size  (OFF by default)
  Reads the text of user events in memory ONLY to record a coarse size bucket (empty, xs, s, m, l, xl) or
  the state "unsupported". Without this flag the content is never read and the state is "not-read".
  Never stored, printed or logged: the text, an excerpt, a hash of it, or an exact length.
  It is heuristic structure, not a count of prompts or turns. A source that already has size buckets keeps
  them if you later run without the flag.

NEVER STORED OR SHOWN
  Prompts, responses, tool arguments or results, paths, raw session ids, raw tool-use ids, and tool names
  outside a fixed built-in list (every other name is stored as "other").

EXIT STATUS
  0 success, 2 rejected before any work, 3 failed after work began (the transaction is rolled back).`;
