/**
 * Does langchain know how big deepseek-v4-flash's context window is? No.
 *
 * Free — constructs a model object, makes no request. `getProfileLimits` is the
 * function both `summarizationMiddleware` and `ClearToolUsesEdit` call to turn
 * `trigger: { fraction }` / `keep: { fraction }` into an absolute token count.
 */
import { ChatOpenAI } from "@langchain/openai";
import { getModelContextSize } from "@langchain/core/language_models/base";
// Not on any public export path; reached through dist deliberately.
import { getProfileLimits } from "../node_modules/langchain/dist/agents/middleware/summarization.js";

const m = new ChatOpenAI({
  model: "deepseek-v4-flash",
  apiKey: "sk-not-used",
  configuration: { baseURL: "https://api.deepseek.com" },
});

const bag = m as unknown as { model?: string; profile?: unknown };
console.log("model field            =", bag.model);
console.log("'profile' in model     =", "profile" in m);
console.log("profile                =", JSON.stringify(bag.profile));
console.log("getModelContextSize    =", getModelContextSize("deepseek-v4-flash"));
console.log("  (fabricated name)    =", getModelContextSize("totally-made-up-model-9000"));
console.log("  (gpt-4o, for contrast)=", getModelContextSize("gpt-4o"));
console.log("getProfileLimits(model)=", getProfileLimits(m as never));
console.log("");
console.log("truth per DeepSeek docs = 1000000  (https://api-docs.deepseek.com/quick_start/pricing)");
console.log("so trigger:{fraction:0.8} resolves to", Math.floor(Number(getProfileLimits(m as never)) * 0.8),
  "instead of", 0.8 * 1_000_000);
