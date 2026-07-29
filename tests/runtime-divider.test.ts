// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function pointerEvent(type: string, screenX: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: 7 },
    screenX: { value: screenX },
    screenY: { value: 0 }
  });
  return event;
}

beforeAll(async () => {
  await import("../src/renderer/runtime-shell/runtimeDivider");
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("runtime workspace divider", () => {
  it("waits for start before sending the final move and end actions", async () => {
    let resolveStart!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveStart = resolve;
    }));

    dispatchEvent(pointerEvent("pointerdown", 100));
    dispatchEvent(pointerEvent("pointermove", 180));
    dispatchEvent(pointerEvent("pointerup", 220));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "rion_divider_pointer", {
      payload: { phase: "start", screenPosition: 100 }
    });

    resolveStart();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));

    expect(invoke).toHaveBeenNthCalledWith(2, "rion_divider_pointer", {
      payload: { phase: "move", screenPosition: 220 }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_divider_pointer", {
      payload: { phase: "end" }
    });
  });
});
