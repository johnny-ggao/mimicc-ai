import { relative, resolve, sep } from "node:path";

import { ROOT } from "./workspace";

/**
 * The hard floor: paths whose whole point is to hold secrets, plus git internals
 * and the agent's own conversation history (`.mimicc`). Tool output is sent to
 * the model, so an unconstrained path is an exfiltration channel rather than
 * merely a read — see `docs/adr/0007`.
 *
 * Moved here from `workspace.ts` so the permission gate owns the one copy of the
 * check. `isSecret` stays public for Grep, which *skips* rather than *refuses*.
 */
export const SECRET =
  /(^|\/)\.env(\.|$)|(^|\/)\.git\/|(^|\/)\.mimicc(\/|$)|(^|\/)id_[a-z]+$|\.pem$|\.key$/;

/**
 * Whether a workspace-relative path is one of the files we never search. Grep
 * needs this separately from the hard floor: it *skips* a secret file rather
 * than *refusing* the whole search.
 */
export function isSecret(path: string): boolean {
  return SECRET.test(`/${path}`);
}

/**
 * Resolves a workspace-relative path to an absolute one, with no security
 * judgement. The judgement lives in {@link decide}, which the permission gate
 * runs before a tool ever executes — so the tools stay free of it, and there is
 * exactly one copy of the check.
 */
export function resolvePath(path: string): string {
  return resolve(ROOT, path);
}

/**
 * The tools allowed out of the working directory: `Read` alone.
 *
 * 🔴 **Nothing was allowed out until Terminal-Bench priced the rule.** Four
 * tasks in run `2026-08-27__22-37-36` had a path outside `/app` refused —
 * `/usr/bin/curl`, which *was* that task's answer; `/protected/maze_server.py`;
 * a site-packages module; `/tmp` — and all four times the model reached for
 * `cat` or a heredoc through `Bash` and got exactly what it had been refused.
 * The floor never held the access. It bought a wasted lap and moved the same
 * action onto the one path with no gate on it
 * (`.scratch/external-bench/issues/05-failure-triage.md`, D).
 *
 * ⚠️ **Read only, and the asymmetry is the point.** `Bash` can write outside
 * too, but a write's blast radius is not a wasted lap, and `Write`/`Edit` ask
 * before they run while `Read` allows by default. Letting the *silent* tool out
 * is the cheap half of the trade; letting the mutating ones out is a separate
 * decision with a separate cost.
 */
const ESCAPE_ALLOWED = new Set(["Read"]);

/**
 * Credential files that live outside a repository, checked against the absolute
 * path once {@link ESCAPE_ALLOWED} lets a read out of the working directory.
 *
 * {@link SECRET} was written for paths *inside* a repository and is still right
 * there. It does not name `~/.ssh` or `~/.aws`, because until now nothing could
 * reach them: the escape rule covered the whole filesystem by covering
 * everything at once. Widening Read removed that cover, so the floor has to name
 * the places credentials actually live.
 */
const SECRET_OUTSIDE =
  /(^|\/)\.(?:ssh|aws|gnupg|docker|kube|azure)(?:\/|$)|(^|\/)\.config\/(?:gcloud|gh)(?:\/|$)|(^|\/)\.(?:netrc|npmrc|pgpass|pypirc)$|(^|\/)credentials(?:\.[a-z]+)?$/;

/**
 * Why the hard floor denies this path, or null when it does not.
 *
 * The hard floor is the part of the permission gate no rule can relax: it blocks
 * touching credential files, and it blocks leaving the working directory for
 * every tool except the ones in {@link ESCAPE_ALLOWED}.
 */
export function denyReason(path: string, tool?: string): string | null {
  const full = resolve(ROOT, path);
  const outside = full !== ROOT && !full.startsWith(ROOT + sep);
  if (outside && !(tool !== undefined && ESCAPE_ALLOWED.has(tool))) {
    return `path escapes the working directory: ${path}`;
  }
  // Outside, the absolute path is what the patterns are about — `relative` would
  // hand them a `../../` prefix that means nothing to a rule about `~/.ssh`.
  const subject = outside ? full : relative(ROOT, full);
  if (SECRET.test(`/${subject}`) || (outside && SECRET_OUTSIDE.test(subject))) {
    return `refusing to touch ${subject}: it may hold credentials, and tool output is sent to the model`;
  }
  return null;
}

/* ---------- rules ---------- */

/** The tools a rule may address: the ones that carry a path or a command. */
const RULEABLE_TOOLS = new Set(["Read", "Write", "Edit", "Bash"]);

export type RuleDecision = "allow" | "ask" | "deny";

/** One parsed permission rule: `Read(src/**)` becomes a tool plus a glob. */
export interface Rule {
  tool: string;
  specifier: string;
  decision: RuleDecision;
}

/** A merged set of rules, evaluated deny → ask → allow. */
export type RuleSet = Rule[];

/** The fields the gate keys on: the tool name plus its path or command. */
export interface ToolCall {
  tool: string;
  path?: string;
  command?: string;
}

/**
 * Extracts a {@link ToolCall} from a langchain tool call. Only `path` and
 * `command` matter — Glob/Grep's `pattern`, Write's `content` and the rest are
 * dropped because no rule keys on them.
 */
export function toolCallOf(toolCall: { name: string; args: unknown }): ToolCall {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  return {
    tool: toolCall.name,
    ...(path !== undefined ? { path } : {}),
    ...(command !== undefined ? { command } : {}),
  };
}

/**
 * Parses one `Tool(specifier)` string into a rule, or throws.
 *
 * The specifier is a gitignore-style path glob for Read/Write/Edit, and a
 * command prefix for Bash (a trailing `*` and `:` are stripped). Any other tool
 * has no path or command to key on, so it is refused here rather than silently
 * matching nothing.
 */
export function parseRule(spec: string, decision: RuleDecision): Rule {
  const match = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/.exec(spec);
  if (match === null) {
    throw new Error(`malformed permission rule: ${spec} (expected Tool(specifier))`);
  }
  const tool = match[1] ?? "";
  const specifier = match[2] ?? "";
  if (!RULEABLE_TOOLS.has(tool)) {
    throw new Error(
      `permission rules cannot target ${tool} — it has no path or command`,
    );
  }
  if (specifier === "") {
    throw new Error(`malformed permission rule: ${spec} (empty specifier)`);
  }
  return { tool, specifier, decision };
}

/** Whether a rule addresses the given call. */
export function matchesRule(rule: Rule, call: ToolCall): boolean {
  if (rule.tool !== call.tool) return false;
  if (rule.tool === "Bash") {
    if (call.command === undefined) return false;
    const prefix = rule.specifier.replace(/[*:]+$/, "");
    return call.command.startsWith(prefix);
  }
  if (call.path === undefined) return false;
  return new Bun.Glob(rule.specifier).match(call.path);
}

/** The permission gate's verdict for one tool call. */
export interface Verdict {
  decision: "allow" | "ask" | "deny";
  /** Present only on a denial — the message the model reads. */
  reason?: string;
}

/**
 * Decides whether a tool call may run: deny, ask, or allow.
 *
 * Order matters, and it is the whole of the gate's semantics:
 *
 * 1. the hard floor (escape + secret) — nothing, not even an `allow` rule,
 *    relaxes it;
 * 2. `deny` rules;
 * 3. `ask` rules;
 * 4. `allow` rules;
 * 5. the baseline — mutating tools ask, read-only and frequent ones allow,
 *    and a curated set of read-only Bash commands (`ls`, `pwd`, `git status`,
 *    `git branch`) allow without asking.
 *
 * So a deny always beats an allow, and an allow can only loosen the baseline,
 * never the hard floor. The rules are already merged before they reach here —
 * merging is the loader's job (`permissionConfig.ts`).
 *
 * `auto` is the posture switch: it flips only the baseline's ask to allow, so
 * the mutating tools stop asking. It is deliberately the *last* resort — a deny
 * rule, an ask rule, and the hard floor all still hold, because auto mode only
 * touches the "ask or not" axis, never the "allowed or not" one.
 */
export function decide(call: ToolCall, rules?: RuleSet, auto = false): Verdict {
  if (call.path !== undefined) {
    const reason = denyReason(call.path, call.tool);
    if (reason !== null) return { decision: "deny", reason };
  }

  if (rules !== undefined) {
    // One pass over the decisions in priority order — deny first, so a deny
    // always beats an ask or allow that also matches.
    for (const decision of ["deny", "ask", "allow"] as const) {
      for (const rule of rules) {
        if (rule.decision !== decision || !matchesRule(rule, call)) continue;
        if (decision === "deny") {
          return {
            decision: "deny",
            reason: `denied by rule: ${rule.tool}(${rule.specifier})`,
          };
        }
        return { decision };
      }
    }
  }

  return { decision: auto ? "allow" : baseline(call.tool, call.command) };
}

/**
 * The tools that allow by default: read-only, or frequent enough that a gate
 * firing constantly would stop being read (the memory tools; Clarify, which is
 * itself the asking; and the read-only dispatcher Task / the read-only Skill).
 *
 * Names are literals rather than the exported constants because importing
 * `SKILL_TOOL_NAME` here would close `tools → skills → tools`. `tests/agent.test.ts`
 * "Write, Edit and Bash ask by default" fails if a tool lands outside this set
 * without being named — adding a tool forces a decision, ask or allow.
 */
const ALLOW_BY_DEFAULT = new Set([
  "Read",
  "Glob",
  "Grep",
  "Task",
  "Skill",
  "Clarify",
  "MemorySearch",
  "MemoryAdd",
  "MemoryUpdate",
  "MemoryDelete",
]);

/**
 * Read-only Bash commands that allow without asking: they list names or status,
 * never file *content* — the hard floor does not reach Bash, so `cat .env`
 * would leak the secret's value, which is exactly why content-reading commands
 * are deliberately not here.
 */
const SAFE_COMMANDS = ["ls", "pwd", "git status", "git branch"] as const;

/** Whether a Bash command is one of the read-only, name-listing safe ones. */
function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  return SAFE_COMMANDS.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
  );
}

/**
 * Which tools ask by default. Mutating tools ask; the read-only and frequent
 * ones allow, and Bash allows its safe read-only commands. Fail-closed: a tool
 * not in {@link ALLOW_BY_DEFAULT} asks, so a newly registered mutating tool
 * cannot silently auto-approve — it asks until someone names it an allow-default.
 */
function baseline(tool: string, command?: string): "allow" | "ask" {
  if (tool === "Bash" && command !== undefined && isSafeCommand(command)) {
    return "allow";
  }
  return ALLOW_BY_DEFAULT.has(tool) ? "allow" : "ask";
}
