import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { NEVER_REPLAY } from "./replay";
import { neutralizeControlTags } from "./untrusted";

/**
 * Web search as a first-class client tool, behind a designed backend seam.
 *
 * ## The two decisions this file is built on (web-tools ticket 01, 2026-08-31)
 *
 * **Search happens on the client, never inside the provider's chat endpoint.**
 * A server-side search tool bypasses everything this harness is: the scale
 * cannot weigh it, the journal cannot record it, the permission gate never sees
 * it, and the injected page content reaches the model with no chance to
 * neutralise it. So the tool below is an ordinary HTTP call this process makes
 * — visible in `tools.jsonl` like any other call.
 *
 * **The deliverable is the seam, not the vendor.** {@link SearchBackend} is the
 * whole contract; a backend is one file that implements it, and the config
 * picks one by name. Exactly one backend stays alive at a time — deer-flow paid
 * for thirteen community adapters and got "one swappable web_search" back,
 * which is the trade this seam takes without the thirteen.
 *
 * The shipped backend is 智谱's standalone Web Search API. It bills per call
 * from the *platform balance*, not the Coding Plan the chat endpoint runs on —
 * `repro/56` measured `429 1113` on an unfunded account, and `200` after a
 * small top-up (2026-08-31). When the account runs dry again the 1113 message
 * reaches the model verbatim: a tool that fails out loud beats a capability
 * that silently vanished.
 */

/** One search result, normalised across backends. */
export interface SearchHit {
  title: string;
  url: string;
  /** Snippet-level summary — backends do not return full pages. */
  content: string;
  /** ISO-ish date when the backend reports one. */
  publishDate?: string;
}

export interface SearchOptions {
  /** How many hits to ask for. Backends may return fewer. */
  count: number;
  /** Restrict to pages published within this window, when the backend can. */
  recency?: "day" | "week" | "month" | "year";
}

/**
 * The backend seam. `search` either resolves to hits (possibly zero — zero is
 * an answer, not an error) or throws with the provider's own words, so a quota
 * refusal reaches the model as what it is rather than as an empty result.
 */
export interface SearchBackend {
  /** Names the backend in config, logs and error messages. */
  id: string;
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
}

/** Ask-for bounds. The default is small on purpose: hits are prompt bytes. */
export const SEARCH_COUNT_DEFAULT = 5;
export const SEARCH_COUNT_MAX = 10;

/** Per-hit snippet cap. A backend that rambles still costs bounded context. */
const MAX_HIT_CHARS = 2_000;

/** One network call's ceiling. Search is interactive; a hung backend is a no. */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * 智谱 standalone Web Search API (`POST {base}/web_search`), the shipped
 * backend. Same key as the chat endpoint, different billing pool — see the
 * header note and `repro/56`.
 */
export function zhipuWebSearch(
  apiKey: string,
  baseURL = "https://open.bigmodel.cn/api/paas/v4",
): SearchBackend {
  const recencyMap = {
    day: "oneDay",
    week: "oneWeek",
    month: "oneMonth",
    year: "oneYear",
  } as const;

  return {
    id: "zhipu-web-search",
    async search(query, options) {
      const response = await fetch(`${baseURL}/web_search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          search_engine: "search_std",
          search_query: query,
          count: options.count,
          ...(options.recency !== undefined
            ? { search_recency_filter: recencyMap[options.recency] }
            : {}),
        }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      const text = await response.text();
      if (!response.ok) {
        // The provider's own words, status and all: `429 1113 余额不足` is a
        // fact the model (and the user reading the transcript) can act on;
        // "search failed" is not.
        throw new Error(
          `zhipu-web-search: HTTP ${String(response.status)} — ${text.slice(0, 300)}`,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`zhipu-web-search: non-JSON response — ${text.slice(0, 200)}`);
      }
      const results = (
        body as {
          search_result?: {
            title?: string;
            link?: string;
            content?: string;
            publish_date?: string;
          }[];
        }
      ).search_result;

      return (results ?? []).map((hit) => ({
        title: hit.title ?? "(untitled)",
        url: hit.link ?? "",
        content: (hit.content ?? "").slice(0, MAX_HIT_CHARS),
        ...(hit.publish_date !== undefined && hit.publish_date !== ""
          ? { publishDate: hit.publish_date }
          : {}),
      }));
    },
  };
}

/**
 * Picks the one live backend from configuration, or nothing.
 *
 * `undefined` means the WebSearch tool is not registered and the prompt does
 * not teach it — the same honest default the memory tools use: a tool that can
 * only fail is worse than a capability the model was never offered. That is the
 * *missing key* case. A *misspelt backend name* throws instead — same reasoning
 * as `--exclude-tools` on an unknown name: refuse, do not fall back.
 */
export function resolveSearchBackend(env: {
  MIMICC_WEB_SEARCH_BACKEND: string;
  LLM_ZHIPU_CN_API_KEY?: string | undefined;
}): SearchBackend | undefined {
  switch (env.MIMICC_WEB_SEARCH_BACKEND) {
    case "off":
      return undefined;
    case "zhipu-web-search": {
      const key = env.LLM_ZHIPU_CN_API_KEY;
      return key === undefined || key === "" ? undefined : zhipuWebSearch(key);
    }
    default:
      throw new Error(
        `MIMICC_WEB_SEARCH_BACKEND: no backend named ${env.MIMICC_WEB_SEARCH_BACKEND}. ` +
          `Known: zhipu-web-search, off`,
      );
  }
}

export const WEB_SEARCH_TOOL_NAME = "WebSearch";

/**
 * A factory rather than a constant, like `Task`: the tool closes over a live
 * backend the assembling caller resolved from the environment.
 */
export function createWebSearchTool(backend: SearchBackend) {
  return tool(
    async ({ query, count, recency }): Promise<string> => {
      const hits = await backend.search(query, {
        count: Math.min(count ?? SEARCH_COUNT_DEFAULT, SEARCH_COUNT_MAX),
        ...(recency !== undefined ? { recency } : {}),
      });

      // "There is none" said out loud, and distinguishable from "I did not
      // look" — the backend did look and found nothing.
      if (hits.length === 0) return `no results for: ${query}`;

      const rendered = hits
        .map((hit, index) => {
          const date = hit.publishDate === undefined ? "" : ` (${hit.publishDate})`;
          // 智谱 search_std 逐条地有时不给 link（实测 2026-08-31：同一响应里
          // 有的条目带、有的不带，随来源变）。空行是无声的谎——说出来，模型
          // 才知道这一条没法 WebFetch 跟进。
          const url =
            hit.url === "" ? "(no URL from the backend for this hit)" : hit.url;
          return `${String(index + 1)}. ${hit.title}${date}\n   ${url}\n   ${hit.content}`;
        })
        .join("\n");
      // Search snippets are remote content — the same neutralisation WebFetch
      // applies, for the same reason (see tools/untrusted.ts).
      return neutralizeControlTags(rendered);
    },
    {
      name: WEB_SEARCH_TOOL_NAME,
      // Never replayed: every call bills the search account. "Unchanged
      // includes money" — the same clause that makes Task unreplayable.
      metadata: { ...NEVER_REPLAY },
      description: `Search the web. Returns up to ${String(SEARCH_COUNT_MAX)} results as titles, URLs, publish dates and snippet-level summaries — snippets, not pages. To read a result in full, follow up with WebFetch on its URL.`,
      schema: z.object({
        query: z.string().min(1).describe("The search query"),
        count: z
          .int()
          .min(1)
          .max(SEARCH_COUNT_MAX)
          .optional()
          .describe(`How many results (default ${String(SEARCH_COUNT_DEFAULT)})`),
        recency: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Only pages published within this window"),
      }),
    },
  );
}
