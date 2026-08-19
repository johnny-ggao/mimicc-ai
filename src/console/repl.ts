import { createInterface } from "node:readline/promises";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import {
  classify,
  DURABILITY,
  failureText,
  RECURSION_LIMIT,
  type AgentGraph,
} from "../agents";
import { markdownStream } from "./markdown";
import { describeSession, readChoice, renderSessionList } from "./picker";
import { spendBreakdown, spendLine } from "./spend";
import { addSpend, creditsOf, noSpend, type Spend } from "../usage";
import { listSessions, resolveSession, type Session } from "../session";
import { TASK_TOOL_NAME } from "../tools";
import {
  parseSkillCommand,
  renderSkillList,
  skillActivationMessage,
  type SkillRegistry,
} from "../skills";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const BANNER = [
  "mimicc-ai — type a message and press enter",
  "  tools    Read · Write · Edit · Bash · Glob · Grep · Task · Skill",
  "  Task     sends a read-only explore agent; its searching stays out of the conversation",
  "  Skill    loads a skill's instructions (see /skills)",
  "  Bash     stops and asks before it runs; the others do not",
  "  /skills  list skills",
  "  /cost    what this session has spent, per model",
  "  /resume  carry on from an earlier session (only before this one has messages)",
  "  /clear   start a new session; the old one stays on disk",
  "  /exit    quit (same as Ctrl+D)",
  "  Ctrl+C   interrupt the current reply; at an idle prompt, quit",
].join("\n");

/**
 * ⚠️ **`repro/15-typing-during-a-turn.ts` constructs this by hand.** It is outside
 * `tsconfig.json` by an explicit decision (`repro/README.md`), so adding a
 * required field here breaks that probe with nothing to report it — which is
 * exactly what `stateDir` and `start` did on 2026-08-19. Add a field, re-run it.
 */
export interface ReplOptions {
  graph: AgentGraph;
  /** The installed skills, for the slash commands. Same registry the agent has. */
  skills: SkillRegistry;
  /** Where sessions live, for the picker and for `/resume`. */
  stateDir: string;
  /** What the command line asked for before the first prompt. */
  start: Start;
}

/**
 * How the console opens.
 *
 * `pick` carries no list: the console reads it itself, through the same call
 * `/resume` uses. One code path for "show me what there is", rather than one for
 * the flag and another for the command.
 */
export type Start =
  { kind: "new" } | { kind: "session"; session: Session } | { kind: "pick" };

/** One tool call waiting on a human. Shape comes from `__interrupt__`. */
interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

type Decision =
  | { type: "approve" }
  | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }
  | { type: "reject"; message?: string };

/**
 * A batch of tool calls the gate stopped, and the decisions collected so far.
 *
 * The console asks for these one line at a time through the *same* readline
 * iterator that reads prompts, rather than through `rl.question`: both consume
 * "line" events, and running them concurrently makes which one wins a matter of
 * timing. A line is a line — what changes is how the loop reads it.
 */
export interface Pending {
  requests: ActionRequest[];
  decisions: Decision[];
  /** True once the user chose "edit" and the next line is the replacement. */
  editing: boolean;
}

export async function runRepl({
  graph,
  skills,
  stateDir,
  start,
}: ReplOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Piped stdin (tests, here-docs) must not be forced into terminal mode.
    terminal: process.stdin.isTTY === true,
    historySize: 200,
  });

  // Non-null exactly while a turn is in flight. That is also how the SIGINT
  // handler tells "interrupt the reply" apart from "quit the repl".
  let inFlight: AbortController | null = null;

  rl.on("SIGINT", () => {
    if (inFlight) {
      inFlight.abort();
      return;
    }
    rl.close();
  });

  // History lives in the checkpointer now, keyed by this. `/clear` mints a new
  // one rather than deleting anything: the old session stays addressable, which
  // is what makes both `/resume` and time travel possible at all.
  // Annotated, because `crypto.randomUUID()` narrows to a template-literal type
  // and a session id adopted from disk is an ordinary string.
  let session: string = crypto.randomUUID();
  // How many messages of this session have already been rendered. The graph hands
  // back the whole branch on every values event, so without a watermark every
  // tool line would be reprinted each lap.
  let rendered = 0;
  let pending: Pending | null = null;
  // The sessions on offer while the picker is up. Non-null puts the loop in the
  // same shape `pending` does: the next line read is an answer, not a prompt.
  let picking: Session[] | null = null;
  // Whether this session has any messages yet. `/resume` is refused once it has
  // — switching away from a session that is mid-conversation would leave its
  // state parked with no way back to it from here, and an empty session is a
  // session that **does not exist on disk at all** (the saver only creates the
  // file on its first append), so leaving that one behind costs nothing.
  let touched = false;
  // What this session has spent so far. Kept here rather than re-read from the
  // file after every turn: the console already walks each new message once to
  // render it, and the same walk can add up what it cost — see `renderStructure`.
  let spent: Spend = noSpend();
  let byModel: Record<string, Spend> = {};

  /**
   * Carries on from a session this process did not start.
   *
   * Two things have to be recovered, and only one of them is the messages.
   * Measured in `repro/18-resume-at-an-open-gate.ts`: a confirmation gate that
   * was open when the process died is still on disk, and answering it from a
   * cold process runs **the command that was captured before the crash**. So the
   * first thing on screen after resuming into a parked session is that gate —
   * not a prompt, which would invite exactly the input that orphans it.
   */
  const adopt = async (chosen: Session): Promise<Pending | null> => {
    session = chosen.id;
    touched = true;
    process.stdout.write(`${describeSession(chosen)}\n\n`);

    const state = await graph.getState({ configurable: { thread_id: session } });
    // The watermark comes from the graph, not from the row's message count: the
    // row counts bodies stored in the file, the renderer counts the branch it is
    // printing, and the two part ways the moment history is rewritten or forked.
    rendered = state.values.messages?.length ?? 0;
    // Seeded from the row rather than recomputed: the lister already summed this
    // file, and the running total has to continue the session, not restart it.
    spent = { ...chosen.spent };
    byModel = Object.fromEntries(
      Object.entries(chosen.byModel).map(([model, cost]) => [model, { ...cost }]),
    );

    const requests = (state.tasks ?? []).flatMap((task) =>
      (task.interrupts ?? []).flatMap(
        (stop) =>
          (stop.value as { actionRequests?: ActionRequest[] } | undefined)
            ?.actionRequests ?? [],
      ),
    );
    if (requests.length === 0) return null;

    const gate: Pending = { requests, decisions: [], editing: false };
    ask(gate);
    return gate;
  };

  /**
   * Folds one turn's cost into the session's running total, and says so.
   *
   * One line at the end of a turn, because the console has no status area to put
   * it in: pi keeps these numbers in a footer, which needs a TUI, and this is a
   * readline prompt. Scrollback is the only always-visible surface we have.
   *
   * Silent when a turn spent nothing — a slash command that loaded a skill and
   * called no model has nothing to report, and printing zeroes would teach the
   * eye to skip the line that matters.
   */
  const account = (turn: TurnResult): void => {
    if (turn.credits.length === 0) return;
    for (const [model, cost] of turn.credits) {
      addSpend(spent, cost);
      addSpend((byModel[model] ??= noSpend()), cost);
    }
    process.stdout.write(`${DIM}  ∑ ${spendLine(spent)}${RESET}\n`);
  };

  /** Shows the list and hands the next line to the picker. */
  const offer = async (): Promise<void> => {
    const sessions = await listSessions(stateDir);
    process.stdout.write(`${renderSessionList(sessions)}\n\n`);
    picking = sessions.length === 0 ? null : sessions;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Reading input: a line belongs to whatever the console was asking when it
  // **arrived**, not to whatever it happens to be asking when the line is read.
  //
  // That distinction is the whole of ticket 04, and it was a shipping bug rather
  // than a nicety. `for await (const line of rl)` does not pause readline while
  // the body is awaiting a turn — the events keep firing and the async iterator
  // buffers them, then replays them when the loop comes back (measured, both on
  // a TTY and on a pipe: `repro/15-typing-during-a-turn.ts`). The arrival order
  // survives; the arrival *moment* does not, and the moment is the only thing
  // that distinguishes "answering the gate" from "was typed before the gate
  // existed". Collecting the lines ourselves is what keeps it.
  //
  // ⚠️ **Only on a terminal.** Piped input has no such moment: the whole script
  // was written before the process started, its order is deliberate, and there is
  // no human whose stray keystroke needs protecting. Enforcing arrival there
  // would make it impossible to answer a gate from a script at all — which is how
  // this program is driven in probes and tests. So the rule is on where it
  // protects somebody and off where it would only get in the way, and that is a
  // decision rather than an oversight.
  type Tag = "input" | "gate" | "picker";
  interface Arrived {
    tag: Tag;
    text: string;
  }

  const strict = process.stdin.isTTY === true;
  const arrived: Arrived[] = [];
  let ended = false;
  let wake: (() => void) | null = null;

  const asking = (): Tag =>
    pending !== null ? "gate" : picking !== null ? "picker" : "input";

  rl.on("line", (raw) => {
    arrived.push({ tag: asking(), text: raw.trim() });
    wake?.();
  });
  rl.on("close", () => {
    ended = true;
    wake?.();
  });

  /**
   * The next line this console is allowed to act on, or null once input ends.
   *
   * Everything the arrival rule buys is in here; the loop below is unchanged.
   */
  const take = async (): Promise<Arrived | null> => {
    for (;;) {
      if (strict) {
        // A decision typed at a gate that has since been answered, or a choice
        // typed at a picker that is gone, can never be consumed. Dropping it
        // silently would be the same class of bug in the other direction, so it
        // is dropped out loud.
        for (let index = arrived.length - 1; index >= 0; index -= 1) {
          const item = arrived[index];
          if (item === undefined) continue;
          const stale =
            (item.tag === "gate" && pending === null) ||
            (item.tag === "picker" && picking === null);
          if (!stale) continue;
          arrived.splice(index, 1);
          process.stdout.write(
            `${DIM}(dropped, the question it answered is gone: ${item.text})${RESET}\n`,
          );
        }
      }

      const want = asking();
      const index = strict ? arrived.findIndex((item) => item.tag === want) : 0;
      if (index !== -1 && arrived.length > 0) {
        const [item] = arrived.splice(index, 1);
        if (item !== undefined) return item;
      }
      if (ended) return null;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  };

  process.stdout.write(`${BANNER}\n\n`);

  if (start.kind === "session") pending = await adopt(start.session);
  else if (start.kind === "pick") await offer();

  rl.setPrompt("> ");
  rl.prompt();

  for (;;) {
    const line = await take();
    if (line === null) break;
    const input = line.text;

    if (picking !== null) {
      const choice = readChoice(input, picking);
      if (choice.kind === "again") {
        process.stdout.write(`${DIM}enter a number, or press enter${RESET}\n`);
        rl.prompt();
        continue;
      }
      const chosen = choice.kind === "pick" ? choice.session : null;
      picking = null;
      if (chosen === null) process.stdout.write("(new session)\n\n");
      else pending = await adopt(chosen);
      rl.prompt();
      continue;
    }

    if (pending) {
      const resume = readDecision(input, pending);
      if (resume === null) {
        rl.prompt();
        continue;
      }
      // Cleared **before** the turn runs, not after it. Every request in the
      // batch has an answer by now, so the question is over — and while the
      // resumed turn is in flight, `asking()` must already say "input" or a line
      // typed during it would be tagged as a decision for a gate that is gone,
      // and dropped as stale instead of becoming the next turn.
      pending = null;
      // The decision was typed at the "> " prompt, so the resumed output would
      // otherwise start on that same line.
      process.stdout.write("\n");
      inFlight = new AbortController();
      const turn = await runTurn(graph, resume, session, rendered, inFlight.signal);
      inFlight = null;
      account(turn);
      pending = finish(turn);
      rendered = turn.rendered;
      rl.prompt();
      continue;
    }

    if (input === "/exit") break;

    if (input.length === 0) {
      rl.prompt();
      continue;
    }

    if (input === "/cost") {
      process.stdout.write(`${spendBreakdown(byModel)}\n\n`);
      rl.prompt();
      continue;
    }

    if (input === "/clear") {
      session = crypto.randomUUID();
      rendered = 0;
      touched = false;
      spent = noSpend();
      byModel = {};
      process.stdout.write("(new session)\n\n");
      rl.prompt();
      continue;
    }

    // Only before this session has said anything — see `touched`. The refusal
    // names the way through rather than just saying no: `/clear` then `/resume`
    // is the supported way to switch mid-conversation, and it is one step
    // instead of a second mechanism precisely because that step is "finish with
    // this one first".
    if (input === "/resume" || input.startsWith("/resume ")) {
      if (touched) {
        process.stdout.write(
          `${DIM}this session has already started — /clear first, then /resume${RESET}\n\n`,
        );
        rl.prompt();
        continue;
      }

      const prefix = input.slice("/resume".length).trim();
      if (prefix === "") {
        await offer();
        rl.prompt();
        continue;
      }

      const found = await resolveSession(stateDir, prefix);
      if (found.kind === "one") pending = await adopt(found.session);
      else if (found.kind === "none") {
        process.stdout.write(`${DIM}no session starts with ${prefix}${RESET}\n\n`);
      } else {
        // Ambiguity is a shorter list, not an error: the candidates are exactly
        // what a picker is for, and the user is already sitting at one.
        process.stdout.write(`${renderSessionList(found.candidates)}\n\n`);
        picking = found.candidates;
      }
      rl.prompt();
      continue;
    }

    // Slash commands beyond the built-ins. `/exit` and `/clear` are handled
    // above, which is what makes them win over a skill of the same name.
    if (input.startsWith("/")) {
      const command = parseSkillCommand(input, skills);

      if (command.type === "list") {
        process.stdout.write(`${renderSkillList(skills)}\n\n`);
        rl.prompt();
        continue;
      }

      if (command.type === "unknown") {
        process.stdout.write(`${DIM}unknown command — try /skills${RESET}\n\n`);
        rl.prompt();
        continue;
      }

      // The skill body enters as a pinned activation message; anything typed
      // after the name is this turn's task and enters as an ordinary user
      // message, pinned by the graph like every other turn's input. Same loader
      // as the Skill tool — only the message shape differs.
      const messages: BaseMessage[] = [
        skillActivationMessage(command.skill),
        ...(command.tail !== undefined ? [new HumanMessage(command.tail)] : []),
      ];

      inFlight = new AbortController();
      touched = true;
      const turn = await runTurn(
        graph,
        { messages },
        session,
        rendered,
        inFlight.signal,
      );
      inFlight = null;
      account(turn);
      pending = finish(turn);
      rendered = turn.rendered;
      rl.prompt();
      continue;
    }

    // No system message here. The prompt is handed to the agent at construction
    // and prepended to every model call from outside the thread — see
    // AgentOptions.systemPrompt for why it must not live in state.
    //
    // Not pinned here, deliberately: pinning what the user typed is the graph's
    // job, not the console's — see `pinTurnTask`. A guarantee that depends on
    // which caller invoked the graph is not a guarantee.
    const messages: BaseMessage[] = [new HumanMessage(input)];

    touched = true;
    inFlight = new AbortController();
    const turn = await runTurn(graph, { messages }, session, rendered, inFlight.signal);
    inFlight = null;

    account(turn);
    pending = finish(turn);
    rendered = turn.rendered;
    rl.prompt();
  }

  rl.close();
  process.stdout.write("\nbye\n");
}

/** Prints whatever the turn produced, and returns the batch still waiting. */
function finish(turn: TurnResult): Pending | null {
  if (turn.error !== null) process.stdout.write(`${describeError(turn.error)}\n`);
  if (turn.requests === null) {
    process.stdout.write("\n");
    return null;
  }

  const pending: Pending = { requests: turn.requests, decisions: [], editing: false };
  ask(pending);
  return pending;
}

/** Prints the request now awaiting a decision. */
function ask(pending: Pending): void {
  const request = pending.requests[pending.decisions.length];
  if (request === undefined) return;

  const detail =
    typeof request.args["command"] === "string"
      ? request.args["command"]
      : JSON.stringify(request.args);

  const count =
    pending.requests.length > 1
      ? ` (${String(pending.decisions.length + 1)}/${String(pending.requests.length)})`
      : "";

  process.stdout.write(
    `\n${DIM}⚠${RESET} ${request.name}${count} wants to run:\n    ${detail}\n` +
      `${DIM}  [a] approve   [e] edit   [r] reject (any other text becomes the reason)${RESET}\n`,
  );
}

/**
 * Folds one line into the pending batch. Returns a Command once every request in
 * the batch has a decision, and null while more input is needed.
 */
export function readDecision(input: string, pending: Pending): Command | null {
  const request = pending.requests[pending.decisions.length];
  if (request === undefined) return null;

  // ⚠️ **An empty line is not a decision.** It used to share a branch with
  // `"a"`, and that was a shipping bug rather than a rough edge: measured on a
  // TTY as well as a pipe (`repro/15-typing-during-a-turn.ts`), a line typed
  // while a turn is running is buffered by readline and replayed when the loop
  // comes back — so the Enter somebody presses out of impatience **approved a
  // Bash command they had never seen**.
  //
  // The trap is the other direction, and it is why this is a branch of its own
  // rather than a deletion: dropping `|| input === ""` alone turns the same
  // keystroke into `reject{ message: "" }`, which is a *different* decision, not
  // the absence of one. Both states that read a line are covered — an empty
  // replacement command would otherwise run an empty command, the same shape
  // again.
  //
  // ⚠️ This does **not** fix the neighbouring case: a sentence typed during the
  // turn still lands as a rejection reason. That one needs the gate to stop
  // consuming lines typed before it opened, which is a rewrite of how the loop
  // reads input — see the session line's ticket 04.
  if (input === "") {
    if (pending.editing) process.stdout.write(`${DIM}  replacement command:${RESET}\n`);
    else ask(pending);
    return null;
  }

  if (pending.editing) {
    pending.editing = false;
    pending.decisions.push({
      type: "edit",
      editedAction: { name: request.name, args: { ...request.args, command: input } },
    });
  } else if (input === "a") {
    pending.decisions.push({ type: "approve" });
  } else if (input === "e") {
    pending.editing = true;
    process.stdout.write(`${DIM}  replacement command:${RESET}\n`);
    return null;
  } else if (input === "r") {
    pending.decisions.push({ type: "reject" });
  } else {
    // Anything else is a rejection with a reason — the model reads it, so
    // "not on production" is more useful than a bare refusal.
    pending.decisions.push({ type: "reject", message: input });
  }

  if (pending.decisions.length < pending.requests.length) {
    ask(pending);
    return null;
  }

  return new Command({ resume: { decisions: pending.decisions } });
}

interface TurnResult {
  /** Tool calls the gate stopped, or null when the turn ran to completion. */
  requests: ActionRequest[] | null;
  /** What this turn's new messages cost, keyed by the model that was paid. */
  credits: [string, Spend][];
  /** New watermark for how much of the thread has been printed. */
  rendered: number;
  error: unknown;
}

/**
 * Runs one turn through the graph and renders it as it arrives.
 *
 * Two stream modes at once, because they answer different questions.
 * `"messages"` carries token-level chunks — that is what makes the reply appear
 * as it is written. `"values"` carries the whole state after each node, which is
 * the only reliable place to notice that a tool ran, and the only place an
 * interrupt shows up. Rendering tool activity from state rather than from chunks
 * keeps the two concerns apart: chunks are for prose, state is for structure.
 */
async function runTurn(
  graph: AgentGraph,
  input: { messages: BaseMessage[] } | Command,
  session: string,
  rendered: number,
  signal: AbortSignal,
): Promise<TurnResult> {
  let requests: ActionRequest[] | null = null;
  const credits: [string, Spend][] = [];
  let dimmed = false;
  // When the last activity dot was printed; see the subagent branch below.
  let lastDot = 0;
  let error: unknown = null;

  // One per turn, so a reply that ends inside an unclosed code fence — the model
  // stopped early, or Ctrl+C landed mid-block — cannot leave the next reply
  // rendering as code.
  const markdown = markdownStream((text) => process.stdout.write(text));

  const openDim = (): void => {
    if (!dimmed) {
      process.stdout.write(DIM);
      dimmed = true;
    }
  };
  const closeDim = (): void => {
    if (dimmed) {
      process.stdout.write(RESET);
      dimmed = false;
    }
  };

  try {
    // The array form of streamMode yields [mode, payload] tuples; the typings do
    // not narrow that, so this is the one place we assert the shape.
    const stream = (await graph.stream(input, {
      streamMode: ["messages", "values"],
      recursionLimit: RECURSION_LIMIT,
      durability: DURABILITY,
      signal,
      // ⚠️ The one place two vocabularies meet. `thread_id` is LangGraph's key
      // and it addresses the whole tree — which is what `CONTEXT.md` calls a
      // **session**. A `thread` is one branch inside it, of which there is
      // exactly one today because nothing here ever passes a `checkpoint_id`.
      configurable: { thread_id: session },
    })) as AsyncIterable<[string, unknown]>;

    for await (const [mode, payload] of stream) {
      if (mode === "values") {
        // An interrupt arrives as a values event carrying *only* `__interrupt__`
        // — no messages key at all. Reading state.messages unguarded here is a
        // crash, not a missing feature.
        const state = payload as {
          messages?: BaseMessage[];
          __interrupt__?: { value?: { actionRequests?: ActionRequest[] } }[];
        };

        const stopped = state.__interrupt__?.[0]?.value?.actionRequests;
        if (stopped !== undefined) requests = stopped;
        if (state.messages !== undefined) {
          // Flushed first, and not as a precaution. A held partial line would
          // otherwise be printed *after* the tool-call line below it, which
          // arrives on a different event stream — the transcript would show the
          // model's sentence appearing after the call it introduced.
          markdown.flush();
          rendered = renderStructure(state.messages, rendered, closeDim, credits);
        }
        continue;
      }

      const [chunk, metadata] = payload as [BaseMessage, unknown];
      if (chunk.getType() === "tool") continue; // Rendered from state instead.

      if (fromSubagent(metadata)) {
        // Throttled to one a second, not one per chunk: an explore agent writing five
        // hundred tokens produced five hundred dots, which is a different kind
        // of noise. At this rate the row of dots is roughly how long the explore agents
        // have been running, which is the only thing it should be saying.
        const now = Date.now();
        if (now - lastDot < 1000) continue;
        lastDot = now;

        // A subagent's tokens are dropped rather than rendered. They arrive on
        // this same stream — inherited through AsyncLocalStorage, so there is
        // nothing to switch off at the call site — and with two explore agents running
        // they interleave character by character into something nobody can read
        // (measured; see the transcript in the T5 notes). Nothing is lost: the
        // report comes back as a tool result, and the agent relays it.
        //
        // One dim dot per chunk, because the alternative is a silent minute. It
        // says the run is alive without printing anything that has to be read.
        openDim();
        process.stdout.write("·");
        continue;
      }

      const reasoning = chunk.additional_kwargs["reasoning_content"];
      if (typeof reasoning === "string" && reasoning.length > 0) {
        openDim();
        process.stdout.write(reasoning);
      }

      if (typeof chunk.content === "string" && chunk.content.length > 0) {
        if (dimmed) {
          closeDim();
          process.stdout.write("\n\n");
        }
        // The reply is markdown and gets read as markdown. The reasoning above
        // deliberately does not: it is dim by the paragraph and rendering it
        // would compete with the answer for the eye.
        markdown.push(chunk.content);
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    // Flushed on every exit path for the same reason the dim escape is closed on
    // every exit path: an interrupt or a failure mid-line must not swallow the
    // text the model had already produced.
    markdown.flush();
    // The dim escape has to be closed on every exit path, or an interrupt during
    // reasoning leaves the whole terminal dimmed.
    closeDim();
    process.stdout.write("\n");
  }

  return { requests, credits, rendered, error };
}

/** How much of a tool call's arguments fits on one line of the transcript. */
const CALL_WIDTH = 76;

/**
 * One line naming a tool call, short enough to read at a glance.
 *
 * `Task` is singled out, and it earns it: dispatches are the one call that comes
 * in threes, and the serialised arguments of three of them are identical for the
 * first sixty characters — `{"description":"Read /Users/…/src` — so the default
 * rendering printed three indistinguishable lines. Leading with the kind and
 * then the objective is what makes concurrent explore agents tellable apart, which is
 * the whole point of showing them.
 */
export function summarizeCall(name: string, args: unknown): string {
  const fields = (args ?? {}) as { description?: unknown; subagent_type?: unknown };

  if (name === TASK_TOOL_NAME && typeof fields.description === "string") {
    const kind = typeof fields.subagent_type === "string" ? fields.subagent_type : "?";
    return `${name}[${kind}] ${clip(fields.description, CALL_WIDTH)}`;
  }

  return `${name} ${clip(JSON.stringify(args), CALL_WIDTH)}`;
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 3)}...` : text;
}

/**
 * Whether a streamed chunk came from a subagent rather than from the agent.
 *
 * The obvious discriminator is the message's `name` — the agent's own messages
 * carry `"model"`, a subagent's carry its kind — and it is the wrong one:
 * measured, `name` is absent on *streamed* chunks and only appears on the
 * finished message (`repro/12-subagent-stream.ts`).
 *
 * What does distinguish them is nesting depth, in the metadata that rides
 * alongside every chunk. The agent's own model chunks carry a single-segment
 * `checkpoint_ns` (`model_request:<id>`); a subagent's carry a nested one
 * (`tools:<id>|model_request:<id>`), and `|` is langgraph's namespace separator.
 * Depth, not identity — which is also why this keeps working if a second kind of
 * subagent is registered.
 */
export function fromSubagent(metadata: unknown): boolean {
  const namespace = (metadata as { checkpoint_ns?: unknown } | undefined)
    ?.checkpoint_ns;
  return typeof namespace === "string" && namespace.includes("|");
}

/**
 * Prints one dim line per tool call and per result, for the messages that have
 * appeared since the last time we looked. Returns the new watermark.
 */
function renderStructure(
  messages: BaseMessage[],
  rendered: number,
  closeDim: () => void,
  credits: [string, Spend][],
): number {
  for (const message of messages.slice(rendered)) {
    const type = message.getType();
    // The same walk that renders a message counts what it cost. Riding the
    // watermark is what makes it exact: every message is passed exactly once,
    // and the values stream hands back the whole thread on every lap.
    credits.push(...creditsOf(message));

    if (type === "ai") {
      const calls = (message as { tool_calls?: { name: string; args: unknown }[] })
        .tool_calls;
      for (const call of calls ?? []) {
        closeDim();
        process.stdout.write(
          `\n${DIM}· ${summarizeCall(call.name, call.args)}${RESET}`,
        );
      }
    }

    if (type === "tool") {
      // MessageContent is a string or an array of content blocks; tools only ever
      // produce the former, but the type has to be narrowed anyway.
      const body =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      const lines = body.split("\n");
      const failed = body.startsWith("Error:") || body.startsWith("error:");
      const summary = failed
        ? (lines[0] ?? "failed")
        : `${String(lines.length)} line${lines.length === 1 ? "" : "s"}`;
      process.stdout.write(`${DIM} → ${summary}${RESET}\n`);
    }
  }

  return messages.length;
}

/** Turns whatever the graph threw into one line a user can act on. */
export function describeError(error: unknown): string {
  const outcome = classify(error);
  if (outcome.kind === "abort") return "^C interrupted";
  if (outcome.reason === "recursion") {
    return `stopped after ${String(RECURSION_LIMIT)} steps without a final answer`;
  }
  if (outcome.reason === "llm_status") {
    const status = outcome.status;
    const message = (outcome.error as { message?: string }).message;
    const hint =
      status === 401 || status === 403
        ? " (check the provider's API key)"
        : status === 429
          ? " (rate limited, or out of balance)"
          : status === 402
            ? " (insufficient balance)"
            : "";
    return `llm ${String(status)}: ${message ?? ""}${hint}`;
  }
  return failureText(outcome.error);
}
