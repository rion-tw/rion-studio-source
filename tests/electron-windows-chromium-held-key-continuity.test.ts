import { describe, expect, it, vi } from "vitest";

import type { WindowsChromiumHeldKeyContinuityInputInternal } from
  "../src/electron/core/coreAddonClient";
import { WindowsChromiumHeldKeyContinuityCoordinator } from
  "../src/electron/main/windowsChromiumHeldKeyContinuityCoordinator";
import type { ChromiumRoleOverlayFrameIdentity } from
  "../src/electron/main/chromiumRoleSurfaceRegistry";
import type {
  WindowsChromiumInputPresentationEvent,
  WindowsChromiumInputPresentationPort
} from "../src/electron/main/windowsChromiumInputHostPorts";

function receipt(input: WindowsChromiumHeldKeyContinuityInputInternal) {
  return Object.freeze({
    ...input,
    inputEpoch: 7,
    status: "reasserted" as const,
    reassertedKeyCount: 1,
    requestIds: ["browser-action-1"],
    errorCode: null,
    errorMessage: null
  });
}

describe("Windows Chromium held-key continuity", () => {
  it("joins exact hidden presentation and authenticated blur to Core", async () => {
    const frame = Object.freeze({ id: 1 });
    const identity: ChromiumRoleOverlayFrameIdentity = Object.freeze({
      roleId: "role-1",
      generation: 3,
      frame,
      frameToken: "frame-token-1",
      documentInstanceId: "document-1"
    });
    let presentationListener: ((event: WindowsChromiumInputPresentationEvent) => void) |
      null = null;
    const restore = vi.fn(async (input: WindowsChromiumHeldKeyContinuityInputInternal) =>
      receipt(input));
    let operation = 0;
    const coordinator = new WindowsChromiumHeldKeyContinuityCoordinator({
      core: { restoreWindowsChromiumHeldKeysInternal: restore },
      surfaces: { currentOverlayFrame: () => identity },
      attachments: {
        subscribePresentation: (
          listener: (event: WindowsChromiumInputPresentationEvent) => void
        ) => {
          presentationListener = listener;
          return () => { presentationListener = null; };
        }
      } as unknown as WindowsChromiumInputPresentationPort,
      resolveIdentity: () => ({
        roleId: "role-1",
        tabId: "tab-1",
        surfaceGeneration: 3,
        documentInstanceId: "document-1",
        ownerGeneration: 5
      }),
      onError: vi.fn(),
      createOperationId: () => `continuity-${operation += 1}`
    });

    presentationListener!({
      roleId: "role-1",
      surfaceGeneration: 3,
      previousVisible: true,
      visible: false
    });
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(restore.mock.calls[0]![0]).toMatchObject({
      operationId: "continuity-1",
      roleId: "role-1",
      tabId: "tab-1",
      expectedOwnerGeneration: 5,
      surfaceGeneration: 3,
      documentInstanceId: "document-1",
      lossReason: "hidden",
      lossRevision: 1
    });

    await expect(coordinator.observeBlur(identity, {
      reason: "blur",
      revision: 4
    })).resolves.toMatchObject({
      operationId: "continuity-2",
      lossReason: "blur",
      lossRevision: 4,
      status: "reasserted"
    });
    expect(restore).toHaveBeenCalledTimes(2);

    coordinator.dispose();
    expect(presentationListener).toBeNull();
  });

  it("rejects forged blur observations before Core admission", async () => {
    const identity: ChromiumRoleOverlayFrameIdentity = Object.freeze({
      roleId: "role-1",
      generation: 3,
      frame: {},
      frameToken: "frame-token-1",
      documentInstanceId: "document-1"
    });
    const restore = vi.fn();
    const coordinator = new WindowsChromiumHeldKeyContinuityCoordinator({
      core: { restoreWindowsChromiumHeldKeysInternal: restore },
      surfaces: { currentOverlayFrame: () => identity },
      attachments: {
        subscribePresentation: () => () => undefined
      } as unknown as WindowsChromiumInputPresentationPort,
      resolveIdentity: () => {
        throw new Error("must not resolve");
      },
      onError: vi.fn()
    });
    await expect(coordinator.observeBlur(identity, {
      reason: "hidden",
      revision: 1
    })).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_HELD_CONTINUITY_OBSERVATION_INVALID"
    });
    expect(restore).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
