import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { AmbiguousMatch, locate } from "./matching";
import { ROOT, resolveInside, withPathLock } from "./workspace";

/** A command that has not produced anything in this long is not going to. */
const MAX_COMMAND_MS = 120_000;

/** Command output goes into the next prompt, same as any other tool result. */
const MAX_OUTPUT_BYTES = 32_000;

/**
 * Creates files. It refuses to overwrite one, and that refusal is the whole
 * point.
 *
 * A full-file write is the only way this agent can lose someone else's work.
 * Measured, not assumed (.scratch/context-engineering/repro/05-stale-edit.ts):
 * when a file changes between a Read and a later write, `Edit` catches it every
 * way it can go wrong — the target no longer matches, or it now matches twice,
 * and `locate` refuses both — while a change made elsewhere in the file survives
 * untouched, because an Edit only rewrites the span it matched. `Write` has no
 * such property: it replaces the file with the caller's copy, and anything
 * written since that copy was taken is gone with no error and no trace.
 *
 * The alternative was a read registry — hash what was read, refuse a write when
 * the file no longer hashes the same. That is the standard fix and it was
 * dropped: it needs every write-path tool to take a ToolRuntime and return a
 * Command carrying its own ToolMessage, and the failure it guards was never
 * observed (0 of 3 samples, with a restructuring task chosen to tempt a full
 * rewrite; the model reached for Edit every time). Refusing the overwrite closes
 * the same hole with a narrower tool and no state at all.
 *
 * Nothing is lost that Edit cannot do: replacing a file entirely is an Edit whose
 * oldString is its current contents.
 */
export const writeTool = tool(
  async ({ path, content }): Promise<string> => {
    const full = resolveInside(path);

    return withPathLock(full, async () => {
      if (await Bun.file(full).exists()) {
        throw new Error(
          `${path} already exists and Write never overwrites. Use Edit to change it — ` +
            `to replace it entirely, pass its current contents as oldString`,
        );
      }

      // Bun.write does not create intermediate directories.
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, content);

      return `created ${path} (${String(content.length)} bytes)`;
    });
  },
  {
    name: "Write",
    description:
      "Create a new file. Refuses to overwrite an existing one — use Edit for anything that already exists, including replacing it in full. Creates parent directories as needed.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
      content: z.string().describe("The complete file contents"),
    }),
  },
);

export const editTool = tool(
  async ({ path, oldString, newString }): Promise<string> => {
    if (oldString === newString) {
      throw new Error("oldString and newString are identical: nothing to do");
    }
    if (oldString.length === 0) {
      throw new Error("oldString is empty: there is nothing to locate");
    }

    const full = resolveInside(path);

    // The whole read-modify-write is inside the lock. Holding it for only the
    // write would leave exactly the gap that loses one of two concurrent edits.
    return withPathLock(full, async () => {
      const file = Bun.file(full);
      if (!(await file.exists())) throw new Error(`no such file: ${path}`);

      const text = await file.text();

      let found;
      try {
        found = locate(text, oldString, newString);
      } catch (caught) {
        // Ambiguity is the one thing no amount of tolerance may resolve. Say how
        // many, and ask for the one thing that actually fixes it.
        if (caught instanceof AmbiguousMatch) {
          throw new Error(
            `oldString ${caught.message} in ${path} (${caught.level}). Include more surrounding lines to make the target unique`,
            { cause: caught },
          );
        }
        throw caught;
      }

      if (found === null) {
        throw new Error(
          `oldString not found in ${path}. Read the file again and copy the target from it — note that Read prefixes every line with its number and a tab, and that prefix is not part of the file`,
        );
      }

      await Bun.write(
        file,
        text.slice(0, found.start) + found.replacement + text.slice(found.end),
      );

      const line = text.slice(0, found.start).split("\n").length;
      // A tolerated mismatch is reported. The prompt tells the model that a
      // successful Edit means the change landed and not to re-read — that stays
      // true only while the tool admits which level it had to fall back to.
      const note = found.level === "exact" ? "" : ` (${found.level})`;
      return `edited ${path} at line ${String(line)}${note}`;
    });
  },
  {
    name: "Edit",
    description:
      "Replace one exact string in a file with another. The target must resolve to exactly one place; line endings, blank lines around the block, and indentation are tolerated, ambiguity is not.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
      oldString: z.string().describe("Text to replace, copied from the file"),
      newString: z.string().describe("Text to put in its place"),
    }),
  },
);

export const bashTool = tool(
  async ({ command }): Promise<string> => {
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      // The model's own environment, minus the one variable it must never read
      // back out of a process it started.
      env: { ...process.env, LLM_API_KEY: undefined },
    });

    const timer = setTimeout(() => void child.kill(), MAX_COMMAND_MS);
    let stdout: string;
    let stderr: string;
    let code: number | null;
    try {
      [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      code = await child.exited;
    } finally {
      clearTimeout(timer);
    }

    const body = [stdout, stderr].filter((part) => part.length > 0).join("\n");
    const clipped =
      body.length > MAX_OUTPUT_BYTES
        ? `${body.slice(0, MAX_OUTPUT_BYTES)}\n\n[clipped at ${String(MAX_OUTPUT_BYTES)} bytes of ${String(body.length)}]`
        : body;

    // A non-zero exit is a *result*, not a tool failure: a failing test suite is
    // exactly what the model needs to read. Only the command never finishing is
    // an error, and that arrives as a kill rather than as an exception.
    if (code !== 0) {
      return `${clipped}${clipped.length > 0 ? "\n" : ""}[exit ${String(code)}]`;
    }
    return clipped.length > 0 ? clipped : "[no output]";
  },
  {
    name: "Bash",
    description: `Run one shell command in the working directory. Returns stdout and stderr combined; a non-zero exit is reported as [exit N] rather than as a failure. Times out after ${String(MAX_COMMAND_MS / 1000)}s.`,
    schema: z.object({
      command: z.string().describe("The command to run. One command per call."),
    }),
  },
);
