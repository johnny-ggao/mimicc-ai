/**
 * 智谱**独立** Web Search API，用我们这把 key 够得着吗？
 *
 * Run: `bun repro/56-is-the-search-api-reachable.ts`   ⚠️ **花钱**（一发 search_std，
 * ¥0.01；不可达时是 429/4xx，零计费）
 *
 * ## 它在答什么
 *
 * web-tools 票 01 的首选后端是 `POST /api/paas/v4/web_search`（独立端点，不绑对话）。
 * 但注册表里记着一条实测（`src/models.ts:203-212`）：这把 key 是 **Coding Plan 订阅**，
 * 标准计费路径上的对话端点对它**每一发都回 `429 1113 余额不足`**。独立搜索 API 挂在
 * 同一个标准路径 `/api/paas/v4/` 下、按次从平台余额计费（文档：¥0.01/次，
 * docs.bigmodel.cn/cn/guide/tools/web-search）——**它认不认这把 key，文档没写，
 * 只能打一发**。
 *
 * ## 判据
 *
 * - **200 + 结果数组** → 后端可行，票 01 照首选走。
 * - **429（尤其 code 1113）** → coding 套餐盖不住独立搜索，「同 key 零手续」这条路死；
 *   票 01 的选型分岔（充少量余额 vs 换家）要去问用户。
 * - 其它 4xx/5xx → 报出来，单独判（可能是参数形状错，不是计费问题）。
 *
 * ⚠️ 冒烟时它跑在本地 stub 上（`LLM_BASE_URL` 重定向），stub 回的是 chat.completion
 * 形状——那一格只判「它活到了发请求那一步」，不判本探针的结论。
 */

const base = process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";

// 冒烟（LLM_BASE_URL 指到本地 stub）时不需要真 key——stub 不验授权，判据只是
// 「活到了发请求那一步」。CI 没有 `.env`，没这个兜底它会死在这里、一个请求都发不出去。
const configured = process.env.LLM_ZHIPU_CN_API_KEY;
const key =
  configured !== undefined && configured !== ""
    ? configured
    : process.env.LLM_BASE_URL !== undefined
      ? "smoke-dummy-key"
      : undefined;
if (key === undefined) {
  process.stdout.write("⚠️ 没有 LLM_ZHIPU_CN_API_KEY，这次什么都没答上。\n");
  process.exit(1);
}

const started = Date.now();
const response = await fetch(`${base}/web_search`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    search_engine: "search_std",
    search_query: "SpaceX 最近一次发射",
    count: 3,
  }),
});
const ms = Date.now() - started;

const text = await response.text();
process.stdout.write(`status=${String(response.status)} 用时 ${String(ms)}ms\n`);

let body: unknown;
try {
  body = JSON.parse(text);
} catch {
  process.stdout.write(`（响应不是 JSON）${text.slice(0, 300)}\n`);
  process.exit(1);
}

const record = body as {
  error?: { code?: string; message?: string };
  search_result?: { title?: string; link?: string; publish_date?: string }[];
};

process.stdout.write("\n=== 判据 ===\n");
if (response.ok && Array.isArray(record.search_result)) {
  process.stdout.write(
    `  ✅ **可达**。返回 ${String(record.search_result.length)} 条结果，首条：` +
      `${record.search_result[0]?.title ?? "(无标题)"} — ${record.search_result[0]?.link ?? ""}\n` +
      "     票 01 照首选走：同一把 key、独立端点、按次计费（¥0.01/发，本探针刚花掉一发）。\n",
  );
} else if (response.status === 429 || record.error?.code === "1113") {
  process.stdout.write(
    `  🔴 **coding 套餐盖不住独立搜索**（${record.error?.code ?? "429"}：` +
      `${record.error?.message ?? text.slice(0, 120)}）。\n` +
      "     「同 key 零手续」这条路死了。票 01 的分岔要问用户：充少量余额，还是换一家后端。\n",
  );
} else {
  process.stdout.write(
    `  ⚠️ 两个预设答案都不是：${text.slice(0, 300)}\n` +
      "     可能是参数形状错（对照 docs.bigmodel.cn/api-reference/工具-api/网络搜索），不是计费问题。\n",
  );
}
