import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import {
  classify,
  DURABILITY,
  failureText,
  RECURSION_LIMIT,
  type AgentGraph,
} from "../agents";
import { markdownStream, stylingEnabled } from "./markdown";
import { statusRow } from "./reasoning";
import type { CommandTick } from "../tools";
import {
  renderHistory,
  summarizeCall,
  summarizeReasoning,
  summarizeResult,
} from "./transcript";
import { describeDrops, InputQueue, type Arrived, type Tag } from "./queue";
import { describeSession, readChoice, renderSessionList } from "./picker";
import { readAnswer, renderQuestion, type Quiz } from "./clarify";
import { runSelector, type Key } from "./selector";
import { isClarifyRequest, type ClarifyAnswer, type ClarifyQuestion } from "../tools";
import { spendBreakdown, spendLine } from "./spend";
import { addSpend, creditsOf, noSpend, type Spend } from "../usage";
import { listSessions, resolveSession, type Session } from "../session";
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
  | { kind: "new"; auto: boolean; excludeTools?: readonly string[] }
  | {
      kind: "session";
      session: Session;
      auto: boolean;
      excludeTools?: readonly string[];
    }
  | { kind: "pick"; auto: boolean; excludeTools?: readonly string[] };

/** One tool call waiting on a human. Shape comes from `__interrupt__`. */
interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

type Decision = { type: "approve" } | { type: "reject"; message?: string };

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
}

export async function runRepl({
  graph,
  skills,
  stateDir,
  start,
}: ReplOptions): Promise<void> {
  const openReadline = (): ReturnType<typeof createInterface> =>
    createInterface({
      input: process.stdin,
      output: process.stdout,
      // Piped stdin (tests, here-docs) must not be forced into terminal mode.
      terminal: process.stdin.isTTY === true,
      historySize: 200,
    });

  // `let`, because the arrow-key selector has to take stdin away from readline
  // and give it back — and the only handoff that does not leak keys is closing
  // this interface and building a new one (`repro/26`; `rl.pause()` leaves both
  // consumers on the stream and the selector's Enter arrives a second time as an
  // empty line, into the queue whose empty-line handling was a shipping bug).
  let rl = openReadline();

  // True only while that handoff is in progress, and read by the `close`
  // handler. ⚠️ Without it the handoff quits the program: `rl.close()` fires
  // `close`, which sets `ended` and ends the loop — measured as the second hard
  // edge in `repro/26`.
  let handingOff = false;

  // Non-null exactly while a turn is in flight. That is also how the SIGINT
  // handler tells "interrupt the reply" apart from "quit the repl".
  let inFlight: AbortController | null = null;

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
  // The other thing the console can be holding open. Never both: a turn stops at
  // one interrupt, and `finish` sets exactly one of these.
  let quiz: Quiz | null = null;
  // How many nodes the adopted session was parked on, or 0. Set by `adopt` and
  // consumed once at the top of the loop — the three places that adopt a session
  // all return there, so the pick-up happens in one place rather than three.
  let unfinished = 0;
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
    const history = state.values.messages ?? [];
    // Printed, not skipped. The messages are all back in state either way — this
    // is for the person, who otherwise decides what to type next against an
    // empty terminal. `transcript.ts` says what it leaves out and why.
    process.stdout.write(renderHistory(history));
    // The watermark comes from the graph, not from the row's message count: the
    // row counts bodies stored in the file, the renderer counts the branch it is
    // printing, and the two part ways the moment history is rewritten or forked.
    rendered = history.length;
    // Seeded from the row rather than recomputed: the lister already summed this
    // file, and the running total has to continue the session, not restart it.
    spent = { ...chosen.spent };
    byModel = Object.fromEntries(
      Object.entries(chosen.byModel).map(([model, cost]) => [model, { ...cost }]),
    );

    const { requests, questions, unfinished: parkedNodes } = parked(state);

    // A question survives a crash the same way a gate does — it is a pending
    // write on the newest checkpoint (`repro/18`) — so resuming has to show it
    // rather than prompt. Prompting would invite a line that starts a new run
    // from START (`repro/14`) and orphans the model's tool call.
    if (questions.length > 0) {
      const waiting: Quiz = { questions, answers: [] };
      quiz = waiting;
      if (!selectable()) process.stdout.write(renderQuestion(waiting));
      return null;
    }

    if (requests.length === 0) {
      unfinished = parkedNodes;
      return null;
    }

    const gate: Pending = { requests, decisions: [] };
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
  /**
   * Whether the arrow-key selector can be shown at all.
   *
   * The same condition readline itself is configured with. Piped stdin has no
   * cursor to move and nothing to redraw, and the numbered list is not a
   * fallback there — it is the reachable half of a pair.
   */
  const selectable = (): boolean => process.stdin.isTTY === true;

  /**
   * Opens the selector on stdin, and gives stdin back however it ends.
   *
   * Not called `ask` — that name belongs to the confirmation gate's prompt, and
   * shadowing it inside this scope silently pointed `adopt`'s gate at the
   * selector instead (the compiler caught it; the two take different arguments).
   */
  const openSelector = (
    questions: readonly ClarifyQuestion[],
  ): Promise<ClarifyAnswer[] | null> =>
    borrowStdin((input) =>
      runSelector(questions, {
        write: (text) => void process.stdout.write(text),
        // Re-read every frame rather than captured once: a window resized while
        // the selector is open would otherwise clip to the old width and wrap,
        // and a wrapped line is a line the redraw miscounts.
        columns: () => process.stdout.columns ?? 80,
        onKey: (handler) => {
          const listener = (_chunk: string, key: Key): void => {
            handler(key);
          };
          input.on("keypress", listener);
          return () => void input.off("keypress", listener);
        },
      }),
    );

  /**
   * Answers whatever question is being held, through the selector, until the
   * model stops asking.
   *
   * A loop because an answer can produce another question. Resuming is not
   * optional on any path through here — including a dismissal, which resumes
   * with no answers and which `clarifyGate` reads as "proceed on an assumption".
   * Leaving without resuming would park the graph on an interrupt nobody can
   * reach, and the next thing typed would start a new run and orphan the model's
   * tool call (`repro/14`, `repro/19`).
   */
  const throughSelector = async (): Promise<void> => {
    while (quiz !== null && selectable()) {
      const answers = await openSelector(quiz.questions);
      quiz = null;
      inFlight = new AbortController();
      const turn = await runTurn(
        graph,
        new Command({ resume: answers ?? [] }),
        session,
        rendered,
        inFlight.signal,
      );
      inFlight = null;
      account(turn);
      rendered = turn.rendered;
      hold(finish(turn, !selectable()));
    }
  };

  /** Puts what a turn left waiting into the two slots the loop reads. */
  const hold = (waiting: Waiting | null): void => {
    pending = waiting?.kind === "gate" ? waiting.pending : null;
    quiz = waiting?.kind === "question" ? waiting.quiz : null;
  };

  /**
   * Folds what a turn left waiting into the two slots the loop reads.
   *
   * One helper rather than the same three lines at four call sites, and the
   * reason is the failure it prevents: forgetting to clear the *other* slot
   * leaves the console asking a question it has already been answered, or
   * holding a gate the turn resolved.
   */
  const settle = async (turn: TurnResult): Promise<void> => {
    hold(finish(turn, !selectable()));
    await throughSelector();
  };

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
  // Reading input. The rules — a line belongs to the question that was on screen
  // when it arrived, at most one may wait, only an abort empties the queue — and
  // the reasons for all three live in `queue.ts`. What stays here is the two
  // things a queue must not do: wait, and write to the terminal.

  const queue = new InputQueue(process.stdin.isTTY === true);
  let ended = false;
  let wake: (() => void) | null = null;

  const asking = (): Tag =>
    pending !== null
      ? "gate"
      : quiz !== null
        ? "question"
        : picking !== null
          ? "picker"
          : "input";

  // `inFlight !== null` is the whole of "was this typed over a running reply",
  // and it is only true at the moment the line lands — which is why it is read
  // here rather than reconstructed later.
  /**
   * Attaches the three listeners this console lives on.
   *
   * A function because the interface is rebuilt around the selector, and a
   * rebuilt interface with no listeners is a console that has stopped reading.
   * They are attached together rather than where each was first needed so that
   * "what is on `rl`" has one answer.
   */
  const attach = (target: ReturnType<typeof createInterface>): void => {
    target.on("SIGINT", () => {
      if (inFlight) {
        inFlight.abort();
        // Emptied too, and that is the point of ticket 09 rather than a tidy-up.
        // Stopping the turn while letting the line typed over it start the next
        // one is the console carrying on after being told to stop; what the queue
        // held is reported by the loop, one flush later, so it does not land in the
        // middle of the interrupted reply.
        queue.clear();
        return;
      }
      rl.close();
    });
    target.on("line", (raw) => {
      queue.push(asking(), raw.trim(), inFlight !== null);
      wake?.();
    });
    target.on("close", () => {
      // The handoff closes this interface on purpose. Treating that as end of
      // input would quit the program every time the model asked a question.
      if (handingOff) return;
      ended = true;
      wake?.();
    });
  };
  attach(rl);

  /**
   * Lends stdin to something that reads keys instead of lines, and takes it back.
   *
   * Every step here is one `repro/26` measured rather than reasoned:
   * `rl.close()` because pausing leaks the keys to both consumers;
   * `process.stdin.resume()` because closing stops the stream and a `keypress`
   * listener on a paused stream never fires; and the rebuild because a closed
   * interface does not come back. Lines typed *before* the handoff stay in the
   * queue untouched — measured, and the reason this is safe at all.
   */
  const borrowStdin = async <T>(
    fn: (input: NodeJS.ReadStream) => Promise<T>,
  ): Promise<T> => {
    handingOff = true;
    rl.close();
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    try {
      return await fn(process.stdin);
    } finally {
      process.stdin.setRawMode(false);
      rl = openReadline();
      attach(rl);
      rl.setPrompt("> ");
      handingOff = false;
    }
  };

  /**
   * The next line this console is allowed to act on, or null once input ends.
   *
   * The reporting is deliberately here and not at the moment a line is refused:
   * a refusal happens while a reply is streaming, and writing into that would
   * put the console's words in the middle of the model's sentence — the same
   * collision `runTurn` already flushes around.
   */
  const take = async (): Promise<Arrived | null> => {
    for (;;) {
      const alive = (tag: Tag): boolean =>
        tag === "gate" ? pending !== null : tag === "picker" ? picking !== null : true;
      for (const line of describeDrops(queue.sweep(alive))) {
        process.stdout.write(`${DIM}${line}${RESET}\n`);
      }

      const item = queue.take(asking());
      if (item !== undefined) return item;
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
    // Picked up before the prompt is honoured, because the alternative is a
    // prompt: the user types, and a typed message starts a **new run from
    // START** (measured, `repro/14`) — the parked calls stay parked forever and
    // the history keeps a `tool_calls` that nothing answers.
    //
    // Automatic rather than asking first, and the reason is what resuming does:
    // it marks calls that have an intent but no result as interrupted and lets
    // the model speak to the wreckage. **It executes nothing** — measured across
    // a two-call batch, the side effects stayed at the count the crash left them
    // (`repro/23`). Asking permission for that would be a gate on a risk that
    // does not exist. It is announced, not silent, because a turn the user did
    // not type is exactly the kind of thing that must say where it came from.
    if (unfinished > 0) {
      unfinished = 0;
      process.stdout.write(
        `${DIM}(picking up where the crash left off — closing the tool calls that never finished)${RESET}\n`,
      );
      inFlight = new AbortController();
      const turn = await runTurn(graph, null, session, rendered, inFlight.signal);
      inFlight = null;
      account(turn);
      await settle(turn);
      rendered = turn.rendered;
      rl.prompt();
      continue;
    }

    const line = await take();
    if (line === null) break;
    const input = line.text;

    // Said before it runs, not as a courtesy: the reply this was typed over has
    // scrolled by now, so on screen it is indistinguishable from a line the user
    // has just entered — and it is about to spend a turn of its own.
    //
    // Slash commands are left out because that last clause is the whole reason.
    // They start no turn, and each already announces itself — `(new session)`,
    // the cost table, `bye`. Narrating those would be saying twice what the
    // console is about to show once (measured: `/exit` typed over a running
    // reply got the notice, and it read as noise).
    if (line.queued && input.length > 0 && !input.startsWith("/")) {
      process.stdout.write(
        `${DIM}(typed during the last turn, running it now: ${input})${RESET}\n`,
      );
    }

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
      else {
        pending = await adopt(chosen);
        // A session resumed onto an unanswered question: the selector opens now
        // rather than after the next prompt, for `adopt`'s own reason — a prompt
        // here invites the line that starts a new run and orphans the call.
        await throughSelector();
      }
      rl.prompt();
      continue;
    }

    // Before the gate's branch only because they are exclusive; the order says
    // nothing. What matters is that both sit above the ordinary-input path, so a
    // line typed while either is open is never mistaken for a new turn.
    if (quiz) {
      const answers = readAnswer(input, quiz);
      if (answers === null) {
        // Either an empty line, which is not an answer, or one question down and
        // more to go. Both want the same thing on screen: the question now
        // waiting.
        process.stdout.write(renderQuestion(quiz));
        rl.prompt();
        continue;
      }
      // Cleared **before** the turn runs, for the gate's reason (see below): while
      // the resumed turn is in flight `asking()` must already say "input", or a
      // line typed during it is tagged for a question that is gone and dropped as
      // stale instead of becoming the next turn.
      quiz = null;
      process.stdout.write("\n");
      inFlight = new AbortController();
      const turn = await runTurn(
        graph,
        new Command({ resume: answers }),
        session,
        rendered,
        inFlight.signal,
      );
      inFlight = null;
      account(turn);
      await settle(turn);
      rendered = turn.rendered;
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
      await settle(turn);
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
      await settle(turn);
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
    await settle(turn);
    rendered = turn.rendered;
    rl.prompt();
  }

  rl.close();
  process.stdout.write("\nbye\n");
}

/**
 * What the turn left waiting for a human, if anything.
 *
 * A union rather than two nullable fields because the two are exclusive — a turn
 * stops at one interrupt — and a shape that can hold both is a shape somebody
 * will eventually fill both halves of.
 */
type Waiting = { kind: "gate"; pending: Pending } | { kind: "question"; quiz: Quiz };

/**
 * Prints whatever the turn produced, and returns what is still waiting.
 *
 * `onScreen` is false when the caller is about to open the arrow-key selector,
 * which draws the same questions itself — printing the list first would leave a
 * copy of it scrolled above the frame.
 */
function finish(turn: TurnResult, onScreen: boolean): Waiting | null {
  if (turn.error !== null) process.stdout.write(`${describeError(turn.error)}\n`);

  if (turn.questions !== null) {
    const quiz: Quiz = { questions: turn.questions, answers: [] };
    if (onScreen) process.stdout.write(renderQuestion(quiz));
    return { kind: "question", quiz };
  }

  if (turn.requests === null) {
    process.stdout.write("\n");
    return null;
  }

  const pending: Pending = { requests: turn.requests, decisions: [] };
  ask(pending);
  return { kind: "gate", pending };
}

/** Prints the request now awaiting a decision. */
/** The thing being approved: the command for Bash, the path for the file tools. */
function detailOf(request: ActionRequest): string {
  const args = request.args;
  if (typeof args["command"] === "string") return args["command"];

  const path = typeof args["path"] === "string" ? args["path"] : JSON.stringify(args);
  const content = typeof args["content"] === "string" ? args["content"] : undefined;
  const lines = content === undefined ? undefined : content.split("\n").length;
  return `${path}${lines === undefined ? "" : ` ${DIM}(${String(lines)} lines)${RESET}`}`;
}

function ask(pending: Pending): void {
  const request = pending.requests[pending.decisions.length];
  if (request === undefined) return;

  const count =
    pending.requests.length > 1
      ? ` ${DIM}(${String(pending.decisions.length + 1)}/${String(pending.requests.length)})${RESET}`
      : "";

  process.stdout.write(
    `\n${DIM}?${RESET} ${request.description ?? request.name}${count}  ${DIM}[${request.name}]${RESET}\n\n` +
      `    ${detailOf(request)}\n\n` +
      `  1  approve\n` +
      `  2  reject\n\n` +
      `${DIM}  a number, or type a rejection reason${RESET}\n`,
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
  // "approve", and that was a shipping bug rather than a rough edge: measured on
  // a TTY as well as a pipe (`repro/15-typing-during-a-turn.ts`), a line typed
  // while a turn is running is buffered by readline and replayed when the loop
  // comes back — so the Enter somebody presses out of impatience **approved a
  // Bash command they had never seen**.
  //
  // The trap is the other direction, and it is why this is a branch of its own
  // rather than a deletion: dropping `|| input === ""` alone turns the same
  // keystroke into `reject{ message: "" }`, which is a *different* decision, not
  // the absence of one.
  if (input === "") {
    ask(pending);
    return null;
  }

  if (input === "1") {
    pending.decisions.push({ type: "approve" });
  } else if (input === "2") {
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
  /**
   * Questions the model asked, or null when it asked none.
   *
   * Separate from `requests` rather than folded in, because the two interrupts
   * mean opposite things to the loop: a gate must be **answered before** a
   * command runs, and a question must be answered before the model can carry on.
   * Sharing one field would make `finish` guess which kind it is holding.
   */
  questions: ClarifyQuestion[] | null;
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
  input: { messages: BaseMessage[] } | Command | null,
  session: string,
  rendered: number,
  signal: AbortSignal,
): Promise<TurnResult> {
  let requests: ActionRequest[] | null = null;
  let questions: ClarifyQuestion[] | null = null;
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

  // The chain of thought, on one row that gets repainted rather than a block
  // that gets appended. Why it is one row and not three is in `reasoning.ts`;
  // the short version is that `\x1b[2K` clears one screen row, so one row is
  // the only unit this console can take back.
  const thinking = statusRow({
    write: (text) => process.stdout.write(text),
    // Read per repaint, not captured: a window can be resized mid-block.
    columns: () => process.stdout.columns ?? 80,
    // Two switches rather than one, because they are about different things:
    // repainting needs a terminal, dimming needs colour to be wanted at all.
    isTTY: process.stdout.isTTY === true,
    styled: stylingEnabled(),
  });

  /**
   * The same one-row treatment for a command that is still running.
   *
   * A second `statusRow` rather than sharing the thinking one, because the two
   * are never open together — the model has stopped streaming by the time a tool
   * runs — and because what they carry differs: one accumulates prose, the other
   * restates a fact (`replace`, not `push`).
   */
  /**
   * What the live row says while a command runs.
   *
   * Kept local rather than in `transcript.ts`: that file owns wording that has
   * to read the same in a resumed session, and this row **leaves no trace** —
   * the permanent record is the tool line `renderStructure` prints when the
   * result lands. Seconds and bytes together, because they answer different
   * questions: `0.0 KB` after `40s` is what a hung command looks like, and a
   * growing byte count is what work looks like.
   */
  const runningRow = (tick: CommandTick): string => {
    const seconds = Math.round(tick.elapsedMs / 1000);
    const head = tick.command.replace(/\s+/g, " ").slice(0, 60);
    return `${head} · ${String(seconds)}s · ${(tick.bytes / 1024).toFixed(1)} KB`;
  };

  const running = statusRow({
    write: (text) => process.stdout.write(text),
    columns: () => process.stdout.columns ?? 80,
    isTTY: process.stdout.isTTY === true,
    styled: stylingEnabled(),
  });

  /**
   * Ends the open block of reasoning, if there is one, leaving the one line that
   * stands for it.
   *
   * ⚠️ Called before **everything** else that writes — prose, structure, the
   * subagent dots — and that is the whole contract. The live row is erased with
   * `\r`, which clears whatever row the cursor is on: anything printed while the
   * row is still open lands inside it and then gets wiped.
   */
  /**
   * Erases the running-command row, if one is open.
   *
   * ⚠️ Same contract as {@link settleThinking} and for the same reason — the row
   * is taken back with `\r`, so whatever prints next would land inside it. The
   * two are separate calls because the tick handler settles one and repaints the
   * other; folding them together would erase the row it is about to draw.
   */
  const settleRunning = (): void => {
    running.settle();
  };

  const settleThinking = (): void => {
    const block = thinking.settle();
    if (block === undefined) return;
    // Before the trace writes its own dim, because that trace ends with RESET
    // and would otherwise turn off a dim this function does not own.
    closeDim();
    process.stdout.write(`${DIM}· ${summarizeReasoning(block)}${RESET}\n`);
  };

  try {
    // The array form of streamMode yields [mode, payload] tuples; the typings do
    // not narrow that, so this is the one place we assert the shape.
    const stream = (await graph.stream(input, {
      // "custom" carries the tick a running command emits. Without it the
      // console has nothing to say between "the model asked for Bash" and
      // however many minutes later the result lands — and a silent minute and a
      // hung command look exactly alike (`.scratch/external-bench/issues/07`).
      streamMode: ["messages", "values", "custom"],
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
          // `unknown`, because two middlewares raise interrupts with different
          // payloads and narrowing is each reader's own job below.
          __interrupt__?: { value?: unknown }[];
        };

        const value = state.__interrupt__?.[0]?.value;
        const stopped = (value as { actionRequests?: ActionRequest[] } | undefined)
          ?.actionRequests;
        if (stopped !== undefined) requests = stopped;
        // The other interrupt source. Told apart by its own tag rather than by
        // "has no actionRequests", because absence is what an unrelated third
        // source would also look like — and reading this one as a gate with an
        // empty batch would auto-approve it.
        if (isClarifyRequest(value)) questions = value.questions;
        if (state.messages !== undefined) {
          // A tool result is about to be printed, so the row that stood for it
          // running has done its job.
          settleRunning();
          // The block of reasoning that led to this structure ends here: the
          // model thought, then it reached for a tool.
          settleThinking();
          // Flushed first, and not as a precaution. A held partial line would
          // otherwise be printed *after* the tool-call line below it, which
          // arrives on a different event stream — the transcript would show the
          // model's sentence appearing after the call it introduced.
          markdown.flush();
          rendered = renderStructure(state.messages, rendered, closeDim, credits);
        }
        continue;
      }

      if (mode === "custom") {
        const tick = payload as CommandTick | undefined;
        if (tick?.command === undefined) continue;
        // Same contract as the subagent dot below: the live row is erased with
        // `\r`, so anything printed while the thinking block is open lands
        // inside it and is then wiped. Settle first, always.
        settleThinking();
        running.replace(runningRow(tick));
        continue;
      }

      const [chunk, metadata] = payload as [BaseMessage, unknown];
      if (!fromModel(chunk)) continue;

      if (fromSubagent(metadata)) {
        // Throttled to one a second, not one per chunk: an explore agent writing five
        // hundred tokens produced five hundred dots, which is a different kind
        // of noise. At this rate the row of dots is roughly how long the explore agents
        // have been running, which is the only thing it should be saying.
        const now = Date.now();
        if (now - lastDot < 1000) continue;
        lastDot = now;

        // A dot printed while the live row is open would land inside it. This
        // cannot be reasoned away by "a subagent only runs inside a tool call,
        // so the main model is not streaming" — the block is still open until
        // the values event arrives, and that is later.
        settleThinking();

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
        thinking.push(reasoning);
      }

      if (typeof chunk.content === "string" && chunk.content.length > 0) {
        // The block ends the moment the model starts answering.
        settleThinking();
        if (dimmed) {
          closeDim();
          process.stdout.write("\n\n");
        }
        // The reply is markdown and gets read as markdown. The reasoning does
        // not: it is one dim row while it happens and one dim line afterwards,
        // and rendering either would compete with the answer for the eye.
        markdown.push(chunk.content);
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    // The running-command row goes first for the same reason, and it matters
    // most here: an interrupt lands *while a command is running*, which is
    // exactly when this row is the one open.
    settleRunning();
    // Settled on every exit path, and for a sharper reason than the two below:
    // the live row is a row the terminal is still holding. An interrupt landing
    // mid-thought would otherwise leave it on screen, and the next thing printed
    // would overwrite it rather than follow it.
    settleThinking();
    // Flushed on every exit path for the same reason the dim escape is closed on
    // every exit path: an interrupt or a failure mid-line must not swallow the
    // text the model had already produced.
    markdown.flush();
    // The dim escape has to be closed on every exit path, or an interrupt during
    // reasoning leaves the whole terminal dimmed.
    closeDim();
    process.stdout.write("\n");
  }

  return { requests, questions, credits, rendered, error };
}

/**
 * What an adopted session is parked on: a question to answer, or work to finish.
 *
 * Two different parked states, and reading only the first is how a crashed batch
 * used to disappear. A session stopped **at a gate** carries an interrupt with
 * the commands in it. A session stopped **mid-batch** — the process died after
 * the calls were approved and started — carries no interrupt at all; it shows up
 * only as `next: ["tools"]` with a task per call (measured, `repro/23`).
 *
 * The two are reported separately rather than collapsed because the console does
 * opposite things with them: a gate must be *asked*, and unfinished work must be
 * *resumed* — and resuming past an unanswered gate would answer it on the user's
 * behalf. So a gate wins when somehow both are present.
 */
export function parked(snapshot: {
  tasks?: readonly { interrupts?: readonly { value?: unknown }[] }[];
  next?: readonly string[];
}): { requests: ActionRequest[]; questions: ClarifyQuestion[]; unfinished: number } {
  const waiting = (snapshot.tasks ?? []).flatMap((task) => task.interrupts ?? []);

  const requests = waiting.flatMap(
    (stop) =>
      (stop.value as { actionRequests?: ActionRequest[] } | undefined)
        ?.actionRequests ?? [],
  );

  // The third state, and leaving it out is not a cosmetic gap: an unanswered
  // question has no `actionRequests`, so the old reading saw "no gate" and fell
  // through to `unfinished`, which the console **resumes automatically**. That
  // would answer the model's question with nothing and orphan its tool call —
  // and `repro/19` measured what a provider does with an orphaned call: a 400.
  const questions = waiting.flatMap((stop) =>
    isClarifyRequest(stop.value) ? stop.value.questions : [],
  );

  const asking = requests.length > 0 || questions.length > 0;
  return {
    requests,
    questions,
    unfinished: asking ? 0 : (snapshot.next ?? []).length,
  };
}

/**
 * Whether a streamed chunk is the model speaking, rather than a message some
 * node wrote into state.
 *
 * The `"messages"` stream is not only tokens, and langgraph's own handler says
 * so verbatim: *Collects messages from (1) chat model stream events and (2) node
 * outputs* (@langchain/langgraph@1.4.9, dist/pregel/messages.js:22).
 * `handleChainEnd` (:88-102) emits every BaseMessage it finds in a node's
 * output, deduplicated only against the messages that were already in that
 * node's *input* (:80-85).
 *
 * A `beforeAgent` that injects a message is exactly what slips through that
 * dedup: on the first turn the injected message is not in the node's input, so
 * it is emitted here and rendered as if the model had written it. Both injectors
 * shipped that way — the skill catalogue and the project instructions were
 * printed above the first reply of every session, in that order
 * (`repro/22-injected-messages-hit-the-message-stream.ts`). From the second turn
 * on the same message is in state and gets deduplicated, which is why the leak
 * looked like a first-turn quirk instead of the rule it is.
 *
 * So the test is the *speaker*, not a list of the types we have noticed being
 * noisy — that list was `"tool"` alone, and it was one entry short. Everything
 * the graph writes into state is structure, and `renderStructure` already draws
 * it from the `"values"` stream.
 */
export function fromModel(chunk: BaseMessage): boolean {
  return chunk.getType() === "ai";
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
      process.stdout.write(`${DIM} → ${summarizeResult(message)}${RESET}\n`);
    }
  }

  return messages.length;
}

/** Turns whatever the graph threw into one line a user can act on. */
export function describeError(error: unknown): string {
  const outcome = classify(error);
  if (outcome.kind === "abort") return "^C interrupted";
  if (outcome.reason === "recursion") {
    return "stopped without a final answer — the graph ran away past its recursion ceiling";
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
