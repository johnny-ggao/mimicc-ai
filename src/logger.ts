export type LogLevel = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Minimal structured logger writing one JSON object per line to stderr, so
 * stdout stays clean for program output.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = SEVERITY[level];

  const emit = (
    logLevel: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    if (SEVERITY[logLevel] < threshold) return;
    const line = JSON.stringify({
      level: logLevel,
      time: new Date().toISOString(),
      message,
      ...meta,
    });
    process.stderr.write(`${line}\n`);
  };

  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
  };
}
