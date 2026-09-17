import type { JournalEvent, Recorder } from "./schema";

/**
 * A Recorder that persists nothing. The run loop always has a journal to append
 * to, so every consumer that does not want one — the CLI harnesses, the
 * benchmark, tests and any embedder — wrote the same stub. It lives here once.
 *
 * `append` still returns a well-formed JournalEvent because the runner passes
 * the value on to its snapshot; only `sequence_number` is meaningless (0),
 * since nothing is being ordered. The real implementation is `Vault`
 * (src/storage/vault.ts).
 */
export function nullRecorder(): Recorder {
  return {
    begin: () => {},
    save: () => {},
    frame: () => {},
    append: (runId, type, data = {}): JournalEvent => ({
      event_id: crypto.randomUUID(),
      run_id: runId,
      sequence_number: 0,
      monotonic_timestamp: performance.now(),
      wall_clock_timestamp: new Date().toISOString(),
      schema_version: 1,
      type,
      data,
    }),
  };
}
