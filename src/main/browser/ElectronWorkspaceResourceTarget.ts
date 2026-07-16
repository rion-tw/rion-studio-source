import type { WebContents } from "electron";

import type { WorkspaceCpuThrottleRate } from "../../shared/types";
import type { WorkspaceResourceTarget } from "./WorkspaceResourceCoordinator";

export class ElectronWorkspaceResourceTarget implements WorkspaceResourceTarget {
  readonly runtimeMode = "embedded" as const;
  private currentRate: 1 | WorkspaceCpuThrottleRate | undefined;
  private desiredRate: 1 | WorkspaceCpuThrottleRate = 1;
  private readonly iframeSessionIds = new Set<string>();
  private ownsDebugger = false;
  private suppressDetachInvalidation = false;
  private autoAttachConfigured = false;

  constructor(
    readonly roleId: string,
    private readonly webContents: WebContents
  ) {}

  getProcessId(): number | undefined {
    if (this.webContents.isDestroyed()) {
      return undefined;
    }
    const processId = this.webContents.getOSProcessId();
    return processId > 0 ? processId : undefined;
  }

  async focus(): Promise<void> {
    if (!this.webContents.isDestroyed()) {
      this.webContents.focus();
    }
  }

  onInvalidated(listener: () => void): () => void {
    const invalidate = (): void => {
      this.currentRate = undefined;
      listener();
    };
    const handleDetach = (): void => {
      this.ownsDebugger = false;
      this.currentRate = undefined;
      this.desiredRate = 1;
      this.autoAttachConfigured = false;
      this.iframeSessionIds.clear();
      if (!this.suppressDetachInvalidation) {
        listener();
      }
    };
    const handleMessage = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>,
      _sessionId?: string
    ): void => {
      if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
        this.iframeSessionIds.delete(params.sessionId);
        return;
      }
      if (method !== "Target.attachedToTarget" || typeof params.sessionId !== "string") {
        return;
      }
      const targetInfo = typeof params.targetInfo === "object" && params.targetInfo !== null
        ? params.targetInfo as Record<string, unknown>
        : undefined;
      if (targetInfo?.type !== "iframe") {
        return;
      }
      const sessionId = params.sessionId;
      this.iframeSessionIds.add(sessionId);
      void this.webContents.debugger.sendCommand(
        "Emulation.setCPUThrottlingRate",
        { rate: this.desiredRate },
        sessionId
      ).catch(() => this.iframeSessionIds.delete(sessionId));
    };
    this.webContents.on("devtools-opened", invalidate);
    this.webContents.on("devtools-closed", invalidate);
    this.webContents.on("destroyed", invalidate);
    this.webContents.on("did-finish-load", invalidate);
    this.webContents.on("render-process-gone", invalidate);
    this.webContents.debugger.on("detach", handleDetach);
    this.webContents.debugger.on("message", handleMessage);
    return () => {
      this.webContents.removeListener("devtools-opened", invalidate);
      this.webContents.removeListener("devtools-closed", invalidate);
      this.webContents.removeListener("destroyed", invalidate);
      this.webContents.removeListener("did-finish-load", invalidate);
      this.webContents.removeListener("render-process-gone", invalidate);
      this.webContents.debugger.removeListener("detach", handleDetach);
      this.webContents.debugger.removeListener("message", handleMessage);
    };
  }

  async setCpuThrottleRate(rate: 1 | WorkspaceCpuThrottleRate): Promise<void> {
    if (this.webContents.isDestroyed()) {
      throw new Error("Embedded browser view is closed.");
    }
    if (this.webContents.isDevToolsOpened()) {
      throw new Error("CPU throttling pauses while DevTools is open.");
    }
    if (this.currentRate === rate && this.ownsDebugger && this.webContents.debugger.isAttached()) {
      return;
    }
    if (!this.ownsDebugger) {
      if (this.webContents.debugger.isAttached()) {
        throw new Error("Another debugger is already attached to the embedded browser view.");
      }
      this.webContents.debugger.attach("1.3");
      this.ownsDebugger = true;
    }
    if (!this.autoAttachConfigured) {
      await this.webContents.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false
      });
      this.autoAttachConfigured = true;
    }

    this.desiredRate = rate;
    try {
      await Promise.all([
        this.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate }),
        ...[...this.iframeSessionIds].map((sessionId) =>
          this.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate }, sessionId)
        )
      ]);
      this.currentRate = rate;
    } catch (error) {
      this.desiredRate = this.currentRate ?? 1;
      throw error;
    }
  }

  async releaseThrottle(): Promise<void> {
    if (!this.ownsDebugger || !this.webContents.debugger.isAttached()) {
      this.ownsDebugger = false;
      this.currentRate = undefined;
      return;
    }

    try {
      if (this.currentRate !== 1) {
        this.desiredRate = 1;
        await Promise.all([
          this.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate: 1 }),
          ...[...this.iframeSessionIds].map((sessionId) =>
            this.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate: 1 }, sessionId)
          )
        ]);
      }
    } finally {
      this.suppressDetachInvalidation = true;
      try {
        this.webContents.debugger.detach();
      } finally {
        this.suppressDetachInvalidation = false;
        this.ownsDebugger = false;
        this.currentRate = undefined;
        this.desiredRate = 1;
        this.autoAttachConfigured = false;
        this.iframeSessionIds.clear();
      }
    }
  }
}
