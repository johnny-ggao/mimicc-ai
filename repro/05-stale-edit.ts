/**
 * Reproduction for issue 05: what actually happens when a file changes between
 * Read and Edit?
 *
 * Run: `bun repro/05-stale-edit.ts`
 *
 * The ticket's surviving purpose is a staleness check — refuse an Edit whose
 * target file changed since it was read. Before designing one, this establishes
 * which of those situations are already handled. `locate()` refuses ambiguity
 * outright and never falls back to a looser level once one has matched several
 * times (src/tools/matching.ts:158-160), so a good part of the space may already
 * be self-healing, and a check that only re-detects what the tools already catch
 * buys nothing.
 *
 * No model and no network: every case drives the real tools directly, so the
 * outcomes are the tools' own behaviour rather than a model's recovery from it.
 * What the model does *with* these outcomes is a separate, paid experiment, and
 * only worth running for the cases that are shown to slip through here.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { editTool, readTool, writeTool } from "../src/tools";

const DIR = ".test-tmp/repro-05";

const ORIGINAL = `export const RETRY_BACKOFF_MS = 250;

export const MAX_BACKOFF_MS = 20_000;

export const MAX_ATTEMPTS = 5;

export function shouldRetry(attempt: number, status: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  return status >= 500 || status === 429;
}
`;

interface Case {
  name: string;
  /** What some other writer does to the file after it was read. */
  external: (text: string) => string;
  /** What the agent then does, holding the text it read *before* that. */
  act: (path: string, stale: string) => Promise<string>;
  /** Called with the final file, to say whether the outcome was acceptable. */
  verdict: (final: string, outcome: string) => string;
}

const cases: Case[] = [
  {
    name: "external edit elsewhere, agent edits its own target",
    external: (text) => text.replace("MAX_BACKOFF_MS = 20_000", "MAX_BACKOFF_MS = 45_000"),
    act: (path) =>
      editTool.invoke({
        path,
        oldString: "export const RETRY_BACKOFF_MS = 250;",
        newString: "export const RETRY_BACKOFF_MS = 400;",
      }) as Promise<string>,
    verdict: (final) =>
      final.includes("45_000") && final.includes("400")
        ? "OK — both changes survive"
        : "LOST — one change was clobbered",
  },
  {
    name: "external edit hits the same target first",
    external: (text) => text.replace("RETRY_BACKOFF_MS = 250", "RETRY_BACKOFF_MS = 999"),
    act: (path) =>
      editTool.invoke({
        path,
        oldString: "export const RETRY_BACKOFF_MS = 250;",
        newString: "export const RETRY_BACKOFF_MS = 400;",
      }) as Promise<string>,
    verdict: (final, outcome) =>
      outcome.startsWith("threw")
        ? "SELF-HEALING — tool refused"
        : `SLIPPED THROUGH — file now ${final.includes("400") ? "has 400" : "unclear"}`,
  },
  {
    name: "external edit duplicates the block, making the target ambiguous",
    external: (text) => `${text}\nexport const RETRY_BACKOFF_MS = 250;\n`,
    act: (path) =>
      editTool.invoke({
        path,
        oldString: "export const RETRY_BACKOFF_MS = 250;",
        newString: "export const RETRY_BACKOFF_MS = 400;",
      }) as Promise<string>,
    verdict: (_final, outcome) =>
      outcome.startsWith("threw")
        ? "SELF-HEALING — tool refused"
        : "SLIPPED THROUGH — edited one of two",
  },
  {
    name: "external reformat (indentation) around the target",
    external: (text) =>
      text.replace(
        "  if (attempt >= MAX_ATTEMPTS) return false;",
        "    if (attempt >= MAX_ATTEMPTS) return false;",
      ),
    act: (path) =>
      editTool.invoke({
        path,
        oldString: "  if (attempt >= MAX_ATTEMPTS) return false;",
        newString: "  if (attempt >= MAX_ATTEMPTS) return null;",
      }) as Promise<string>,
    verdict: (final, outcome) =>
      outcome.startsWith("threw")
        ? "refused"
        : `applied — ${final.includes("return null") ? "landed" : "did not land"}`,
  },
  {
    name: "agent Writes the file back in full, holding the text it read",
    external: (text) => text.replace("MAX_BACKOFF_MS = 20_000", "MAX_BACKOFF_MS = 45_000"),
    act: (path, stale) =>
      writeTool.invoke({
        path,
        content: stale.replace("RETRY_BACKOFF_MS = 250", "RETRY_BACKOFF_MS = 400"),
      }) as Promise<string>,
    verdict: (final) =>
      final.includes("45_000")
        ? "OK — both changes survive"
        : "LOST — the external change is gone",
  },
];

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

for (const [index, testCase] of cases.entries()) {
  const path = `${DIR}/case-${String(index + 1)}.ts`;
  writeFileSync(path, ORIGINAL);

  // The agent reads it — through the real tool, so the text it "holds" is the
  // rendered view, line numbers and all. The raw bytes are what it must
  // reconstruct an oldString from, which is exactly the gap Edit's error message
  // warns about.
  await readTool.invoke({ path });
  const stale = readFileSync(path, "utf8");

  // Somebody else writes the file.
  writeFileSync(path, testCase.external(stale));

  let outcome: string;
  try {
    outcome = await testCase.act(path, stale);
  } catch (error) {
    outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }

  const final = readFileSync(path, "utf8");
  process.stdout.write(
    `\n${String(index + 1)}. ${testCase.name}\n` +
      `   outcome: ${outcome.split("\n")[0]?.slice(0, 150) ?? ""}\n` +
      `   verdict: ${testCase.verdict(final, outcome)}\n`,
  );
}

rmSync(DIR, { recursive: true, force: true });
