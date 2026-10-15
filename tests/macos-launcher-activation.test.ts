import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { activateMacosLauncherForVisibleControl } from "../e2e/desktop/support/macos-launcher-activation";

const processId = 4325;
const input = { platform: "macos" as const, processId };
const receipt = { processId, ownerProcessId: processId, foregroundProcessId: processId,
  role: "AXWindow", main: true, launcherCount: 1, retainedOwner: true };
function executor(value: unknown = receipt) {
  return vi.fn(async () => ({ stdout: JSON.stringify(value) }));
}

describe("retained macOS launcher activation for visible controls", () => {
  it("requires exact native owner, AXMain and foreground before returning a frozen receipt", async () => {
    const execute = executor();
    const result = await activateMacosLauncherForVisibleControl(input, { hostPlatform: "darwin", execute });
    expect(result).toEqual(receipt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith("/usr/bin/xcrun", ["swift",
      fileURLToPath(new URL("../e2e/desktop/support/macos-launcher-activation.swift", import.meta.url)),
      String(processId)], { encoding: "utf8", timeout: 10_000 });
  });

  it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid PID %s before any native action", async invalid => {
      const execute = executor();
      await expect(activateMacosLauncherForVisibleControl({ ...input, processId: invalid },
        { hostPlatform: "darwin", execute })).rejects.toThrow("exact positive app PID");
      expect(execute).not.toHaveBeenCalled();
    });

  it.each([
    { platform: "windows" as const, hostPlatform: "darwin" as const },
    { platform: "macos" as const, hostPlatform: "win32" as const }
  ])("refuses platform/host mismatch %j without crossing the native boundary", async scope => {
    const execute = executor();
    await expect(activateMacosLauncherForVisibleControl({ processId, platform: scope.platform },
      { hostPlatform: scope.hostPlatform, execute })).rejects.toThrow("explicit macOS platform and host");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { processId: 999 }, { ownerProcessId: 999 }, { foregroundProcessId: 999 },
    { role: "AXSheet" }, { main: false }, { launcherCount: 2 },
    { retainedOwner: false }, { unexpected: true }
  ])("rejects mismatched native proof %j without repeating activation", async changed => {
    const execute = executor({ ...receipt, ...changed });
    await expect(activateMacosLauncherForVisibleControl(input, { hostPlatform: "darwin", execute }))
      .rejects.toThrow("activation receipt is invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown native acknowledgement failure without fallback or action retry", async () => {
    const error = new Error("retained launcher AXRaise failed");
    const execute = vi.fn(async () => { throw error; });
    await expect(activateMacosLauncherForVisibleControl(input, { hostPlatform: "darwin", execute }))
      .rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "truncated native output"])("rejects malformed native output %j", async value => {
    const execute = executor(value);
    await expect(activateMacosLauncherForVisibleControl(input, { hostPlatform: "darwin", execute }))
      .rejects.toThrow("activation receipt is invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
