import { describe, expect, it, vi } from "vitest";

import type { ManagedShortcutSurfaceRetirementReceiptRecord } from
  "../src/shared/generated";
import { ChromiumManagedShortcutCoordinator } from
  "../src/electron/main/chromiumManagedShortcutCoordinator";

const identity = Object.freeze({
  roleId: "role-1",
  generation: 7,
  frame: {},
  frameToken: "frame-token-1",
  documentInstanceId: "document-1"
});

const surface = Object.freeze({
  roleId: "role-1",
  tabId: "tab-1",
  surfaceGeneration: 7,
  documentInstanceId: "document-1",
  ownerGeneration: 11
});

function request(phase: "keyDown" | "keyUp", shortcutCycleId = "cycle-1") {
  return {
    code: "Digit2",
    macroId: "macro-1",
    modifierCodes: ["ShiftLeft"],
    phase,
    shortcutCycleId
  };
}

function harness(
  status: "accepted" | "duplicate" | "superseded" | "indeterminate" = "accepted",
  dispatchGate: Promise<void> = Promise.resolve()
) {
  let operation = 0;
  const dispatch = vi.fn(async ({ operationId, surface: target, request: phase }) => {
    await dispatchGate;
    if (status === "indeterminate") {
      throw {
        code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        message: "Native receipt was lost."
      };
    }
    return {
      code: phase.code,
      documentInstanceId: target.documentInstanceId,
      expectedOwnerGeneration: target.ownerGeneration,
      macroId: phase.macroId,
      operationId,
      phase: phase.phase,
      shortcutCycleId: phase.shortcutCycleId,
      requestIds: status === "superseded" ? [] : [`browser-action-${operation}`],
      roleId: target.roleId,
      status,
      surfaceGeneration: target.surfaceGeneration,
      tabId: target.tabId
    };
  });
  const retireSurface = vi.fn(async (target: Readonly<{
    roleId: string;
    surfaceGeneration: number;
    documentInstanceId: string;
  }>) => ({
    cleanupRequestIds: ["browser-action-cleanup"],
    documentInstanceId: target.documentInstanceId,
    retiredShortcutCycleIds: ["cycle-1"],
    roleId: target.roleId,
    surfaceGeneration: target.surfaceGeneration,
    terminal: true as const
  }));
  const errors: unknown[] = [];
  const resolveSurface = vi.fn(() => surface);
  const coordinator = new ChromiumManagedShortcutCoordinator({
    dispatch,
    resolveSurface,
    retireSurface,
    subscribeSurfaceLifecycle: () => () => undefined,
    onError: (error) => { errors.push(error); },
    createOperationId: () => `operation-${++operation}`
  });
  return { coordinator, dispatch, errors, resolveSurface, retireSurface };
}

describe("Electron Chromium managed shortcut coordinator", () => {
  it("accepts an exact owner/document receipt and terminally retires the held cycle", async () => {
    const subject = harness();
    await expect(subject.coordinator.dispatch(identity, request("keyDown")))
      .resolves.toMatchObject({ status: "accepted", expectedOwnerGeneration: 11 });
    expect(subject.resolveSurface).toHaveBeenCalledWith(identity, "keyDown");

    await expect(subject.coordinator.retireSurface("role-1", 7)).resolves.toBeUndefined();
    expect(subject.retireSurface).toHaveBeenCalledWith({
      roleId: "role-1",
      surfaceGeneration: 7,
      documentInstanceId: "document-1"
    });
    await subject.coordinator.dispose();
  });

  it("classifies an empty-request superseded receipt instead of rejecting its shape", async () => {
    const subject = harness("superseded");

    await expect(subject.coordinator.dispatch(identity, request("keyDown")))
      .rejects.toMatchObject({ code: "ELECTRON_MANAGED_SHORTCUT_SUPERSEDED" });
    expect(subject.dispatch).toHaveBeenCalledOnce();
    expect(subject.retireSurface).not.toHaveBeenCalled();
    await subject.coordinator.dispose();
  });

  it("rejects queued reentry without replacing the original active cycle", async () => {
    const subject = harness();
    await subject.coordinator.dispatch(identity, request("keyDown", "cycle-1"));

    await expect(subject.coordinator.dispatch(identity, request("keyDown", "cycle-2")))
      .rejects.toMatchObject({ code: "ELECTRON_MANAGED_SHORTCUT_SUPERSEDED" });
    expect(subject.dispatch).toHaveBeenCalledOnce();
    await expect(subject.coordinator.retireSurface("role-1", 7)).resolves.toBeUndefined();
    expect(subject.retireSurface).toHaveBeenCalledWith({
      roleId: "role-1",
      surfaceGeneration: 7,
      documentInstanceId: "document-1"
    });
    await subject.coordinator.dispose();
  });

  it("rejects a second keyDown while the first cycle is still awaiting Core", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const subject = harness("accepted", gate);
    const first = subject.coordinator.dispatch(identity, request("keyDown", "cycle-1"));
    await vi.waitFor(() => expect(subject.dispatch).toHaveBeenCalledOnce());

    await expect(subject.coordinator.dispatch(identity, request("keyDown", "cycle-2")))
      .rejects.toMatchObject({ code: "ELECTRON_MANAGED_SHORTCUT_SUPERSEDED" });
    expect(subject.dispatch).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toMatchObject({ status: "accepted" });
    await subject.coordinator.dispose();
  });

  it("accepts duplicate terminal semantics only with the original exact request identity", async () => {
    const subject = harness("duplicate");

    await expect(subject.coordinator.dispatch(identity, request("keyDown")))
      .rejects.toMatchObject({ code: "ELECTRON_MANAGED_SHORTCUT_DUPLICATE" });
    expect(subject.dispatch).toHaveBeenCalledOnce();
    await subject.coordinator.dispose();
  });

  it("retains an indeterminate keyDown provisionally so close still invokes Core cleanup", async () => {
    const subject = harness("indeterminate");

    await expect(subject.coordinator.dispatch(identity, request("keyDown")))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" });
    await expect(subject.coordinator.retireSurface("role-1", 7)).resolves.toBeUndefined();
    expect(subject.retireSurface).toHaveBeenCalledWith({
      roleId: "role-1",
      surfaceGeneration: 7,
      documentInstanceId: "document-1"
    });
    await subject.coordinator.dispose();
  });

  it("retires the exact physical cycle when its keyUp cleanup is indeterminate", async () => {
    const subject = harness();
    await expect(subject.coordinator.dispatch(identity, request("keyDown", "cycle-1")))
      .resolves.toMatchObject({ status: "accepted" });
    subject.dispatch.mockRejectedValueOnce({
      code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
      message: "Cleanup receipt was lost."
    });

    await expect(subject.coordinator.dispatch(identity, request("keyUp", "cycle-1")))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" });
    await expect(subject.coordinator.dispatch(identity, request("keyDown", "cycle-2")))
      .resolves.toMatchObject({ status: "accepted" });
    expect(subject.dispatch).toHaveBeenCalledTimes(3);
    await subject.coordinator.dispose();
  });

  it("locally retires shortcuts and fences dispatch until exact reload release", async () => {
    const subject = harness();
    await subject.coordinator.dispatch(identity, request("keyDown"));
    const fence = {
      documentInstanceId: "document-1",
      operationId: "reload-1",
      roleId: "role-1",
      surfaceGeneration: 7
    } as const;

    await expect(subject.coordinator.prepareDocumentReplacement(fence))
      .resolves.toBeUndefined();
    expect(subject.retireSurface).not.toHaveBeenCalled();
    await expect(subject.coordinator.dispatch(identity, request("keyUp", "cycle-2")))
      .rejects.toMatchObject({
        code: "ELECTRON_MANAGED_SHORTCUT_DOCUMENT_REPLACING"
      });
    const retirement: ManagedShortcutSurfaceRetirementReceiptRecord = {
      cleanupRequestIds: ["cleanup-request-1"],
      documentInstanceId: "document-1",
      retiredShortcutCycleIds: ["cycle-1"],
      roleId: "role-1",
      surfaceGeneration: 7,
      terminal: true
    };
    expect(subject.coordinator.reconcileDocumentReplacementRetirement(
      fence,
      retirement
    )).toBe(true);
    expect(subject.coordinator.reconcileDocumentReplacementRetirement(
      fence,
      retirement
    )).toBe(true);
    expect(subject.coordinator.reconcileDocumentReplacementRetirement(fence, {
      ...retirement,
      cleanupRequestIds: ["different-cleanup"]
    })).toBe(false);
    expect(subject.coordinator.canCommitDocumentReplacement(fence)).toBe(true);
    expect(subject.coordinator.commitDocumentReplacement(fence)).toBe(true);
    expect(subject.coordinator.releaseDocumentReplacementFence(fence)).toBe(true);
    await expect(subject.coordinator.dispatch(identity, request("keyDown", "cycle-2")))
      .resolves.toMatchObject({ status: "accepted" });
    subject.retireSurface.mockResolvedValueOnce({
      cleanupRequestIds: ["browser-action-cleanup-2"],
      documentInstanceId: "document-1",
      retiredShortcutCycleIds: ["cycle-2"],
      roleId: "role-1",
      surfaceGeneration: 7,
      terminal: true
    });
    await expect(subject.coordinator.retireSurface("role-1", 7))
      .resolves.toBeUndefined();
    expect(subject.retireSurface).toHaveBeenCalledOnce();
    expect(subject.retireSurface).toHaveBeenCalledWith({
      documentInstanceId: "document-1",
      roleId: "role-1",
      surfaceGeneration: 7
    });
    await subject.coordinator.dispose();
  });
});
