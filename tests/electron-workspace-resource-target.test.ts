import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ElectronWorkspaceResourceTarget } from "../src/main/browser/ElectronWorkspaceResourceTarget";

describe("ElectronWorkspaceResourceTarget", () => {
  it("attaches the debugger and throttles only the main frame and iframe targets", async () => {
    const harness = createHarness();
    const target = new ElectronWorkspaceResourceTarget("role-1", harness.webContents);
    target.onInvalidated(vi.fn());

    await target.setCpuThrottleRate(2);
    expect(harness.attach).toHaveBeenCalledWith("1.3");
    expect(harness.sendCommand).toHaveBeenCalledWith("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false
    });
    expect(harness.sendCommand).toHaveBeenCalledWith("Emulation.setCPUThrottlingRate", { rate: 2 });

    harness.debuggerEmitter.emit(
      "message",
      {},
      "Target.attachedToTarget",
      { sessionId: "iframe-session", targetInfo: { type: "iframe" } }
    );
    harness.debuggerEmitter.emit(
      "message",
      {},
      "Target.attachedToTarget",
      { sessionId: "worker-session", targetInfo: { type: "shared_worker" } }
    );
    await target.setCpuThrottleRate(4);

    expect(harness.sendCommand).toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      { rate: 4 },
      "iframe-session"
    );
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything(),
      "worker-session"
    );

    await target.releaseThrottle();
    expect(harness.sendCommand).toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      { rate: 1 },
      "iframe-session"
    );
    expect(harness.detach).toHaveBeenCalledOnce();
  });

  it("reports the renderer PID, focuses on request, and fails safely while DevTools is open", async () => {
    const harness = createHarness();
    const target = new ElectronWorkspaceResourceTarget("role-1", harness.webContents);

    expect(target.getProcessId()).toBe(321);
    await target.focus();
    expect(harness.focus).toHaveBeenCalledOnce();

    harness.setDevToolsOpen(true);
    await expect(target.setCpuThrottleRate(2)).rejects.toThrow("DevTools is open");
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("invalidates on reload and debugger detach so the coordinator can reapply", async () => {
    const harness = createHarness();
    const target = new ElectronWorkspaceResourceTarget("role-1", harness.webContents);
    const invalidated = vi.fn();
    target.onInvalidated(invalidated);
    await target.setCpuThrottleRate(2);

    harness.webContentsEmitter.emit("did-finish-load");
    harness.detach();

    expect(invalidated).toHaveBeenCalledTimes(2);
    await target.setCpuThrottleRate(2);
    expect(harness.attach).toHaveBeenCalledTimes(2);
  });
});

function createHarness() {
  const webContentsEmitter = new EventEmitter();
  const debuggerEmitter = new EventEmitter();
  let attached = false;
  let devToolsOpen = false;
  const attach = vi.fn(() => {
    attached = true;
  });
  const detach = vi.fn(() => {
    attached = false;
    debuggerEmitter.emit("detach", {}, "target closed");
  });
  const sendCommand = vi.fn(async () => ({}));
  const focus = vi.fn();
  const debuggerApi = Object.assign(debuggerEmitter, {
    attach,
    detach,
    isAttached: () => attached,
    sendCommand
  });
  const webContents = Object.assign(webContentsEmitter, {
    debugger: debuggerApi,
    focus,
    getOSProcessId: () => 321,
    isDestroyed: () => false,
    isDevToolsOpened: () => devToolsOpen
  }) as unknown as WebContents;
  return {
    attach,
    debuggerEmitter,
    detach,
    focus,
    sendCommand,
    setDevToolsOpen: (value: boolean) => {
      devToolsOpen = value;
    },
    webContents,
    webContentsEmitter
  };
}
