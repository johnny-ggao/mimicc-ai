import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { isPinned, PINNED } from "./projection";

import type { Logger } from "../logger";

/**
 * The files a repository uses to tell an agent how to work in it, in the order
 * they are injected. Both are read when both exist: picking one would need a
 * precedence rule, and a precedence rule silently drops half the guidance when
 * the two disagree — the model cannot see what it was not given.
 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Cap on injected instructions, and deliberately not `MAX_FILE_BYTES` (64_000).
 * That number sizes a *single* Read; this text rides along on every request for
 * the life of the thread, so the two are not the same order of magnitude.
 */
export const MAX_INSTRUCTION_BYTES = 8_000;

/**
 * The message id, and the entire deduplication strategy.
 *
 * `messagesStateReducer` merges by id: a message in the update whose id already
 * exists in state replaces it *in place*, keeping its position, rather than
 * appending a copy (@langchain/langgraph/dist/graph/messages_reducer.js:65-77).
 * So `beforeAgent` can return this unconditionally on every turn and the reducer
 * makes it idempotent — no guard, no scan of the message list, no second source
 * of truth about whether injection already happened.
 *
 * It is also a constant, which is what keeps it clear of the rule that any
 * per-request-varying name or number destroys the cache prefix.
 */
export const PROJECT_INSTRUCTIONS_ID = "project-instructions";

/**
 * Reads the repository's own instructions, ready to inject, or `undefined` when
 * there are none.
 *
 * `root` is a parameter rather than `process.cwd()` so the failure modes are
 * testable against a temp directory, and `log` is one because two of those modes
 * are things the user needs to see and the model's copy of them is not enough.
 * Only that one directory is searched — no
 * walking up. The tools refuse paths outside the working directory
 * (`resolveInside`), and an injection path that reaches above it would be a way
 * around that refusal rather than a convenience.
 *
 * ## The four failure modes
 *
 * - **Absent** — return nothing at all. This is the common case (most
 *   repositories have neither file), and sending nothing is what keeps it free.
 *
 *   Measured, because the original justification was too strong: the claim was
 *   that the system prompt's contract makes the *absence* of a tag a sufficient
 *   signal, so no words are needed. The first half holds — asked outright, the
 *   model answers "no" correctly every time, once even naming the missing
 *   injection. The second half does not: it Globs for both filenames first
 *   anyway, three times out of three, because two stronger rules in the Tools
 *   section tell it to ("Never answer a question about this repository from
 *   memory or inference" and "Never guess a path"). So the absent case costs one
 *   tool round-trip *when someone asks about it*, not zero.
 *
 *   The decision stands regardless: injecting a "there are none" line would pay a
 *   fixed ~15 tokens on every request for the life of every thread to save one
 *   Glob in a question nobody usually asks.
 * - **Present but unreadable** — inject a message saying so. Swallowing it would
 *   leave the model unable to tell "this project has no conventions" from "this
 *   project has conventions I could not see", and it can only adjust for the
 *   second if it is told.
 * - **Oversized** — clip, and say where, using the same marker `Read` uses.
 *   Refusing to inject at all fails silently: a 100KB AGENTS.md would simply not
 *   apply, and nobody would know.
 * - **Prompt injection** — *deliberately not handled here*, and not by a
 *   confirmation gate either. The threat model that justifies one (Claude Code
 *   prompts for externally imported files) is about content from outside the
 *   project; this reads one directory, the one the user started the agent in.
 *   Whoever can write this file can already write the source code the agent
 *   reads anyway. The enforcement points are unchanged: Bash goes through the
 *   confirmation gate, writes are boxed in by `resolveInside`.
 */
export function readProjectInstructions(root: string, log: Logger): string | undefined {
  const sections = INSTRUCTION_FILES.map((name) => readOne(root, name, log)).filter(
    (section) => section !== undefined,
  );

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function readOne(root: string, name: string, log: Logger): string | undefined {
  const path = join(root, name);

  try {
    // Distinguishes "no such file" from "cannot read it": this option suppresses
    // only ENOENT, so a permission error still throws and lands in the catch.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (!stat.isFile()) throw new Error("not a regular file");

    const text = readFileSync(path, "utf8");
    if (text.length <= MAX_INSTRUCTION_BYTES) {
      log.info("project_instructions", { path: name, bytes: text.length });
      return wrap(name, text);
    }

    log.warn("project_instructions_clipped", {
      path: name,
      bytes: text.length,
      limit: MAX_INSTRUCTION_BYTES,
    });
    return wrap(
      name,
      `${text.slice(0, MAX_INSTRUCTION_BYTES)}\n\n[clipped at ${String(MAX_INSTRUCTION_BYTES)} bytes of ${String(text.length)}]`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn("project_instructions_unreadable", { path: name, reason });
    return wrap(
      name,
      `This file exists but could not be read: ${reason}\nIts contents are not part of your context.`,
      "unreadable",
    );
  }
}

/**
 * The tag is the only place provenance can go.
 *
 * A user-role message is serialised as `{ role: "user", content: [...] }` with
 * no `name` field — the completions converter only ever writes `name` on the
 * `function` branch (@langchain/openai/dist/converters/completions.js:483). So
 * there is no metadata channel for "this came from a repository file"; it has to
 * be in the text the model reads.
 *
 * What the tag buys is a boundary and an origin, not obedience. It tells the
 * model where this text starts, where it ends, and which file it came from. It
 * does not stop the model acting on instructions inside it — the authority
 * relationship is stated in the system prompt, which is the one channel a
 * repository file cannot write to.
 */
function wrap(path: string, body: string, status?: string): string {
  const attributes = status === undefined ? "" : ` status="${status}"`;
  return `<project-instructions path="${path}"${attributes}>\n${body.trim()}\n</project-instructions>`;
}

/**
 * Injects the repository's instructions once per thread, as a user message.
 *
 * ## Why a user message
 *
 * Not because it reads like something a human said — because it is the only
 * non-operator channel the protocol has. `messageToOpenAIRole` maps to exactly
 * six roles (@langchain/openai/dist/utils/misc.js:26-38), and the wire format
 * collapses "a human said this" and "this is untrusted input" into the same one.
 * `system` and `developer` are the operator channel, and a repository file must
 * not reach it: whoever can commit to the repository can write this text, so
 * putting it there would let a commit rewrite the agent's safety rules. That is
 * the whole decision — see docs/adr/0001. `assistant` would make the model treat
 * it as something it said itself, and `tool` cannot stand alone, since a tool
 * message has to answer a preceding tool call.
 *
 * ## Why beforeAgent
 *
 * It runs once per user turn, outside the loop: `START` goes to the first
 * beforeAgent node and the tools node's back edge returns to the *loop* entry,
 * which is past it (langchain/dist/agents/ReactAgent.js:184,187,267-269). A turn
 * that takes five tool laps still injects once.
 *
 * The message lands after the user's first message, because the graph merges the
 * invocation input into state before this node runs. It could be moved in front
 * with `RemoveMessage(REMOVE_ALL_MESSAGES)`, and at zero cache cost since no
 * request has gone out yet — but that is the sledgehammer that erases everything
 * else in state, and reaching for it here would be a bad precedent for a gain
 * nobody has measured. The position, whichever it is, is fixed from the first
 * turn onwards.
 */
export function projectInstructions(text: string): AnyAgentMiddleware {
  // Built once. The bytes must be identical on every turn or the reducer would
  // see a changed message and the cache prefix would break from here on.
  // Pinned at construction, by the one who knows it has to be: it is injected
  // under a fixed id and merged in place, so it sits before every cut that will
  // ever be made and would otherwise drop out of the view.
  const message = new HumanMessage({
    id: PROJECT_INSTRUCTIONS_ID,
    content: text,
    additional_kwargs: { ...PINNED },
  });

  return createMiddleware({
    name: "ProjectInstructions",
    beforeAgent: () => ({ messages: [message] }),
  });
}

/**
 * Pins what the user typed, so a cut cannot walk past this turn's objective.
 *
 * ## Why the graph and not the console
 *
 * The rule elsewhere is that whoever produces a message pins it, and the obvious
 * reading of that puts this in `repl.ts`, at the `new HumanMessage(input)` that
 * starts a turn. It was written there first, and a test caught what is wrong with
 * it: `tests/pinned.test.ts` drives `graph.invoke` directly, exactly as a second
 * entry point would, and the guarantee simply was not there. **A property that
 * holds only for one caller is not a property of the agent.**
 *
 * So the producer here is the *invocation*, and `beforeAgent` is where the graph
 * learns of one: it runs once per user turn, outside the loop, so five tool laps
 * still pin once (`ReactAgent.js:184,187,267-269`).
 *
 * ## Why every unpinned human message rather than "this turn's"
 *
 * Because "this turn's" needs to be identified, and the obvious ways to do it are
 * wrong. The last human message is not it — `ProjectInstructions` injects one too,
 * and which of them lands last depends on middleware order. Counting from the
 * previous turn means carrying a watermark in state for something a predicate can
 * answer.
 *
 * Pinning every unpinned one is idempotent by construction: the instructions
 * arrive pinned already, and a turn whose message was pinned on a previous pass
 * is skipped. The reducer merges by id, so returning a copy replaces in place.
 *
 * The cost is that the pinned set grows by one short message per turn. That is
 * accepted rather than overlooked: what the user typed is the cheapest thing in
 * the history per token and the only thing in it that cannot be reconstructed
 * from anything else. If it ever stops being cheap, the fix is a rule about
 * *which* turns stay pinned, and this is the seam for it.
 */
export function pinTurnTask(): AnyAgentMiddleware {
  return createMiddleware({
    name: "PinTurnTask",
    beforeAgent: (state: { messages?: BaseMessage[] }) => {
      const fresh = (state.messages ?? []).filter(
        (message) => HumanMessage.isInstance(message) && !isPinned(message),
      );
      if (fresh.length === 0) return;

      return {
        messages: fresh.map(
          (message) =>
            new HumanMessage({
              ...(message.id !== undefined ? { id: message.id } : {}),
              content: message.content,
              additional_kwargs: { ...message.additional_kwargs, ...PINNED },
            }),
        ),
      };
    },
  }) as AnyAgentMiddleware;
}
