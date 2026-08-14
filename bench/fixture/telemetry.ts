/**
 * FROZEN FIXTURE — do not edit, do not import from src/.
 *
 * The bench's fixed task reads this file, so its bytes are part of every
 * measurement. Change one character and every baseline ever recorded stops being
 * comparable. It is deliberately shaped like a real module of this codebase
 * (same size class, same comment density) because what is being measured is the
 * token cost of a realistic tool result — not this file's contents.
 */

export type Level = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * How long a batch may sit before it is sent regardless of size. Small enough
 * that a crash loses at most one window, large enough that a chatty process does
 * not spend its time in syscalls.
 */
export const FLUSH_INTERVAL_MS = 2500;

export interface Sink {
  write(line: string): void;
}

/**
 * Buffers events and flushes them on an interval.
 *
 * Everything goes to stderr rather than stdout, so a program that pipes its real
 * output somewhere does not find telemetry mixed into it. That is the whole
 * reason for the split — not verbosity control, which the level threshold below
 * already handles.
 */
export function createTelemetry(level: Level, sink: Sink) {
  const threshold = SEVERITY[level];
  let batch: string[] = [];

  const flush = (): void => {
    if (batch.length === 0) return;
    for (const line of batch) sink.write(`${line}\n`);
    batch = [];
  };

  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    record(eventLevel: Level, event: string, meta?: Record<string, unknown>): void {
      if (SEVERITY[eventLevel] < threshold) return;
      batch.push(JSON.stringify({ level: eventLevel, event, ...meta }));
    },
    flush,
  };
}
