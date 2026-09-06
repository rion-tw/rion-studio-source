import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function harness() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const events = new Map<string, (event: unknown) => void>();
  const receipts: Record<string, unknown>[] = [];
  class KeyboardEvent {
    constructor(readonly type: string, readonly code: string, readonly isTrusted = true) {}
  }
  runInNewContext(readFileSync("scripts/electronWindowsChromiumTrustedInputProbePreload.cjs", "utf8"), {
    require: () => ({ ipcRenderer: {
      on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
      send: (_channel: string, receipt: Record<string, unknown>) => receipts.push(receipt)
    } }),
    process: { argv: ["--rion-windows-input-probe-channel=fixture",
      "--rion-windows-input-probe-role=role", "--rion-windows-input-probe-generation=1",
      "--rion-windows-input-probe-frame-token=document"] },
    location: { href: "data:text/html,fixture" }, KeyboardEvent, MouseEvent: class {},
    addEventListener: (type: string, listener: (event: unknown) => void) => events.set(type, listener)
  });
  return {
    receipts,
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
