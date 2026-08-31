/**
 * Neutralising control-shaped text in content fetched from the web.
 *
 * ## The threat this answers
 *
 * A web page is the one input to this program written by somebody with no stake
 * in its correctness — and possibly a stake in its misbehaviour. A page that
 * contains `<project-instructions>` or `<system-reminder>` text lands in a
 * ToolMessage, and the model has no way to tell "the harness injected this"
 * from "the page said this": both arrive as bytes in the conversation. deer-flow
 * ships the same defence and states the trade-off in its docstring — sanitise
 * the tools whose results carry *remote* content, and deliberately leave the
 * local ones (Bash, Read) alone, because escaping angle brackets in the user's
 * own code and logs would corrupt exactly the material those tools exist to
 * show (`tool_result_sanitization_middleware.py:1-22`, checked @5d520e44).
 *
 * ## Why escaping, not stripping
 *
 * Stripping hides that the page tried; escaping keeps the bytes visible while
 * taking the tag shape away. The model can still read the text — it just reads
 * as text, which is what it was all along.
 *
 * The list names the tags this harness actually injects (plus the generic
 * `system-reminder` family other harnesses use, since imitating *any* harness
 * is the attack). It is a list, not a general "escape all tags", because the
 * page's own markup is content: a fetched article about HTML should keep its
 * `<div>`s readable.
 */

/** The tag names whose appearance in remote content is an impersonation attempt. */
const CONTROL_TAGS = [
  "system-reminder",
  "project-instructions",
  "skill-catalog",
  "memory",
  "environment",
] as const;

const CONTROL_TAG_PATTERN = new RegExp(`<(/?)(${CONTROL_TAGS.join("|")})\\b`, "gi");

/**
 * Escapes the opening bracket of any control-shaped tag in remote content, so
 * `<system-reminder>` arrives as `&lt;system-reminder>` — legible, inert.
 */
export function neutralizeControlTags(text: string): string {
  return text.replace(CONTROL_TAG_PATTERN, "&lt;$1$2");
}
