import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { receipt } = vi.hoisted(() => ({ receipt: vi.fn() }));
vi.mock("../e2e/desktop/support/compiled-macos-native-focus", () => ({
  boundedNativeProcessFailure: vi.fn(), runMacosNativeFocus: vi.fn(), withMacosNativeFocusReceipt: receipt
}));
vi.mock("../e2e/desktop/support/electron-driver", () => ({ electronDesktopE2eProbe: vi.fn() }));
vi.mock("../e2e/desktop/support/native-process-attribution", () => ({ captureNativeProcessAttribution: vi.fn() }));
vi.mock("../e2e/desktop/support/windows-launcher-foreground", () => ({ focusWindowsLauncherForVisibleLaunch: vi.fn() }));
vi.mock("../e2e/desktop/support/windows-runtime-window-control", () => ({ pressWindowsRuntimeWindowControl: vi.fn() }));
vi.mock("../e2e/desktop/support/windows-runtime-foreground", () => ({ focusWindowsRuntimeNativeWindow: vi.fn() }));

import { withVisibleMacosRoleKeyReceipt, type VisibleMacosRoleReceiptKey } from
  "../e2e/desktop/support/native-application-actions";

const target = { processId: 123, runtimeTabName: "Exact Role", runtimeWindowId: "exact-window" };
const allowed: VisibleMacosRoleReceiptKey[] = ["Digit2", "Digit3", ...Array.from({ length: 12 }, (_, index) =>
  [`F${index + 1}`, `Ctrl+F${index + 1}`] as VisibleMacosRoleReceiptKey[]).flat()];
const forbidden = ["Digit1", "Digit4", "Ctrl+Digit2", "Shift+Digit3", "F0", "F13", "Alt+F1", "toggleFullscreen"];

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  receipt.mockReset().mockImplementation(async (_args, receive: () => Promise<unknown>) => receive());
});
afterEach(() => vi.unstubAllGlobals());

describe("exact macOS Role key receipt admission", () => {
  it.each(allowed)("retains the original exact target and receiver for %s", async code => {
    const receive = vi.fn(async () => ({ exact: code }));
    await expect(withVisibleMacosRoleKeyReceipt({ ...target, code }, receive)).resolves.toEqual({ exact: code });
    expect(receipt).toHaveBeenCalledExactlyOnceWith([
      "123", "com.rionstudio.runtime.appkit-window.v1:exact-window", "Exact Role", "roleKey", code
    ], receive, undefined);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it.each(forbidden)("rejects unsupported receipt command %s before native submission", async code => {
    const receive = vi.fn();
    await expect(withVisibleMacosRoleKeyReceipt({ ...target, code: code as VisibleMacosRoleReceiptKey }, receive))
      .rejects.toThrow("requires one exact AppKit owner");
    expect(receipt).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });

  it.each([{ processId: 0 }, { runtimeTabName: "" }, { runtimeTabName: " Exact Role" },
    { runtimeWindowId: "" }, { runtimeWindowId: "exact-window " }])("rejects a stale target %j", async changed => {
    await expect(withVisibleMacosRoleKeyReceipt({ ...target, ...changed, code: "Digit3" }, vi.fn()))
      .rejects.toThrow("requires one exact AppKit owner");
    expect(receipt).not.toHaveBeenCalled();
  });

  it("does not submit this receipt transport on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await expect(withVisibleMacosRoleKeyReceipt({ ...target, code: "Digit2" }, vi.fn()))
      .rejects.toThrow("requires one exact AppKit owner");
    expect(receipt).not.toHaveBeenCalled();
  });

  it("keeps the native Swift receipt admission identical to the narrow TypeScript cohort", async () => {
    const swift = await readFile("e2e/desktop/support/macos-native-focus.swift", "utf8");
    const encodedPattern = swift.match(/command\.range\(of: ("[^\n]+"), options: \.regularExpression\)/u)?.[1];
    expect(encodedPattern).toBeDefined();
    const nativePattern = new RegExp(JSON.parse(encodedPattern!), "u");
    for (const code of allowed) expect(nativePattern.test(code), code).toBe(true);
    for (const code of forbidden) expect(nativePattern.test(code), code).toBe(false);
  });
});
