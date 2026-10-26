/**
 * Total-file-size cap for the ingest command: 64 MiB.
 *
 * Why this number (measured, not guessed). The existing reader keeps every usage record and tool event in
 * memory, so cost scales with RECORD COUNT. On synthetic worst-case files (tiny, unique, valid usage lines):
 *
 *     4 MiB  ->  1.3 s,  205 MB peak     64 MiB -> 26.8 s, 652 MB peak
 *    16 MiB  ->  5.2 s,  632 MB peak    128 MiB -> 45.5 s, 723 MB peak
 *
 * 64 MiB is about 20x the only real session observed (3.0 MiB, 849 lines) and keeps the worst case near
 * half a minute and under 700 MB on a laptop. There is deliberately no override flag: a larger limit is a
 * code change that needs fresh evidence. Real file sizes are otherwise unknown, so this is a conservative
 * assumption, not a measured property of real transcripts. The existing 4 MiB per-line cap still applies.
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export const MAX_PATH_CHARS = 4096;
