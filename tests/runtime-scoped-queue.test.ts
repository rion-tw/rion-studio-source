import { expect, it } from "vitest";
import { RuntimeScopedQueue } from "../src/electron/main/runtimeScopedQueue";

it("orders intersecting windows while an unrelated launch completes before release", async () => {
  const queue = new RuntimeScopedQueue(4);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = queue.run(["b"], async () => { order.push("b"); await held; });
  const move = queue.run(["b", "c"], async () => { order.push("move"); });
  const same = queue.run(["c"], async () => { order.push("c"); });
  await queue.run(["a"], async () => { order.push("a"); });
  expect(order).toEqual(["b", "a"]);
  release();
  await Promise.all([first, move, same]);
  expect(order).toEqual(["b", "a", "move", "c"]);
});
