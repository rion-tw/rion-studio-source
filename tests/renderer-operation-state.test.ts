import { describe, expect, it, vi } from "vitest";

import { BusyIdTracker, LatestRequestGate } from "../src/renderer/src/app/operationState";

describe("renderer operation state", () => {
  it("keeps independent operations busy until each one finishes", () => {
    const snapshots: string[][] = [];
    const tracker = new BusyIdTracker((ids) => snapshots.push([...ids]));

    const finishFirst = tracker.begin("first");
    const finishSecond = tracker.begin("second");

    expect(tracker.begin("first")).toBeUndefined();
    finishFirst?.();
    expect(snapshots).toEqual([["first"], ["first", "second"], ["second"]]);

    finishFirst?.();
    finishSecond?.();
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("accepts only the latest request after a newer request or direct update", () => {
    const gate = new LatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });

  it("notifies once when an operation completion callback is repeated", () => {
    const onChange = vi.fn();
    const tracker = new BusyIdTracker(onChange);
    const finish = tracker.begin("role-1");

    finish?.();
    finish?.();

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
