/**
 * The denominator, made concrete. No API calls — pure arithmetic over bytes we
 * already ship, so it costs nothing and can be re-run after any prompt change.
 *
 * Run: `bun bench/window-budget.ts`
 *
 * `deepseek-v4-flash`'s context length is **1M tokens** (max output 384K),
 * per DeepSeek's own Models & Pricing table:
 * https://api-docs.deepseek.com/quick_start/pricing
 * That number is not obtainable from the API — `GET /models` returns only
 * {id, object, owned_by}, and langchain's `getModelContextSize()` answers 4097
 * for every model it does not have in its hardcoded switch
 * (@langchain/core/dist/language_models/base.js:44-96, `default: return 4097`).
 */
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

import { buildSystemPrompt } from "../src/agents";
import { TOOLS } from "../src/tools";
import { MAX_FILE_BYTES } from "../src/tools/workspace";

const WINDOW = 1_000_000;
/** First request of the frozen baseline: system + tools + one HumanMessage. */
const MEASURED_RESIDENT = 2386;

const systemPrompt = buildSystemPrompt({
  cwd: "/Users/johnny/Work/Project/mimicc-ai",
  platform: "darwin",
  today: "2026-08-13",
  isGitRepo: true,
});
const toolsJson = TOOLS.map((t) => JSON.stringify(convertToOpenAITool(t))).join("");

const rows: [string, number][] = [
  ["system prompt", systemPrompt.length],
  ["tool schemas", toolsJson.length],
];
rows.push(["TOTAL", rows.reduce((s, [, c]) => s + c, 0)]);

process.stdout.write("resident in every request\n");
process.stdout.write("segment           chars   approx(/4)   deepseek(x0.3)\n");
for (const [name, chars] of rows) {
  process.stdout.write(
    name.padEnd(16) +
      String(chars).padStart(6) +
      String(Math.ceil(chars / 4)).padStart(13) +
      String(Math.ceil(chars * 0.3)).padStart(17) +
      "\n",
  );
}

const perMaxRead = Math.ceil(MAX_FILE_BYTES / 4);
const perTypicalRead = Math.ceil(6_000 / 4);
const room = WINDOW - MEASURED_RESIDENT;

process.stdout.write(
  `\nwindow ${WINDOW.toLocaleString()} tokens\n` +
    `measured resident (baseline request 1) ${MEASURED_RESIDENT} = ` +
    `${((MEASURED_RESIDENT / WINDOW) * 100).toFixed(3)}% of it\n` +
    `room left for history ${room.toLocaleString()}\n` +
    `\none Read clipped at MAX_FILE_BYTES (${MAX_FILE_BYTES}) ~ ${perMaxRead} tokens ` +
    `-> ${Math.floor(room / perMaxRead)} of them fill the window\n` +
    `one Read of a typical 6KB source file ~ ${perTypicalRead} tokens ` +
    `-> ${Math.floor(room / perTypicalRead)} of them fill the window\n` +
    `\nwhole frozen baseline (3 turns, 6 requests) input 19718 = ` +
    `${((19718 / WINDOW) * 100).toFixed(2)}% of one window\n` +
    `largest single baseline request 4046 = ${((4046 / WINDOW) * 100).toFixed(2)}%\n` +
    `\nlangchain default trigger for contextEditing is 100_000 tokens = ` +
    `${((100_000 / WINDOW) * 100).toFixed(0)}% of the window\n` +
    `if trigger:{fraction} is used, getModelContextSize returns 4097, so 0.8 -> ` +
    `${Math.floor(4097 * 0.8)} tokens\n`,
);
