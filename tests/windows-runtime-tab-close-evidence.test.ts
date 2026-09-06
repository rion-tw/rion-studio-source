import { describe, expect, it, vi } from "vitest";
import {
  closeWindowsRuntimeTabFromEvidence,
  readWindowsRuntimeTabCloseEvidence
} from "../e2e/desktop/support/windows-runtime-tab-close";

const identity = { processId: 512, tabId: "tab-1", windowId: "window-1", controlName: "Stop and close Workspace" };

describe("Windows pending-navigation native tab close", () => {
  it("binds the observed exact control and sends its native handle on close", async () => {
    const run = vi.fn().mockResolvedValueOnce(JSON.stringify({
      nativeHandle: "123456", controlName: identity.controlName
    })).mockResolvedValueOnce("");
    const port = { platform: "win32" as const, run };
    const evidence = await readWindowsRuntimeTabCloseEvidence(identity, port);
    expect(evidence).toEqual({ ...identity, nativeHandle: "123456" });
    expect(Object.isFrozen(evidence)).toBe(true);
    await closeWindowsRuntimeTabFromEvidence(evidence, port);
    expect(run).toHaveBeenLastCalledWith(expect.any(String), evidence, { timeoutMilliseconds: 30_000 });
  });

  it.each([
    { nativeHandle: "0", controlName: identity.controlName },
    { nativeHandle: "123", controlName: "Stop and close Another Workspace" },
    { nativeHandle: 123, controlName: identity.controlName }
  ])("rejects malformed or mismatched native evidence: %j", async result => {
    const run = vi.fn().mockResolvedValue(JSON.stringify(result));
    await expect(readWindowsRuntimeTabCloseEvidence(identity, { platform: "win32", run }))
      .rejects.toThrow("malformed tab close evidence");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["darwin", "linux"] as const)("rejects the %s host before native work", async platform => {
    const run = vi.fn();
    await expect(readWindowsRuntimeTabCloseEvidence(identity, { platform, run })).rejects.toThrow("exact Windows");
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates retired-window failure without retry or fallback", async () => {
    const run = vi.fn().mockRejectedValue(new Error("The exact parent native window retired"));
    await expect(closeWindowsRuntimeTabFromEvidence({ ...identity, nativeHandle: "123456" },
      { platform: "win32", run })).rejects.toThrow("retired");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
