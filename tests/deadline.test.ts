import { afterEach, describe, expect, test } from "bun:test";

import {
  clamp,
  DeadlineExceeded,
  remainingMs,
  runBudgetMs,
  setProcessDeadline,
  WRAP_UP_ROOM_MS,
} from "../src/deadline";

// 单例，和 `setCommandCeiling` 同源（`src/deadline.ts` 头部讲了为什么）。留着不清会
// 泄进别的测试文件——本文件里每一格都自己设，所以只在收尾处清一次。
afterEach(() => {
  setProcessDeadline(undefined);
});

describe("没有总闸的时候，什么都不夹", () => {
  test("剩余是 undefined，不是 Infinity", () => {
    expect(remainingMs()).toBeUndefined();
  });

  // 交互式走的就是这一格：人就是那把钟，所以一条命令要多久就是多久。
  test("要多少给多少，要 undefined 就是不设期限", () => {
    expect(clamp(3_600_000, 2_000)).toEqual({ ms: 3_600_000 });
    expect(clamp(undefined, 2_000)).toEqual({ ms: undefined });
  });
});

describe("有总闸的时候，inner = min(想要的, 剩余 − 余量)", () => {
  const now = 1_000_000;

  test("想要的比剩余小，原样通过且不留痕", () => {
    setProcessDeadline(now + 60_000);
    expect(clamp(5_000, 2_000, now)).toEqual({ ms: 5_000 });
  });

  // 夹了要说：`asked` 就是那句话的原料，没夹的时候它不在。
  test("想要的比剩余大，夹到剩余减余量，并把原来要的带出来", () => {
    setProcessDeadline(now + 60_000);
    expect(clamp(3_600_000, 2_000, now)).toEqual({ ms: 58_000, asked: 3_600_000 });
  });

  test("这一层没有自己的期限时，剩余减余量就是它的期限", () => {
    setProcessDeadline(now + 60_000);
    expect(clamp(undefined, 2_000, now)).toEqual({ ms: 58_000 });
  });

  test("余量比剩余还大就是 0 余地，不是负数", () => {
    setProcessDeadline(now + 1_000);
    expect(clamp(5_000, 2_000, now)).toEqual({ ms: 0, asked: 5_000 });
  });

  test("已经过期，剩余是 0", () => {
    setProcessDeadline(now - 5_000);
    expect(remainingMs(now)).toBe(0);
  });
});

describe("超期是失败的一种，而且报得出是哪只钟", () => {
  test("消息里有钟的名字和实际过了多久", () => {
    const error = new DeadlineExceeded(42_400, "run");
    expect(error.message).toContain("run deadline");
    expect(error.message).toContain("42s");
    expect(error.name).toBe("DeadlineExceeded");
  });

  // 它要穿过 langgraph 的图和 undici 的 abort 才回到我们手上，中途可能被换壳，
  // 所以判据是自有标记字段而不是 `instanceof`。
  test("认标记字段，不认原型链", () => {
    expect(DeadlineExceeded.isInstance(new DeadlineExceeded(1, "run"))).toBe(true);
    expect(DeadlineExceeded.isInstance({ isDeadlineExceeded: true })).toBe(true);
    expect(DeadlineExceeded.isInstance(new Error("nope"))).toBe(false);
    expect(DeadlineExceeded.isInstance(undefined)).toBe(false);
  });
});

/**
 * 默认路径上那两项互相抵消 —— 这是 `WRAP_UP_ROOM_MS` 出现在两侧的全部理由。
 *
 * `--print` 没给 `--timeout` 时，总闸取「回合墙钟 + 收尾余地」；而回合预算又被
 * 「总闸剩余 − 收尾余地」夹取。**结果正好还是配置的那个回合墙钟**，默认路径上没有
 * 第二个常数被引入。这一格就是钉住这句话。
 */
test("总闸 = 墙钟 + 余地，夹回来还是墙钟", () => {
  const now = 1_000_000;
  const wall = 600_000;
  setProcessDeadline(now + wall + WRAP_UP_ROOM_MS);
  expect(clamp(wall, WRAP_UP_ROOM_MS, now)).toEqual({ ms: wall });
});

/**
 * 票 09：**模型被告知的数，必须就是真正会响的那个钟。**
 *
 * `main.ts` 两处用它：设总闸的那一行，和往环境块里写「这次调用有多少秒」的那一行。
 * 这一格钉的是「同一个函数」这件事本身——两处各算一遍的话，模型会按一个数做计划，
 * 另一个数把它掐断，而且不会有任何测试变红。
 */
describe("这次调用的总时长", () => {
  test("给了 --timeout 就用它，一秒不改", () => {
    expect(runBudgetMs(340, 600_000)).toBe(340_000);
  });

  test("没给就退到「回合墙钟 + 收尾余地」", () => {
    expect(runBudgetMs(undefined, 600_000)).toBe(600_000 + WRAP_UP_ROOM_MS);
  });

  // 默认路径上这两项抵消，回合预算还是配置的那个值——上面那一格已经钉了 clamp 这一半，
  // 这里钉的是它的另一半：总闸确实是「墙钟 + 余地」。
  test("默认路径的总闸，正好能让回合预算夹回配置值", () => {
    const wall = 600_000;
    const now = 1_000_000;
    setProcessDeadline(now + runBudgetMs(undefined, wall));
    expect(clamp(wall, WRAP_UP_ROOM_MS, now)).toEqual({ ms: wall });
  });
});
