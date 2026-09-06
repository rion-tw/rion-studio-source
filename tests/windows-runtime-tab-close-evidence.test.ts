import { describe, expect, it, vi } from "vitest";
import {
  closeWindowsRuntimeTabFromEvidence,
  readWindowsRuntimeTabCloseEvidence,
  readWindowsRuntimeTabLoadingEvidence
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


describe("Windows gated tab loading observation", () => {
  const input = { processId: 512, tabName: "Workspace" };
  const receipt = {
    nativeHandle: "123456", controlName: "Stop and close Workspace", loadingName: "Workspace loading"
  };

  it("binds the visible loading control to its exact process and native host", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify(receipt));
    const evidence = await readWindowsRuntimeTabLoadingEvidence(input, { platform: "win32", run });
    expect(evidence).toEqual({ ...input, nativeHandle: receipt.nativeHandle, controlName: receipt.controlName });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.any(String), {
      ...input, controlName: receipt.controlName, loadingName: receipt.loadingName
    }, { timeoutMilliseconds: 30_000 });
  });

  it.each([
    { ...receipt, nativeHandle: "0" },
    { ...receipt, nativeHandle: 123456 },
    { ...receipt, controlName: "Stop and close Another" },
    { ...receipt, loadingName: "Another loading" }
  ])("rejects mismatched loading evidence: %j", async receipt => {
    const run = vi.fn().mockResolvedValue(JSON.stringify(receipt));
    await expect(readWindowsRuntimeTabLoadingEvidence(input, { platform: "win32", run }))
      .rejects.toThrow("malformed tab loading evidence");
  });

  it.each(["darwin", "linux"] as const)("rejects %s before native observation", async platform => {
    const run = vi.fn();
    await expect(readWindowsRuntimeTabLoadingEvidence(input, { platform, run })).rejects.toThrow("exact Windows");
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates missing visible loading state without retry", async () => {
    const run = vi.fn().mockRejectedValue(new Error("The exact visible loading tab control is not unique"));
    await expect(readWindowsRuntimeTabLoadingEvidence(input, { platform: "win32", run }))
      .rejects.toThrow("not unique");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
