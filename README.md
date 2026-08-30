# mimicc-ai

用于 agent 开发的 TypeScript 脚手架。**Bun 独占**——包管理与运行时都是它，ESM + 严格模式
TypeScript。

## 快速开始

```bash
bun install
cp .env.example .env   # 按需填写
bun run dev
```

## 脚本

全部由 Bun 触发并执行。

| 命令                              | 作用                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `bun run dev`                     | 监听模式运行 `src/main.ts`，改动即重启                 |
| `bun run chat`                    | 同上但不监听——改文件不会打断正在进行的对话             |
| `bun run build`                   | 清空 `dist/` 后用 `bun build` 打包成单文件 + sourcemap |
| `bun run start`                   | 运行构建产物 `dist/main.js`（需先 `bun run build`）    |
| `bun run clean`                   | 删除 `dist/`（跨平台，不依赖 `rm`）                    |
| `bun run typecheck`               | `tsc --noEmit`，只做类型检查                           |
| `bun run test`                    | Bun 内置测试运行器                                     |
| `bun run test:watch`              | 测试监听模式                                           |
| `bun run test:coverage`           | 覆盖率，低于门槛非零退出                               |
| `bun run lint` / `lint:fix`       | ESLint（开启了类型感知规则）                           |
| `bun run format` / `format:check` | Prettier                                               |
| `bun run check`                   | typecheck + lint + format:check + test，CI 跑的就是它  |
| `bun run install:global`          | 装到全局（`scripts/install.sh`）；`update:global` 更新 |

部署路径是 `bun run build` → `bun run start`。`dev` 跑源码，生产跑 `dist/main.js`，两者不混用。

## 目录与文件

`src/` **按领域分目录**，一个目录一件事，`index.ts` 是它的桶：

```
src/
  main.ts        可执行入口：读配置、装配、把 REPL 跑起来
  index.ts       公开导出（无副作用的 barrel）
  config.ts      环境变量 schema 与校验（zod）
  models.ts      provider / 模型注册表：baseURL、默认模型、窗口上限
  usage.ts       token 账：四个不相交的桶，按模型分栏
  logger.ts      结构化日志，JSON 单行写 stderr
  agents/        循环本身：装配、模型、提示词、两个 guard、崩溃恢复、子 agent 种类
  context/       模型看得见的那份上下文：投影、摘要、项目 instructions、降级
  checkpoint/    落盘：session 文件、旁挂的工具流水、消息编解码
  session/       盘上的 session：列出、打开、前缀解析
  console/       用户面对的终端：REPL、渲染、选择器、输入队列、花费
  tools/         工具与它们的护栏
  skills/        外部装的技能：读取、目录、Skill 工具
  memory/        跨 session 的记忆
tests/           与 src 同构，`bun test` 全量跑
docs/adr/        判过的架构决定（八条）
repro/           复现探针：每个脚本回答一个「当时不知道」的问题
bench/           量测基线
learn/           教学工作区（已在 prettier / eslint 里排除）
scripts/         install.sh：装到全局 / 更新
```

| 文件                                   | 作用                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `CONTEXT.md`                           | **领域词表**：session / thread / 回合 / 中止 / 失败 的边界 |
| `package.json`                         | 依赖、脚本、`engines`                                      |
| `bun.lock`                             | 依赖锁文件，**要提交**                                     |
| `tsconfig.json`                        | 仅用于类型检查（`noEmit`），打包交给 `bun build`           |
| `bunfig.toml`                          | Bun 配置，目前用于覆盖率门槛                               |
| `eslint.config.js`                     | ESLint 扁平配置，开启类型感知规则                          |
| `.prettierrc.json` / `.prettierignore` | 代码格式规则与排除项                                       |
| `.editorconfig`                        | 编辑器级基础约定，跨 IDE 生效                              |
| `.bun-version`                         | Bun 版本的单一事实来源，CI 从它读                          |
| `.env.example`                         | 环境变量模板兼文档；真实 `.env` 不进版本库                 |

## 去哪找「为什么」

**这个仓库把「为什么」写在代码里。** 一段代码为什么长这样、什么被量过、什么被判过不做，
写在它自己上方的注释里，不在文档里——所以下面这几处各自只负责一件事，**都不复述代码**：

| 想知道                                                     | 去哪                                             |
| ---------------------------------------------------------- | ------------------------------------------------ |
| 某段代码为什么是这样                                       | **代码注释本身**（这里最厚，也最新）             |
| 一个词的边界（session 和 thread 差在哪、中止和失败差在哪） | `CONTEXT.md`                                     |
| 一个架构决定为什么这么判、代价认在哪                       | `docs/adr/`                                      |
| 某个行为到底是不是这样（有没有实测）                       | `repro/`，每个探针的表头写着它回答什么、花不花钱 |
| 某个数字是怎么来的                                         | `bench/`                                         |

⚠️ **这份 README 只讲「怎么跑起来」和「东西在哪」。** 它曾经详细描述过循环内部，
那些内容在 ADR 0002 删掉手画的图之后**全部失效过一次**——文档复述代码，代码一改文档就开始骗人。

## 版本固定

两样东西各自锁在一处，CI 和本地读的是同一份：

| 对象 | 锁在哪         | 是否强制                  |
| ---- | -------------- | ------------------------- |
| Bun  | `.bun-version` | CI 读取；本地靠约定       |
| 依赖 | `bun.lock`     | CI 用 `--frozen-lockfile` |

`package.json` 的 `engines.bun` 只声明下限，**装依赖时不校验**——Bun 没有 pnpm `engineStrict`
的等价物。版本一致性实际靠 `.bun-version` 加 CI 里读它那一步保证。

## 约定

- **Bun 独占**：装依赖、跑脚本、执行代码全是它，锁文件只有 `bun.lock`。不要用
  `npm install` / `pnpm install`，会产生与之漂移的第二份锁文件（`.gitignore` 已挡掉
  `pnpm-lock.yaml`）。
- **类型检查不在运行时发生**：Bun 直接剥离类型执行，不校验。类型错误只有
  `bun run typecheck` 会报，所以它必须留在 CI 里——这是 CI 存在的首要理由。
- **环境变量**：统一在 `src/config.ts` 的 schema 里声明，代码读 `loadConfig()` 的返回值，
  不直接摸 `process.env`。缺失或非法的变量会在启动时一次性报错。
- **`.env` 由 Bun 自动加载**，不需要任何 flag，也没有 dotenv 依赖。
- **导入不写扩展名**（`import { loadConfig } from "./config"`）——`moduleResolution: bundler`
  加 Bun 的解析器都支持，不必像 Node ESM 那样写 `.js`。
- **跨目录导入用 `@/` 别名**（`@/*` → `src/*`），同目录的兄弟模块用相对路径。别名避免了
  目录变深后出现 `../../../`。tsc、`bun test`、`bun build` 三处解析一致，只在
  `tsconfig.json` 的 `paths` 里配置一次（`@/*` → `./src/*`）。
- **日志走 stderr**，stdout 留给程序正常输出，方便管道。
- **类型严格度**：开启了 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等额外
  检查。如果某处确实过严，在该文件局部放宽，而不是全局关掉。

## 提交前检查

> **当前状态：没有生效的提交前检查。** `.husky/pre-commit` 是一个 no-op。
> 原计划是对暂存文件跑 lint-staged，但 `lint-staged` 既没进 `devDependencies` 也没有任何
> 配置，`package.json` 里也没有 `prepare` 脚本去装 husky 钩子。保持 no-op 是为了不让第一次
> `git commit` 被一个跑不起来的钩子拦下。

要启用，三步：

1. `bun add -d lint-staged husky`
2. `package.json` 加 `"prepare": "husky"`（让 `bun install` 自动装钩子），并加 lint-staged
   配置：`*.{ts,js}` 跑 `eslint --fix` 再 `prettier --write`；`*.{json,md,yml,yaml}` 只跑
   `prettier --write`
3. 取消 `.husky/pre-commit` 里 `bunx lint-staged` 那行的注释

**typecheck 和测试不该进钩子**——它们需要全量跑，会让每次提交都变慢，交给 CI 更合适。
绕过钩子用 `git commit --no-verify`，但 CI 仍会拦。

## 覆盖率

门槛在 `bunfig.toml`，当前 `0.8`，`bun run test:coverage` 低于门槛会非零退出，CI 会挂。

有一个 Bun 的局限要知道：**它只统计被测试实际加载过的文件**。完全没有人 import 的模块
不会出现在报告里，也不会拉低这个数字。所以它衡量的是"已测代码的质量"，不是"测了多少"。
不要拿它当测试完备性的证据。

## 已知约束

- `typescript` 锁在 5.x。TypeScript 7（原生移植版）会让 `typescript-eslint` 直接报
  `does not support TS 7.0` 并拒绝运行，等它跟进后再升。
- **机器上不需要 Node。** ESLint、Prettier、tsc 都是 Node CLI，但 Bun 能直接执行它们——
  `bun --bun run typecheck / lint / format:check` 三项本机实测通过，CI 也不再安装 Node。
- `engines.bun` 只是声明，装依赖时不强制校验（见「版本固定」）。
- **`@langchain/openai` 自带一份 `openai@6.49.0`**。跨副本的类身份不同，所以**不要用
  `instanceof OpenAI.APIError` 判别错误**——会全部落到兜底分支。按 `status` 判别。

## LLM 接入

模型层是 `@langchain/openai` 的 `ChatOpenAI`，走 **OpenAI 兼容协议**——协议兼容不代表用的是
OpenAI 的模型。选哪个 provider、哪个模型，由 `src/models.ts` 的注册表决定，每个 provider 自带
baseURL、默认模型、API key 变量，每个模型自带窗口上限和 maxTokens 这两个**实测/文档事实**。

| 变量                      | 必填           | 默认值                 | 说明                                     |
| ------------------------- | -------------- | ---------------------- | ---------------------------------------- |
| `LLM_PROVIDER`            | 否             | `zhipu-cn`             | `zhipu-cn` / `deepseek` / `moonshot-cn`  |
| `LLM_DEEPSEEK_API_KEY`    | 选 DeepSeek 时 | 无                     | DeepSeek key；`LLM_API_KEY` 是其弃用别名 |
| `LLM_MOONSHOT_CN_API_KEY` | 选 Moonshot 时 | 无                     | Moonshot 中国区 key                      |
| `LLM_ZHIPU_CN_API_KEY`    | 选智谱时       | 无                     | 智谱开放平台 key（国内区）               |
| `LLM_MODEL`               | 否             | 该 provider 的默认模型 | 必须是注册过的模型，未知即启动报错       |
| `LLM_BASE_URL`            | 否             | provider 注册表里的值  | 代理 / 自建端点的逃生门                  |

DeepSeek 默认模型 `deepseek-v4-flash`；Moonshot 中国区默认 `kimi-k3`，另有 `kimi-k2.7-code`、
`kimi-k2.6`（`https://api.moonshot.cn/v1`，`/v1` 必带，与中国区 `.cn` / 国际区 `.ai` 是两套
平台两套 key）；智谱只注册了 `glm-5.3-flash`，窗口 1,048,576、输出上限 131,072（**都是实测**）。

⚠️ **智谱有两条 OpenAI 端点，账号类型决定哪条应答。** 注册表写的是 **Coding Plan** 那条
`https://open.bigmodel.cn/api/coding/paas/v4`；按量付费的账号走
`https://open.bigmodel.cn/api/paas/v4`，用 `LLM_BASE_URL` 覆盖即可。拿 Coding Plan 的 key
去打按量付费那条，**每一发都回 `429 1113 余额不足`**，包括合法请求——文档只写了后一条，
所以这个坑不查是踩定的。国内 `open.bigmodel.cn` 与国际 `z.ai` 同样是两套平台两套 key。

⚠️ **智谱的超窗报错 langchain 认不出来**（`{"code":"1261","message":"Prompt exceeds max length"}`，
不匹配它写死的三句英文），所以注册表额外给它登记了 `overflowCodes`——没有这一条，溢出保护
对这家是空转的。词表里叫**溢出码**（见 `CONTEXT.md`），来龙去脉在 `src/models.ts` 的条目
注释和 `docs/research/glm-provider-facts.md`。

`LLM_MODEL` 必须是注册表里写明的模型：窗口上限是溢出保护靠它算的，而对一个没核实过窗口的别名
猜一个数，正是这里拒绝的事。

⚠️ **默认 provider 2026-08-30 从 `deepseek` 改成了 `zhipu-cn`**，这改的是**空环境**的行为，
不只是文档：只带 `LLM_API_KEY`（DeepSeek 的弃用别名）的环境以前能跑，现在会在启动时报
「missing API key for provider "zhipu-cn"」，要一并设 `LLM_PROVIDER=deepseek`。
**这是弃用在生效，不是回归**——但它发生在启动那一刻，所以写在这里，别让人踩第二次。

## 控制台

`bun run chat`（或 `bun run dev`）进入 REPL：

| 操作      | 行为                                                              |
| --------- | ----------------------------------------------------------------- |
| 回车      | 发送，回复流式打印；reasoning 用暗色，正文用常色                  |
| 工具调用  | 每次调用打一行暗色 `· Read {...} → 36 lines`                      |
| Bash      | 停下来问：`[a] approve  [e] edit  [r] reject`，别的文字即拒绝理由 |
| `/skills` | 列出装到本机的技能                                                |
| `/cost`   | 这条 session 花了多少，按模型分栏                                 |
| `/resume` | 从更早的一条 session 接着聊（**只在这条还没说过话时可用**）       |
| `/clear`  | 开一条新 session，**旧的留在盘上**，仍可 `/resume` 回去           |
| `/exit`   | 退出，等同 Ctrl+D                                                 |
| `Ctrl+C`  | 回复进行中则中断本次回复；空闲时按下则退出                        |

命令行上还有 `--resume`（列出历史让你选）和 `--resume <id 前缀>`（直接接上那一条）。

`--print "<任务>"`（短 `-p`）**跑一个回合就退出**，不开 REPL——它是给不会打字的调用方准备的
（外部 benchmark 的 agent 接口就是「把任务当参数跑一次」这个形状）。stdout 只放最终答复，
其余走 stderr，所以它可以被管道接。⚠️ **它不隐含 `--auto`**：没有人可问的时候，确认门一律
判**拒绝**并把理由告诉模型，于是不带 `--auto` 的一次性运行几乎什么都改不了。
**这是有意的**——`auto` 是你说的「别问」，不该由一个标志替你说。要它干活就显式给 `--auto`。

**历史落在盘上，不随进程消失。** 一条 session 是两个文件：`<id>.jsonl` 与旁挂的
`<id>.tools.jsonl`。停在确认门上的 session 被 kill 之后，重启还能**在那道门上继续做那个决定**
——不是重新问模型，是恢复那次调用（`repro/18`、`repro/23` 实测）。

**回合进行中敲下的行会排队**，但它不进当前回合，而是自成一个新回合，开跑前会说一声。
**至多排一条**（终端上），多的出声丢掉；**Ctrl+C 连队列一起清**——它是队列之外的中止信号，
而 `/clear` 这些自己就是队列里的一条行。管道里这些规矩全部关掉：脚本的顺序是刻意的。

**被 Ctrl+C 打断的回复不会进入历史**：状态只在节点边界提交，已经流出来的正文只存在于终端上。

日志走 stderr，所以 `LOG_LEVEL=warn` 能得到干净的对话记录，`bun run chat 2>/dev/null` 也行。

## 循环

循环建在 **LangChain 的 `createAgent`** 上，装配在 `src/agents/loop.ts`
（`createUniversalAgent`）。**图不是本仓库画的**——手画的那版 `StateGraph`（`llmCall` +
`ToolNode` + 回边）在 **ADR 0002** 里被判为「重造 `node_modules` 里已有的约 760 行」并删掉了。
主 agent 和每种子 agent 走的是同一个装配器，差别只在装了哪些 middleware。

真正属于本仓库的是挂在上面的那些东西，各自一个文件、各自把「为什么」写在自己头上：

| 装的东西    | 在哪                                    | 挡的是什么                                           |
| ----------- | --------------------------------------- | ---------------------------------------------------- |
| 上下文投影  | `context/projection.ts`                 | 模型看见的那份历史怎么从盘上的历史算出来（ADR 0004） |
| 摘要 / 窗口 | `context/compaction.ts`                 | 窗口溢出                                             |
| 确认门      | `agents/loop.ts` 的 `confirmationGate`  | 只有 Bash 会问；子 agent 一律没有（ADR 0003）        |
| 跑飞兜底    | `agents/loopguard.ts` / `stallguard.ts` | 原地打转、卡住                                       |
| 崩溃恢复    | `agents/recovery.ts`                    | 进程被 kill 之后不重复已完成的副作用                 |
| 落盘        | `checkpoint/`                           | 历史与工具流水，`durability: "sync"`                 |

**要读它，从 `src/agents/loop.ts` 的 `createUniversalAgent` 开始往下读注释**——
middleware 的**顺序**是承重的，为什么是这个顺序写在每一段旁边，有两处还有断言钉着。

## DeepSeek 的行为

传输、分片拼装、错误映射现在都在 `ChatOpenAI` 里，不再是本仓库的代码。但下面这些 DeepSeek
与 OpenAI 的差异仍然会影响你，**全部为 2026-08-12 对 deepseek-v4-flash / -pro 的实测**：

- DeepSeek 会多返回 `reasoning_content`，该字段不在 OpenAI 协议里。**v4 默认就返回它**，
  不是推理模型专属。`ChatOpenAI` 把它放进 `additional_kwargs.reasoning_content`，流式 chunk
  上也有——REPL 的暗色思考就是从那里读的。要关掉用 `thinking: { type: "disabled" }`，但实测
  关掉后总 token 反而更多（模型不思考时正文写得更长），别当省钱手段用。
- **`reasoning` 的回传约束反转了，但比看上去窄得多。**旧规则是「必须丢掉，否则 400」。
  v4 实测（2026-08-12）：只有当 assistant 轮带 `tool_calls`、**且那个 tool_call id 不是
  DeepSeek 自己签发过的**，才要求回传 `reasoning_content`（报错原文 “The
  \`reasoning_content\` in the thinking mode must be passed back to the API.”）。
  DeepSeek 签发过的 id——**哪怕来自另一段对话**——不带也是 200；格式相符但从未签发的假 id
  会 400。流式与否无差别；`thinking: { type: "disabled" }` 下一律通过。
- 所以**正常 agent 循环不会撞上它**，id 都来自模型。框架的 converter 发出去时**会丢掉**
  `reasoning_content`，DeepSeek 对自签发的 id 仍返回 200——但 `src/agents/model.ts` 现在把它
  原样回传，对 DeepSeek 无害、且把「非自签发 id 才报错」那个窄例也堵上了（Moonshot 无条件要求
  回传，这一步是它跑得起来的必要条件）。
- **`tool_choice: "required"` 不被支持**：400 `Thinking mode does not support this tool_choice`。
  想强制调工具得靠提示词，或先关 thinking。
- **v4 两个模型都支持 `tools`**（实测）。`temperature` / `top_p` 在 v4 上未实测；旧的
  `deepseek-reasoner` 三者都不支持，适配器只在字段存在时才发送，这个防御保留着。
- 余额不足是 **402**，OpenAI 用 429——这是唯一的状态码语义差异。`src/console/repl.ts` 的
  `describe()` 按 `status` 给提示，因为跨包的 `instanceof` 判别不可靠（见「已知约束」）。
- `usage` 里除 OpenAI 标准字段（`prompt_tokens_details.cached_tokens`、
  `completion_tokens_details.reasoning_tokens`）外，还叠加了私有的
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。**多出来的字段不影响协议兼容性**
  ——客户端只读自己认识的键，这也是「除 reasoning 之外都兼容」这个判断成立的原因。LangChain
  把缓存数规范化成 `usage_metadata.input_token_details.cache_read`。

## 依赖说明

| 依赖                   | 用途                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `langchain`            | `createAgent` 与 middleware 协议——循环的骨架，本仓库不自己画图 |
| `@langchain/langgraph` | 图运行时、检查点协议（本仓库自己实现了落盘的那一版 saver）     |
| `@langchain/openai`    | `ChatOpenAI`，模型层兼传输层                                   |
| `@langchain/core`      | 消息类型、`tool()`；被上面几个依赖                             |
| `zod`                  | 环境变量校验、工具参数 schema                                  |
