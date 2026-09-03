import { describe, expect, it, vi } from "vitest";

import type { BrowserFontRuntimePayloadRecord } from "../src/shared/generated";
import { CHROMIUM_ROLE_FONTS_CHANNEL } from
  "../src/electron/ipc/chromiumRoleFontsProtocol";
import {
  ChromiumRoleFontsCoordinator,
  type ChromiumRoleFontsIpcEventPort
} from "../src/electron/main/chromiumRoleFontsCoordinator";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "../src/electron/main/chromiumRoleSurfaceRegistry";

const PAYLOAD = Object.freeze({
  settings: Object.freeze({
    mode: "custom" as const,
    fontSmoothingEnabled: true,
    cjkVariant: "auto" as const,
    slots: Object.freeze({
      latin: Object.freeze({ source: "google" as const, catalogId: "inter" })
    })
  }),
  faces: [{
    catalogId: "inter",
    family: "Inter",
    style: "normal",
    weight: "400",
    unicodeRange: "U+0000-024F",
    dataBase64: "d09GMmZpeHR1cmU="
  }]
}) as BrowserFontRuntimePayloadRecord;

const EVIDENCE = Object.freeze({
  canvasFontsActive: true,
  canvasTextQualityActive: true,
  failedFaceCount: 0,
  fontMode: "custom" as const,
  fontSmoothingEnabled: true,
  loadedCatalogIds: Object.freeze(["inter"]),
  loadedFaceCount: 1,
  runtimeVersion: 7 as const,
  sequence: 1,
  status: "applied" as const,
  styleInstalled: true
});

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function harness(payload: unknown = PAYLOAD) {
  const sender = {};
  let current: ChromiumRoleOverlayFrameIdentity = Object.freeze({
    roleId: "role-1",
    generation: 3,
    frame: Object.freeze({ frameToken: "frame-token-1" }),
    frameToken: "frame-token-1",
    documentInstanceId: "document-1"
  });
  let lifecycleListener:
    | ((event: ChromiumRoleOverlayLifecycleEvent) => void)
    | null = null;
  let applicationSequence = 0;
  let refreshSequence = 100;
  const browserFontRuntimePayload = vi.fn(async () => payload as BrowserFontRuntimePayloadRecord);
  const submitRoleFontsRefresh = vi.fn(async (
    identity: ChromiumRoleOverlayFrameIdentity,
    control: Readonly<{
      frameToken: string;
      generation: number;
      refreshId: string;
      roleId: string;
    }>
  ) => ({ ...control, status: "submitted" as const }));
  const subject = new ChromiumRoleFontsCoordinator({
    core: { browserFontRuntimePayload },
    surfaces: {
      authorizeOverlayFrame: (candidate, frame, token) => {
        if (
          candidate !== sender ||
          frame !== current.frame ||
          token !== current.frameToken
        ) {
          throw new Error("unauthorized frame");
        }
        return current;
      },
      currentOverlayFrame: (roleId, generation) => {
        if (roleId !== current.roleId || generation !== current.generation) {
          throw new Error("surface not found");
        }
        return current;
      },
      currentRolePreloadFrame: (roleId, generation) => {
        if (roleId !== current.roleId || generation !== current.generation) {
          throw new Error("surface not found");
        }
        return current;
      },
      listOverlayFrames: () => Object.freeze([current]),
      submitRoleFontsRefresh,
      subscribeOverlayLifecycle: (listener) => {
        lifecycleListener = listener;
        return () => {
          if (lifecycleListener === listener) lifecycleListener = null;
        };
      }
    },
    createApplicationId: () => id(++applicationSequence),
    createRefreshId: () => id(++refreshSequence)
  });
  const event = (): ChromiumRoleFontsIpcEventPort => ({
    sender,
    senderFrame: current.frame
  });
  const envelope = (method: string, value: unknown) => ({
    frameToken: current.frameToken,
    method,
    payload: value
  });
  const requestPayload = (refreshId: string | null) =>
    subject.receive(event(), envelope("payload", { refreshId })) as Promise<{
      applicationId: string;
      payloadRevision: number;
      refreshId: string | null;
    }>;
  const apply = async (
    response: Awaited<ReturnType<typeof requestPayload>>,
    evidence: unknown = EVIDENCE
  ) => subject.receive(event(), envelope("receipt", {
    applicationId: response.applicationId,
    evidence,
    payloadRevision: response.payloadRevision,
    refreshId: response.refreshId,
    status: "applied"
  }));
  return {
    apply,
    browserFontRuntimePayload,
    current: () => current,
    emitLifecycle: (reason: ChromiumRoleOverlayLifecycleEvent["reason"]) => {
      lifecycleListener?.({
        roleId: current.roleId,
        generation: current.generation,
        reason
      });
    },
    envelope,
    event,
    fail: (refreshId: string | null, code = "ELECTRON_ROLE_FONT_TEST_FAILED") =>
      subject.receive(event(), envelope("failure", {
        code,
        refreshId,
        status: "failed"
      })),
    navigate: (frameToken: string) => {
      const previous = current;
      current = Object.freeze({
        ...current,
        frame: Object.freeze({ frameToken }),
        frameToken
      });
      lifecycleListener?.({
        roleId: previous.roleId,
        generation: previous.generation,
        reason: "document-superseded"
      });
    },
    requestPayload,
    subject,
    submitRoleFontsRefresh
  };
}

async function installReady(state: ReturnType<typeof harness>): Promise<void> {
  const install = state.subject.install(["role-1"], () => 3);
  const response = await state.requestPayload(null);
  await state.apply(response);
  await install;
}

describe("Chromium role browser-font coordinator", () => {
  it("settles installation only from exact main-world application evidence", async () => {
    const state = harness();
    const install = state.subject.install(["role-1"], () => 3);
    let settled = false;
    void install.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const response = await state.requestPayload(null);
    expect(response).toMatchObject({
      applicationId: id(1),
      payloadRevision: 1,
      refreshId: null
    });
    expect(state.browserFontRuntimePayload).toHaveBeenCalledOnce();
    await expect(state.apply(response)).resolves.toEqual({
      applicationId: id(1),
      status: "accepted"
    });
    await expect(install).resolves.toBeUndefined();
    await expect(state.subject.install(["role-1"], () => 3))
      .resolves.toBeUndefined();
  });

  it("rejects payloads outside the canonical face and selection bounds", async () => {
    const state = harness({
      ...PAYLOAD,
      faces: [{ ...PAYLOAD.faces[0], catalogId: "unselected" }]
    });

    await expect(state.requestPayload(null)).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_PAYLOAD_INVALID"
    });
  });

  it("makes preload installation failure observable to the pending effect", async () => {
    const state = harness();
    const install = state.subject.install(["role-1"], () => 3);

    await expect(state.fail(null, "ELECTRON_ROLE_FONT_PRELOAD_FAILED"))
      .resolves.toEqual({ status: "accepted" });
    await expect(install).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_PRELOAD_FAILED"
    });
    await expect(state.subject.install(["role-1"], () => 3)).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_PRELOAD_FAILED"
    });
  });

  it("refreshes through a FIFO identity and exact payload/application receipt", async () => {
    const state = harness();
    await installReady(state);

    const refresh = state.subject.refresh(["role-1"]);
    await vi.waitFor(() => expect(state.submitRoleFontsRefresh).toHaveBeenCalledOnce());
    const control = state.submitRoleFontsRefresh.mock.calls[0]![1];
    const response = await state.requestPayload(control.refreshId);
    await state.apply(response);

    await expect(refresh).resolves.toMatchObject([{
      applicationId: response.applicationId,
      frameToken: "frame-token-1",
      generation: 3,
      payloadRevision: response.payloadRevision,
      refreshId: control.refreshId,
      roleId: "role-1",
      status: "applied"
    }]);
  });

  it("queues a settings refresh behind initial installation instead of skipping the live role", async () => {
    const state = harness();
    const refresh = state.subject.refresh([]);
    await Promise.resolve();
    expect(state.submitRoleFontsRefresh).not.toHaveBeenCalled();

    const initial = await state.requestPayload(null);
    await state.apply(initial);
    await vi.waitFor(() => expect(state.submitRoleFontsRefresh).toHaveBeenCalledOnce());
    const control = state.submitRoleFontsRefresh.mock.calls[0]![1];
    const replacement = await state.requestPayload(control.refreshId);
    await state.apply(replacement);
    await expect(refresh).resolves.toHaveLength(1);
  });

  it("does not submit the next role refresh before the prior receipt terminalizes", async () => {
    const state = harness();
    await installReady(state);

    const first = state.subject.refresh(["role-1"]);
    const second = state.subject.refresh(["role-1"]);
    await vi.waitFor(() => expect(state.submitRoleFontsRefresh).toHaveBeenCalledTimes(1));
    const firstControl = state.submitRoleFontsRefresh.mock.calls[0]![1];
    const firstResponse = await state.requestPayload(firstControl.refreshId);
    await state.apply(firstResponse);
    await first;
    await vi.waitFor(() => expect(state.submitRoleFontsRefresh).toHaveBeenCalledTimes(2));
    const secondControl = state.submitRoleFontsRefresh.mock.calls[1]![1];
    const secondResponse = await state.requestPayload(secondControl.refreshId);
    await state.apply(secondResponse);
    await expect(second).resolves.toHaveLength(1);
  });

  it("rejects refresh evidence when a selected available font did not load", async () => {
    const state = harness();
    await installReady(state);
    const refresh = state.subject.refresh(["role-1"]);
    await vi.waitFor(() => expect(state.submitRoleFontsRefresh).toHaveBeenCalledOnce());
    const control = state.submitRoleFontsRefresh.mock.calls[0]![1];
    const response = await state.requestPayload(control.refreshId);

    await expect(state.apply(response, {
      ...EVIDENCE,
      loadedCatalogIds: [],
      loadedFaceCount: 0
    })).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_APPLICATION_MISMATCH"
    });
    await expect(state.apply(response, {
      ...EVIDENCE,
      failedFaceCount: 1
    })).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_APPLICATION_MISMATCH"
    });
    await state.fail(control.refreshId);
    await expect(refresh).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_TEST_FAILED"
    });
  });

  it("terminalizes install and refresh from document lifecycle, never elapsed time", async () => {
    const installing = harness();
    const install = installing.subject.install(["role-1"], () => 3);
    installing.navigate("frame-token-2");
    await expect(install).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED"
    });

    const refreshing = harness();
    await installReady(refreshing);
    const refresh = refreshing.subject.refresh(["role-1"]);
    await vi.waitFor(() => expect(refreshing.submitRoleFontsRefresh).toHaveBeenCalledOnce());
    refreshing.emitLifecycle("surface-retired");
    await expect(refresh).rejects.toMatchObject({
      code: "ELECTRON_ROLE_FONT_SURFACE_RETIRED"
    });
  });

  it("registers and removes only the fixed browser-font IPC handler", () => {
    const state = harness();
    const handle = vi.fn();
    const removeHandler = vi.fn();

    state.subject.register({ handle, removeHandler });
    expect(handle).toHaveBeenCalledWith(CHROMIUM_ROLE_FONTS_CHANNEL, expect.any(Function));
    state.subject.dispose();
    expect(removeHandler).toHaveBeenCalledWith(CHROMIUM_ROLE_FONTS_CHANNEL);
  });
});
