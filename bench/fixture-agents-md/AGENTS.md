# Contributing to telemetry-core

## Toolchain

This package is built and tested with Bun. `bun install` restores the lockfile;
`bun run check` runs typecheck, lint, format and tests in that order and is the
only command CI runs. Do not add npm or pnpm lockfiles — a second lockfile drifts
from `bun.lock` and the drift is only noticed at release time.

## Layout

- `src/telemetry.ts` — the sink. Everything that leaves the process goes through it.
- `src/backoff.ts` — retry timing. Pure functions only; no clock reads.
- `src/settings.ts` — defaults and environment parsing.

Modules under `src/` may not import from each other in a cycle. If two need the
same helper, the helper moves down into its own module rather than up into either.

## Style

- TypeScript strict mode, ESM only, no default exports.
- Comment why, never what. A comment that restates the line below it is deleted
  in review.
- Errors carry the operation that failed, not just the cause: `failed to parse
  region "eu-x": unknown region` rather than `unknown region`.
- Prefer `unknown` over `any` at every boundary, and narrow at the point of use.

## Tests

Every exported function has at least one test naming the behaviour, not the
function: `test("retries stop doubling at the ceiling")`, not `test("backoff")`.
Coverage is enforced at 0.8; a change that drops below it fails the build.

## Review

Small changes land as one commit. A change that touches more than three modules
is split unless the split would break a build in between. Never commit a secret,
never commit generated output, never commit a change you have not run.
