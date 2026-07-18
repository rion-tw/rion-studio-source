import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMBEDDED_HEARTBEAT_INTERVAL_MS,
  EMBEDDED_HEARTBEAT_STALL_MS,
  EmbeddedRuntimeDiagnostics
} from "../src/main/browser/EmbeddedRuntimeDiagnostics";
import { isEmbeddedRuntimeDiagnosticPayload } from "../src/shared/embeddedRuntimeDiagnostics";

describe("EmbeddedRuntimeDiagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates bounded lifecycle, heartbeat, and WebGL payloads", () => {
    expect(isEmbeddedRuntimeDiagnosticPayload(payload("heartbeat"))).toBe(true);
    expect(isEmbeddedRuntimeDiagnosticPayload({
      ...payload("lifecycle"),
      event: "install",
      webglRenderer: "ANGLE renderer",
      webglVendor: "GPU vendor"
    })).toBe(true);
    expect(isEmbeddedRuntimeDiagnosticPayload({
      ...payload("webgl"),
      event: "context_lost"
    })).toBe(true);
    expect(isEmbeddedRuntimeDiagnosticPayload({
      ...payload("lifecycle"),
      event: "install",
      webglRenderer: "x".repeat(513)
    })).toBe(false);
    expect(isEmbeddedRuntimeDiagnosticPayload({ ...payload("heartbeat"), hidden: "yes" })).toBe(false);
    expect(isEmbeddedRuntimeDiagnosticPayload({
      ...payload("heartbeat"),
      unexpected: "x".repeat(10_000)
    })).toBe(false);
    expect(isEmbeddedRuntimeDiagnosticPayload({ ...payload("lifecycle"), event: "unknown" })).toBe(false);
  });

  it("logs lifecycle, invalid payloads, and renderer responsiveness with role context", () => {
    const log = createLogger();
    const diagnostics = new EmbeddedRuntimeDiagnostics(log);
    const contents = createContents(101, 4001);
    diagnostics.attach({ hostId: "host-1", kind: "game", roleId: "role-1", workspaceId: "workspace-1" }, contents as never);

    diagnostics.handlePageEvent(contents as never, {
      ...payload("lifecycle"),
      event: "visibilitychange"
    });
    diagnostics.handlePageEvent(contents as never, { type: "heartbeat" });
    contents.emit("unresponsive");
    contents.emit("responsive");

    expect(log.info).toHaveBeenCalledWith(
      "browser",
      "embedded_page_lifecycle",
      expect.any(String),
      expect.objectContaining({
        roleId: "role-1",
        workspaceId: "workspace-1",
        webContentsId: 101,
        osProcessId: 4001,
        backgroundThrottling: true,
        pageEvent: "visibilitychange"
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "browser",
      "embedded_diagnostic_payload_rejected",
      expect.any(String),
      expect.objectContaining({ roleId: "role-1" })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "browser",
      "embedded_renderer_unresponsive",
      expect.any(String),
      expect.objectContaining({ roleId: "role-1" })
    );
    expect(log.info).toHaveBeenCalledWith(
      "browser",
      "embedded_renderer_responsive",
      expect.any(String),
      expect.objectContaining({ roleId: "role-1" })
    );
    diagnostics.stop();
  });

  it("reports one heartbeat stall, reports recovery, and ignores system sleep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    const log = createLogger();
    const diagnostics = new EmbeddedRuntimeDiagnostics(log);
    const contents = createContents(102, 4002);
    diagnostics.attach({ hostId: "host-2", kind: "game", roleId: "role-2" }, contents as never);

    await vi.advanceTimersByTimeAsync(EMBEDDED_HEARTBEAT_STALL_MS + EMBEDDED_HEARTBEAT_INTERVAL_MS);
    expect(log.warn.mock.calls.filter((call) => call[1] === "embedded_renderer_heartbeat_stalled")).toHaveLength(1);

    diagnostics.handlePageEvent(contents as never, payload("heartbeat"));
    expect(log.info).toHaveBeenCalledWith(
      "browser",
      "embedded_renderer_heartbeat_recovered",
      expect.any(String),
      expect.objectContaining({ roleId: "role-2" })
    );

    diagnostics.handleSuspend();
    await vi.advanceTimersByTimeAsync(EMBEDDED_HEARTBEAT_STALL_MS * 2);
    diagnostics.handleResume();
    expect(log.warn.mock.calls.filter((call) => call[1] === "embedded_renderer_heartbeat_stalled")).toHaveLength(1);
    diagnostics.stop();
  });

  it("maps every role sharing the failed renderer process", () => {
    const log = createLogger();
    const diagnostics = new EmbeddedRuntimeDiagnostics(log);
    const first = createContents(103, 5001);
    const second = createContents(104, 5001);
    diagnostics.attach({ hostId: "host-3", kind: "game", roleId: "role-3" }, first as never);
    diagnostics.attach({ hostId: "host-4", kind: "popup", roleId: "role-4" }, second as never);

    expect(diagnostics.getRenderProcessGoneContext(first as never)).toEqual(expect.objectContaining({
      roleId: "role-3",
      affectedRoleIds: ["role-3", "role-4"],
      osProcessId: 5001
    }));
    diagnostics.stop();
  });
});

function payload(type: "heartbeat" | "lifecycle" | "webgl") {
  return {
    type,
    sequence: 1,
    monotonicMs: 100,
    hasFocus: false,
    hidden: true,
    visibilityState: "hidden",
    wasDiscarded: false
  };
}

function createLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  };
}

function createContents(id: number, processId: number) {
  const contents = new EventEmitter() as EventEmitter & {
    id: number;
    getBackgroundThrottling: () => boolean;
    getOSProcessId: () => number;
    isDestroyed: () => boolean;
  };
  Object.assign(contents, {
    id,
    getBackgroundThrottling: () => true,
    getOSProcessId: () => processId,
    isDestroyed: () => false
  });
  return contents;
}
