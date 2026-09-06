import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function harness() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const events = new Map<string, (event: unknown) => void>();
  const receipts: Record<string, unknown>[] = [];
  class KeyboardEvent {
    ctrlKey = false; shiftKey = false; altKey = false; metaKey = false;
    constructor(readonly type: string, readonly code: string, readonly isTrusted = true) {}
  }
  class MouseEvent {
    constructor(readonly type: string, readonly button: number, readonly clientX: number,
      readonly clientY: number, readonly isTrusted = true) {}
  }
  runInNewContext(readFileSync("scripts/electronWindowsChromiumTrustedInputProbePreload.cjs", "utf8"), {
    require: () => ({ ipcRenderer: {
      on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
      send: (_channel: string, receipt: Record<string, unknown>) => receipts.push(receipt)
    } }),
    process: { argv: ["--rion-windows-input-probe-channel=fixture",
      "--rion-windows-input-probe-role=role", "--rion-windows-input-probe-generation=1",
      "--rion-windows-input-probe-frame-token=document"] },
    location: { href: "data:text/html,fixture" }, KeyboardEvent, MouseEvent,
    addEventListener: (type: string, listener: (event: unknown) => void) => events.set(type, listener)
  });
  return {
    receipts,
    armEvents: (inputSequence: string, expectedEvents: unknown[]) => listeners.get("fixture:arm")!({}, { inputSequence, expectedEvents }),
    mouse: (type: string, button: number, x: number, y: number) => events.get(type)!(new MouseEvent(type, button, x, y)),
    modifiedKey: (type: string, code: string, modifiers: Partial<KeyboardEvent>) =>
      events.get(type)!(Object.assign(new KeyboardEvent(type, code), modifiers)),
    arm: (inputSequence: string, code: string) => listeners.get("fixture:arm")!({}, {
      inputSequence, expectedEvents: [{ type: "keydown", code }, { type: "keyup", code }]
    }),
    cancel: (inputSequence: string) => listeners.get("fixture:cancel")!({}, { inputSequence }),
    key: (type: string, code: string) => events.get(type)!(new KeyboardEvent(type, code))
  };
}

describe("Windows input probe sequence cancellation", () => {
  it("requires exact cancellation before admitting another input sequence", () => {
    const probe = harness();
    probe.arm("native", "KeyA");
    probe.cancel("unrelated");
    expect(probe.receipts.at(-1)?.kind).toBe("cancel-rejected");
    probe.arm("comparison", "KeyB");
    expect(probe.receipts.at(-1)?.kind).toBe("arm-rejected");
    probe.cancel("native");
    expect(probe.receipts.at(-1)).toMatchObject({ kind: "cancelled", inputSequence: "native" });
    probe.arm("comparison", "KeyB");
    probe.key("keydown", "KeyB");
    probe.key("keyup", "KeyB");
    expect(probe.receipts.filter(receipt => receipt.kind === "input")).toMatchObject([
      { inputSequence: "comparison", matches: true, observedIndex: 0 },
      { inputSequence: "comparison", matches: true, observedIndex: 1 }
    ]);
  });

  it("rejects a trusted key with the wrong modifiers", () => {
    const probe = harness();
    probe.armEvents("modified", [{ type: "keydown", code: "KeyB", ctrlKey: true, shiftKey: true }]);
    probe.modifiedKey("keydown", "KeyB", { ctrlKey: true });
    expect(probe.receipts.at(-1)).toMatchObject({ matches: false, isTrusted: true });
    probe.armEvents("exact", [{ type: "keydown", code: "KeyB", ctrlKey: true, shiftKey: true }]);
    probe.modifiedKey("keydown", "KeyB", { ctrlKey: true, shiftKey: true });
    expect(probe.receipts.at(-1)).toMatchObject({ matches: true, inputSequence: "exact" });
  });

  it("checks exact middle-button CSS coordinates including auxclick", () => {
    const probe = harness();
    const expected = ["mousedown", "mouseup", "auxclick"].map(type => ({ type, button: 1, clientX: 80, clientY: 96 }));
    probe.armEvents("middle", expected);
    for (const event of expected) probe.mouse(event.type, 1, 80, 96);
    expect(probe.receipts.filter(receipt => receipt.kind === "input")).toHaveLength(3);
    expect(probe.receipts.at(-1)).toMatchObject({ matches: true, type: "auxclick", observedIndex: 2 });
    probe.armEvents("wrong-coordinate", expected);
    probe.mouse("mousedown", 1, 100, 120);
    expect(probe.receipts.at(-1)).toMatchObject({ matches: false });
  });

  it("does not accept a delayed native key as comparison success", () => {
    const probe = harness();
    probe.arm("native", "KeyA");
    probe.cancel("native");
    probe.arm("comparison", "KeyB");
    probe.key("keydown", "KeyA");
    expect(probe.receipts.at(-1)).toMatchObject({ inputSequence: "comparison", matches: false });
    const count = probe.receipts.length;
    probe.key("keyup", "KeyB");
    expect(probe.receipts).toHaveLength(count);
  });
});
