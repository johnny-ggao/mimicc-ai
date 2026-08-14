/**
 * FROZEN FIXTURE — do not edit, do not import from src/.
 *
 * Read by the bench's fixed task. See telemetry.ts in this directory for why
 * editing either file invalidates every recorded baseline.
 */

export interface Settings {
  region: string;
  endpoint: string;
  retries: number;
  timeoutMs: number;
  verbose: boolean;
}

/**
 * Defaults for anything the caller leaves out.
 *
 * `region` leads because it is the one that changes what the endpoint below
 * resolves to; the rest are transport knobs that rarely move.
 */
export const DEFAULTS: Settings = {
  region: "ap-southeast-1",
  endpoint: "https://ingest.example.internal/v2",
  retries: 3,
  timeoutMs: 8000,
  verbose: false,
};

/**
 * Merges caller overrides onto the defaults, rejecting unknown keys rather than
 * silently dropping them — a typo in a config key is otherwise invisible until
 * someone wonders why their setting had no effect.
 */
export function resolveSettings(overrides: Partial<Settings> = {}): Settings {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  }
  return { ...DEFAULTS, ...overrides };
}
