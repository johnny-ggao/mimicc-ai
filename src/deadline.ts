/**
 * 期限：这个进程不该还在干活的那个**时刻**。
 *
 * ## 为什么是时刻，不是时长
 *
 * 夹取要回答的是「**还剩**多少」，而时长在层与层之间传递会被每一层重新起算。那正是
 * ADR 0010 量到的那个机制：单次模型请求的钟是 600 秒、回合墙钟也是 600 秒，两个数字一样大、
 * 各自从自己开始的那一刻起算，于是**谁也拦不住谁**。一个绝对时刻只有一份，减出来的剩余
 * 对每一层都是同一个数。
 *
 * ## 为什么是模块级的单例
 *
 * 与 `setCommandCeiling` 同源，理由逐字相同：**入口是唯一知道有没有人挂着的那一层**。
 * `Bash` 深在工具层，中间隔着 langgraph 的图和中间件栈，没有一条能把它传下去的参数通道；
 * 而「谁来设」这件事本身是有主人的——`src/main.ts`，一次，在开跑之前。
 *
 * 🔑 **只在没人挂着的时候存在。** 交互式下这里是 `undefined`，因为人就是那把钟
 * （CONTEXT.md「期限」）。这不是省事，是同一条判据的第二次使用：`ea4fd7a` 用它决定了
 * 单条命令的默认期限，这里用它决定进程有没有总闸。
 */

/** 到点之后，被停下来的那一方拿到的东西。它是失败的一种，不是中止。 */
export class DeadlineExceeded extends Error {
  /**
   * `instanceof` 在这里不够硬：错误要穿过 langgraph 的图和 undici 的 abort 才回到我们手上，
   * 中途可能被换一个壳。一个自有的标记字段穿得过去，而 `name` 也一并对齐，因为
   * `classify` 的既有判据读的就是它。
   */
  readonly isDeadlineExceeded = true;

  constructor(
    /** 从设下期限到它响，实际过了多久。报数时要说这个，不是配置值。 */
    readonly elapsedMs: number,
    /** 哪一把钟。今天只有一把，但报数里必须有名字，否则又变成「不知道是谁响的」。 */
    readonly clock: string,
  ) {
    super(
      `${clock} deadline reached after ${String(Math.round(elapsedMs / 1000))}s — stopped with no final answer`,
    );
    this.name = "DeadlineExceeded";
  }

  static isInstance(error: unknown): error is DeadlineExceeded {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { isDeadlineExceeded?: unknown }).isDeadlineExceeded === true
    );
  }
}

/**
 * 回合预算收尾自己那两段需要的余地。
 *
 * 回合预算耗尽不是当场砍断，是**两段式**（ADR 0009）：先注入一条说明，给模型一次不带新
 * 工具调用的交卷机会，它还发工具调用才强停。走完这两段要花掉**一轮工具 + 一次模型调用**，
 * 所以总闸必须比回合预算大出这么多，否则那两段永远轮不到发生——**而那正是内层的钟不小于
 * 外层的钟会出的事**，只不过这一次是我们自己在默认值里造出来的。
 *
 * 🔑 **两侧用同一个数，于是它们互相抵消**：`--print` 没给 `--timeout` 时总闸取
 * 「回合墙钟 + 这个数」，而回合预算又被「总闸剩余 − 这个数」夹取，结果正好还是配置的
 * 那个回合墙钟。**默认路径上没有第二个常数被引入。**
 *
 * ⚠️ **只按「一次模型调用」量，不含那一轮工具。** 工具那一轮已经被同一个总闸夹着了
 * （`resolveTimeoutMs`），余地再替它留一份就是重复计账——而重复计账的代价很实在：
 * 一道题面 360 秒的 benchmark 任务，留 180 秒等于**把一半的工作时间收走**。
 *
 * ⚠️ 而「一次模型调用」这一份也只是够用，不是够：那个钟今天仍然是 openai SDK 的默认值，
 * 且重试是静默的（票 08 记着这笔账）。真超过了，硬停接手——**backstop 本来就是干这个的。**
 */
export const WRAP_UP_ROOM_MS = 60_000;

/**
 * 这次 `--print` 调用一共有多少毫秒。
 *
 * `--timeout` 是给它的值；没给就退到回合墙钟**加上收尾余地**——退到那个数不是因为它对，
 * 而是因为**在此之前它就是这条路上唯一写下来的时间数字**。
 * ⚠️ 加那一项不是保守，是不变式本身（ADR 0010）：总闸和回合预算取同一个数的话，内层的钟
 * 就不比外层小，回合预算的两段式交卷**永远轮不到发生**。
 *
 * 🔑 **抽成函数，是因为两个地方要用同一个数**：设总闸的那一行，和**告诉模型有多少时间**
 * 的那一行（票 09）。各算一遍迟早会漂，而漂了的后果很难看——模型按一个数做计划，
 * 另一个数把它掐断。
 *
 * ⚠️ 签名收成裸值而不是收 `PrintStart` / `Config`：`main.ts` 底部有 `main().catch(...)`，
 * **import 它就会把程序跑起来**，所以住在那里的函数测不了。
 */
export function runBudgetMs(
  timeoutSec: number | undefined,
  turnTimeBudgetMs: number,
): number {
  return timeoutSec !== undefined ? timeoutSec * 1000 : turnTimeBudgetMs + WRAP_UP_ROOM_MS;
}

/** 绝对时刻（`Date.now()` 的刻度），或者「没有总闸」。 */
let deadlineAt: number | undefined;

/**
 * 由 `src/main.ts` 调用。`undefined` 意思是「有人挂着，让它跑」。
 *
 * 与 `setCommandCeiling` 一样是**设一次**，不是每回合重设：期限属于这次调用，不属于某个回合。
 */
export function setProcessDeadline(at: number | undefined): void {
  deadlineAt = at;
}

/** 还剩多少毫秒，或者 `undefined`（没有总闸）。已经过期就是 0，不会是负数。 */
export function remainingMs(now: number = Date.now()): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(0, deadlineAt - now);
}

/** 夹取的结果。`asked` 只在真被夹短了的时候出现——**夹了要说，没夹不说**。 */
export interface Clamped {
  /** 实际该用的毫秒数，`undefined` 表示不设期限。 */
  ms: number | undefined;
  /** 调用方原本想要的毫秒数，仅当它比 {@link ms} 大时出现。 */
  asked?: number;
}

/**
 * `inner = min(它自己想要的, 外层剩余 − 余量)`。
 *
 * `want` 是 `undefined`（这一层没有自己的期限）时，结果就是外层剩余减余量——**没有总闸的时候
 * 才是 `undefined`**。余量留给被停下来之后还要走完的那一步：一条命令被杀掉之后，至少还要
 * 一次模型调用才交得出答案，把命令排到总闸那一刻等于保证交不出来。
 */
export function clamp(
  want: number | undefined,
  marginMs: number,
  now: number = Date.now(),
): Clamped {
  const remaining = remainingMs(now);
  if (remaining === undefined) return want === undefined ? { ms: undefined } : { ms: want };

  const room = Math.max(0, remaining - marginMs);
  if (want === undefined) return { ms: room };
  return want > room ? { ms: room, asked: want } : { ms: want };
}
