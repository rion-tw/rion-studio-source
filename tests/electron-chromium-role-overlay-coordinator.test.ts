import type {
  MacroCoordinateContextRecord,
  MacroOverlayViewModelRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import { RionBridgeError } from "../src/electron/ipc/errors";
import {
  CHROMIUM_ROLE_OVERLAY_CHANNEL,
  CHROMIUM_ROLE_OVERLAY_WORLD_ID
} from
  "../src/electron/ipc/chromiumRoleOverlayProtocol";
import {
  ChromiumRoleOverlayCoordinator,
  type ChromiumRoleOverlayIpcEventPort
} from "../src/electron/main/chromiumRoleOverlayCoordinator";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent,
  ChromiumRoleOverlayRefreshSubmissionReceipt
} from
  "../src/electron/main/chromiumRoleSurfaceRegistry";

const OVERLAY_STATE = Object.freeze({
  detached: false,
  macroBadgePosition: {},
  macroOverlay: {},
  macros: [],
  shortcutMacroIds: [],
  shortcutStatuses: [],
  resolvedTheme: "dark",
  statuses: []
}) as unknown as MacroOverlayViewModelRecord;

function codedError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function harness() {
  const sender = {};
  let current: ChromiumRoleOverlayFrameIdentity = Object.freeze({
    roleId: "role-1",
    generation: 1,
    frame: Object.freeze({ frameToken: "frame-token-1" }),
    frameToken: "frame-token-1",
    documentInstanceId: "document-1"
  });
  const framesByRole = new Map([[current.roleId, current]]);
  let lifecycleListener:
    | ((event: ChromiumRoleOverlayLifecycleEvent) => void)
    | null = null;
  let refreshSequence = 0;
  const overlayRequest = vi.fn(async () => OVERLAY_STATE);
  const coordinateContext = vi.fn(() => Object.freeze({
    appliedPageZoom: 1.25,
    surfaceGeneration: current.generation,
    topologyRevision: 7
  }) satisfies MacroCoordinateContextRecord);
  const activate = vi.fn();
  const executeOverlayRefresh = vi.fn(async (
    identity: ChromiumRoleOverlayFrameIdentity,
    refreshId: string
  ): Promise<ChromiumRoleOverlayRefreshSubmissionReceipt> => Object.freeze({
    roleId: identity.roleId,
    generation: identity.generation,
    frameToken: identity.frameToken,
    refreshId,
    status: "submitted",
    worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID
  }));
  const subject = new ChromiumRoleOverlayCoordinator({
    core: { overlayRequest },
    surfaces: {
      authorizeOverlayFrame: (candidate, frame, token) => {
        if (
          candidate !== sender ||
          frame !== current.frame ||
          token !== current.frameToken
        ) {
          throw codedError(
            "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED",
            "not the live main frame"
          );
        }
        return current;
      },
      isSupersededOverlayFrame: (candidate, frame, token) =>
        candidate === sender && frame !== current.frame && token !== current.frameToken,
      currentOverlayFrame: (roleId, generation) => {
        const identity = framesByRole.get(roleId);
        if (!identity || generation !== identity.generation) {
          throw codedError("ELECTRON_ROLE_SURFACE_NOT_FOUND", "not current");
        }
        return identity;
      },
      executeOverlayRefresh,
      listOverlayFrames: () => Object.freeze([...framesByRole.values()]),
      subscribeOverlayLifecycle: (listener) => {
        lifecycleListener = listener;
        return () => {
          if (lifecycleListener === listener) lifecycleListener = null;
        };
      }
    },
    runtime: { activate, coordinateContext },
    createRefreshId: () => {
      refreshSequence += 1;
      return `00000000-0000-4000-8000-${String(refreshSequence).padStart(12, "0")}`;
    }
  });
  const event = (): ChromiumRoleOverlayIpcEventPort => ({
    sender,
    senderFrame: current.frame
  });
  const envelope = (
    method: string,
    payload?: unknown
  ): Record<string, unknown> => {
    const enriched = method === "refreshReceipt" && payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).status === "applied"
      ? {
          inputContext: {
            documentInstanceId: current.frameToken,
            revision: 1,
            target: "game"
          },
          ...payload as Record<string, unknown>
        }
      : payload;
    return {
      frameToken: current.frameToken,
      method,
      ...(enriched === undefined ? {} : { payload: enriched })
    };
  };
  return {
    addFrame: (roleId: string, generation: number, frameToken: string) => {
      const identity = Object.freeze({
        roleId,
        generation,
        frame: Object.freeze({ frameToken }),
        frameToken,
        documentInstanceId: `document-${generation}`
      });
      framesByRole.set(roleId, identity);
      current = identity;
    },
    activate,
    coordinateContext,
    current: () => current,
    emitLifecycle: (event: ChromiumRoleOverlayLifecycleEvent) => {
      lifecycleListener?.(event);
    },
    envelope,
    event,
    executeOverlayRefresh,
    overlayRequest,
    replaceFrame: (frameToken: string) => {
      current = Object.freeze({
        ...current,
        frame: Object.freeze({ frameToken }),
        frameToken
      });
      framesByRole.set(current.roleId, current);
    },
    selectRole: (roleId: string) => {
      const identity = framesByRole.get(roleId);
      if (!identity) throw new Error(`missing test role ${roleId}`);
      current = identity;
    },
    subject
  };
}

describe("Chromium role overlay coordinator", () => {
  it("returns superseded for a game-context observation from the replaced main document", async () => {
    const state = harness();
    const oldEvent = state.event();
    const oldEnvelope = state.envelope("request", {
      type: "game-input-context",
      documentInstanceId: "frame-token-1",
      revision: 1,
      target: "game"
    });
    state.replaceFrame("frame-token-2");

    await expect(state.subject.receive(oldEvent, oldEnvelope)).resolves.toEqual({
      documentInstanceId: "frame-token-1",
      status: "superseded"
    });
    expect(state.overlayRequest).not.toHaveBeenCalled();
  });

  it("terminalizes any late overlay message from a superseded document without side effects", async () => {
    const state = harness();
    const oldEvent = state.event();
    const oldEnvelope = state.envelope("ready");
    state.replaceFrame("frame-token-2");

    await expect(state.subject.receive(oldEvent, oldEnvelope)).resolves.toEqual({
      status: "superseded"
    });
    expect(state.activate).not.toHaveBeenCalled();
    expect(state.overlayRequest).not.toHaveBeenCalled();
  });

  it("routes a bounded request only after exact main-frame authorization", async () => {
    const state = harness();

    await expect(state.subject.receive(
      state.event(),
      state.envelope("request", { type: "list" })
    )).resolves.toBe(OVERLAY_STATE);
    expect(state.overlayRequest).toHaveBeenCalledWith({
      roleId: "role-1",
      requestJson: JSON.stringify({ type: "list" })
    });

    await expect(state.subject.receive(
      { sender: {}, senderFrame: state.current().frame },
      state.envelope("request", { type: "list" })
    )).rejects.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED"
    });
  });

  it("rejects extra fields, missing payloads, and oversized envelopes", async () => {
    const state = harness();

    await expect(state.subject.receive(state.event(), {
      ...state.envelope("ready"),
      extra: true
    })).rejects.toMatchObject({ code: "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID" });
    await expect(state.subject.receive(
      state.event(),
      state.envelope("request")
    )).rejects.toMatchObject({ code: "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID" });
    await expect(state.subject.receive(
      state.event(),
      state.envelope("request", { type: "list", text: "x".repeat(65_536) })
    )).rejects.toMatchObject({ code: "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID" });
    expect(state.overlayRequest).not.toHaveBeenCalled();
  });

  it("uses exact ready evidence that arrived before the Core install effect", async () => {
    const state = harness();

    await expect(state.subject.receive(
      state.event(),
      state.envelope("ready")
    )).resolves.toEqual({
      frameToken: "frame-token-1",
      generation: 1,
      status: "ready"
    });
    await expect(state.subject.install(["role-1"], () => 1)).resolves.toBeUndefined();
  });

  it("settles an install effect only from the matching document ready event", async () => {
    const state = harness();
    const install = state.subject.install(["role-1"], () => 1);
    let settled = false;
    void install.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await state.subject.receive(state.event(), state.envelope("ready"));
    await expect(install).resolves.toBeUndefined();
  });

  it("rejects the old waiter when a newly navigated main frame becomes ready", async () => {
    const state = harness();
    const oldInstall = state.subject.install(["role-1"], () => 1);
    const oldFailure = oldInstall.catch((error: unknown) => error);

    state.replaceFrame("frame-token-2");
    await state.subject.receive(state.event(), state.envelope("ready"));
    await expect(oldFailure).resolves.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED"
    });
    await expect(state.subject.install(["role-1"], () => 1)).resolves.toBeUndefined();
  });

  it("returns fenced coordinate context without asking Core to invent geometry", async () => {
    const state = harness();

    await expect(state.subject.receive(
      state.event(),
      state.envelope("request", { type: "coordinate-context" })
    )).resolves.toEqual({
      appliedPageZoom: 1.25,
      surfaceGeneration: 1,
      topologyRevision: 7
    });
    expect(state.coordinateContext).toHaveBeenCalledWith(state.current());
    expect(state.overlayRequest).not.toHaveBeenCalled();
  });

  it("fails closed for native input observations until a native adapter exists", async () => {
    const state = harness();

    await expect(state.subject.receive(
      state.event(),
      state.envelope("managedShortcutKeyPhase", { phase: "keyDown" })
    )).rejects.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_NATIVE_METHOD_UNAVAILABLE"
    });
  });

  it("settles refresh only after exact world-1004 submission and applied receipt", async () => {
    const state = harness();
    await state.subject.receive(state.event(), state.envelope("ready"));

    const refresh = state.subject.refresh(["role-1"]);
    let settled = false;
    void refresh.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.executeOverlayRefresh).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    const refreshId = state.executeOverlayRefresh.mock.calls[0]![1];
    await expect(state.subject.receive(
      state.event(),
      state.envelope("refreshReceipt", {
        refreshId,
        requestVersion: 9,
        status: "applied"
      })
    )).resolves.toEqual({ refreshId, status: "accepted" });
    await expect(refresh).resolves.toEqual([{
      roleId: "role-1",
      generation: 1,
      frameToken: "frame-token-1",
      documentInstanceId: "document-1",
      inputContext: {
        documentInstanceId: "frame-token-1",
        revision: 1,
        target: "game"
      },
      refreshId,
      requestVersion: 9,
      status: "applied",
      worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID
    }]);
  });

  it("joins an early explicit refresh to the live document ready event", async () => {
    const state = harness();
    const refresh = state.subject.refresh(["role-1"]);
    let settled = false;
    void refresh.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.executeOverlayRefresh).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await state.subject.receive(state.event(), state.envelope("ready"));
    for (let index = 0;
      index < 8 && state.executeOverlayRefresh.mock.calls.length === 0;
      index += 1) {
      await Promise.resolve();
    }
    expect(state.executeOverlayRefresh).toHaveBeenCalledOnce();
    const refreshId = state.executeOverlayRefresh.mock.calls[0]![1];
    await state.subject.receive(state.event(), state.envelope("refreshReceipt", {
      refreshId,
      requestVersion: 1,
      status: "applied"
    }));
    await expect(refresh).resolves.toMatchObject([{
      refreshId,
      status: "applied"
    }]);
  });

  it("retains an early renderer receipt until exact submission is acknowledged", async () => {
    const state = harness();
    await state.subject.receive(state.event(), state.envelope("ready"));
    let resolveSubmission!:
      (receipt: ChromiumRoleOverlayRefreshSubmissionReceipt) => void;
    const submission = new Promise<ChromiumRoleOverlayRefreshSubmissionReceipt>(
      (resolve) => { resolveSubmission = resolve; }
    );
    state.executeOverlayRefresh.mockImplementationOnce(() => submission);

    const refresh = state.subject.refresh(["role-1"]);
    await Promise.resolve();
    const [identity, refreshId] = state.executeOverlayRefresh.mock.calls[0]!;
    await state.subject.receive(
      state.event(),
      state.envelope("refreshReceipt", {
        refreshId,
        requestVersion: 3,
        status: "applied"
      })
    );
    let settled = false;
    void refresh.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSubmission(Object.freeze({
      roleId: identity.roleId,
      generation: identity.generation,
      frameToken: identity.frameToken,
      refreshId,
      status: "submitted",
      worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID
    }));
    await expect(refresh).resolves.toMatchObject([{
      refreshId,
      requestVersion: 3,
      status: "applied"
    }]);
  });

  it("uses one FIFO refresh lane per role and refreshes every live ready overlay", async () => {
    const state = harness();
    await state.subject.receive(state.event(), state.envelope("ready"));
    state.addFrame("role-2", 4, "frame-token-2");
    await state.subject.receive(state.event(), state.envelope("ready"));

    const all = state.subject.refresh([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.executeOverlayRefresh).toHaveBeenCalledTimes(2);
    for (const [identity, refreshId] of state.executeOverlayRefresh.mock.calls) {
      state.selectRole(identity.roleId);
      await state.subject.receive(
        state.event(),
        state.envelope("refreshReceipt", {
          refreshId,
          requestVersion: identity.generation,
          status: "applied"
        })
      );
    }
    await expect(all).resolves.toHaveLength(2);

    state.selectRole("role-1");
    state.executeOverlayRefresh.mockClear();
    const first = state.subject.refresh(["role-1"]);
    const second = state.subject.refresh(["role-1"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.executeOverlayRefresh).toHaveBeenCalledOnce();
    const firstId = state.executeOverlayRefresh.mock.calls[0]![1];
    await state.subject.receive(state.event(), state.envelope("refreshReceipt", {
      refreshId: firstId,
      requestVersion: 10,
      status: "applied"
    }));
    await first;
    await Promise.resolve();
    expect(state.executeOverlayRefresh).toHaveBeenCalledTimes(2);
    const secondId = state.executeOverlayRefresh.mock.calls[1]![1];
    await state.subject.receive(state.event(), state.envelope("refreshReceipt", {
      refreshId: secondId,
      requestVersion: 11,
      status: "applied"
    }));
    await expect(second).resolves.toMatchObject([{ refreshId: secondId }]);
  });

  it("fences receipts and terminalizes navigation, failure, and dispose", async () => {
    const state = harness();
    await state.subject.receive(state.event(), state.envelope("ready"));
    const navigationRefresh = state.subject.refresh(["role-1"]);
    const navigationFailure = navigationRefresh.catch((error: unknown) => error);
    await Promise.resolve();
    const navigationId = state.executeOverlayRefresh.mock.calls[0]![1];

    await expect(state.subject.receive(
      state.event(),
      state.envelope("refreshReceipt", {
        extra: true,
        refreshId: navigationId,
        requestVersion: 2,
        status: "applied"
      })
    )).rejects.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_REFRESH_RECEIPT_INVALID"
    });
    state.replaceFrame("frame-token-navigated");
    await expect(state.subject.receive(
      state.event(),
      state.envelope("refreshReceipt", {
        refreshId: navigationId,
        requestVersion: 2,
        status: "applied"
      })
    )).rejects.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_REFRESH_RECEIPT_UNAUTHORIZED"
    });
    state.emitLifecycle({
      roleId: "role-1",
      generation: 1,
      reason: "document-superseded"
    });
    await expect(navigationFailure).resolves.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED"
    });

    await state.subject.receive(state.event(), state.envelope("ready"));
    const failed = state.subject.refresh(["role-1"]);
    const failedResult = failed.catch((error: unknown) => error);
    await Promise.resolve();
    const failedId = state.executeOverlayRefresh.mock.calls.at(-1)![1];
    await state.subject.receive(state.event(), state.envelope("refreshReceipt", {
      refreshId: failedId,
      status: "failed"
    }));
    await expect(failedResult).resolves.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_REFRESH_FAILED"
    });

    const pending = state.subject.refresh(["role-1"]);
    const disposedResult = pending.catch((error: unknown) => error);
    await Promise.resolve();
    state.subject.dispose();
    await expect(disposedResult).resolves.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_DISPOSED"
    });
  });

  it("removes the exact IPC handler and terminalizes pending readiness on dispose", async () => {
    const state = harness();
    let listener: ((event: ChromiumRoleOverlayIpcEventPort, envelope: unknown) => unknown) | null =
      null;
    const ipcMain = {
      handle: vi.fn((_channel, handler) => { listener = handler; }),
      removeHandler: vi.fn()
    };
    state.subject.register(ipcMain);
    expect(ipcMain.handle).toHaveBeenCalledWith(
      CHROMIUM_ROLE_OVERLAY_CHANNEL,
      expect.any(Function)
    );
    expect(listener).not.toBeNull();

    const installFailure = state.subject.install(["role-1"], () => 1)
      .catch((error: unknown) => error);
    state.subject.dispose();
    await expect(installFailure).resolves.toMatchObject({
      code: "ELECTRON_ROLE_OVERLAY_DISPOSED"
    });
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CHROMIUM_ROLE_OVERLAY_CHANNEL);
  });
});
