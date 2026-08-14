/** One tiny call, to see what the provider actually reports before normalisation. */
import { ChatOpenAI } from "@langchain/openai";
import { loadConfig } from "../src/config";

const config = loadConfig();
const model = new ChatOpenAI({
  model: config.LLM_MODEL,
  apiKey: config.LLM_API_KEY,
  configuration: { baseURL: config.LLM_BASE_URL },
  maxTokens: 16,
});

let last: { response_metadata?: Record<string, unknown>; usage_metadata?: unknown } | undefined;
for await (const chunk of await model.stream("say ok")) {
  if (chunk.usage_metadata ?? chunk.response_metadata?.["usage"]) last = chunk;
}
console.log("raw response_metadata.usage =", JSON.stringify(last?.response_metadata?.["usage"], null, 2));
console.log("normalised usage_metadata  =", JSON.stringify(last?.usage_metadata, null, 2));
