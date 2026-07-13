import { describe, expect, it } from "vitest";

import { moveItemById } from "../src/renderer/src/app/reorderItems";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("moveItemById", () => {
  it("moves an item forward to the target position", () => {
    expect(moveItemById(items, "a", "c").map((item) => item.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward to the target position", () => {
    expect(moveItemById(items, "d", "b").map((item) => item.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("returns the original array for the same position or unknown ids", () => {
    expect(moveItemById(items, "b", "b")).toBe(items);
    expect(moveItemById(items, "missing", "b")).toBe(items);
    expect(moveItemById(items, "b", "missing")).toBe(items);
  });
});
