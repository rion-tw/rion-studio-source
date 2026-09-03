import { describe, expect, it, vi } from "vitest";

import type {
  CoreEffectRequest,
  ManagedShortcutSurfaceRetirementReceiptRecord
} from "../src/shared/generated";
import type { ChromiumAutomaticInputContextIdentity } from
  "../src/electron/main/chromiumAutomaticInputContextCoordinator";
import type { ChromiumManagedShortcutCoordinator } from
  "../src/electron/main/chromiumManagedShortcutCoordinator";
import type { ChromiumPopupOwnerLifecyclePort } from
  "../src/electron/main/chromiumPopupPorts";
import type { ChromiumRoleOverlayCoordinator } from
  "../src/electron/main/chromiumRoleOverlayCoordinator";
import {
  ChromiumRoleReloadCoordinator
} from "../src/electron/main/chromiumRoleReloadCoordinator";
import type {
  ChromiumRoleControlledReloadPreparation,
  ChromiumRoleNavigationLifecycleEvent,
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleSurfaceRegistry
} from "../src/electron/main/chromiumRoleSurfaceRegistry";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeSnapshot";
import type {
  ChromiumTrustedInputCoordinator,
  ChromiumTrustedInputDocumentReplacementLease
} from "../src/electron/main/chromiumTrustedInputCoordinator";

type PrepareAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedPrepareTabRoleReload" }
>;
type CommitAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedCommitTabRoleReload" }
>;
type SupersedeAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedSupersedeTabRoleReload" }
>;
interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const windowId = "window-1";
const tabId = "tab-1";
const frame = Object.freeze({});
const frameToken = "reused-electron-frame-token";

function prepareAction(
  operationId: string,
  roleIds: readonly string[] = ["role-1"],
  topologyRevision = 9
): PrepareAction {
  return {
    type: "embeddedPrepareTabRoleReload",
    lifecycleEpoch: 3,
    reloadOperationId: operationId,
    roles: roleIds.map((roleId, index) => ({
      inputEpoch: 12 + index,
      ownerGeneration: 4 + index,
      roleId
    })),
    tabId,
    topologyRevision,
    windowGeneration: 2,
    windowId
  };
}

function effect<Action extends CoreEffectRequest["action"]>(
  action: Action
): CoreEffectRequest & Readonly<{ action: Action }> {
  const reloadOperationId = "reloadOperationId" in action
    ? action.reloadOperationId as string
    : "unknown";
  return {
    action,
    completionPolicy: "eventBound",
    effectId: `effect:${reloadOperationId}:${action.type}`,
    operationId: `actor:${reloadOperationId}:${action.type}`,
    parentOperationId: reloadOperationId,
    target: { handleId: tabId, kind: "app" }
  };
}

function commitAction(
  action: PrepareAction,
  roles: readonly ChromiumRoleControlledReloadPreparation[]
): CommitAction {
  return {
    type: "embeddedCommitTabRoleReload",
    lifecycleEpoch: action.lifecycleEpoch,
    managedShortcutRetirements: roles.map((role) => ({
      cleanupRequestIds: [],
      documentInstanceId: role.documentInstanceId,
      retiredPressIds: [],
      roleId: role.roleId,
      surfaceGeneration: role.surfaceGeneration,
      terminal: true
    })),
    reloadOperationId: action.reloadOperationId,
    roles: roles.map((role, index) => ({
      documentInstanceId: role.documentInstanceId,
      inputEpoch: action.roles[index]!.inputEpoch,
      ownerGeneration: action.roles[index]!.ownerGeneration,
      roleId: role.roleId,
      surfaceGeneration: role.surfaceGeneration
    })),
    tabId: action.tabId,
    topologyRevision: action.topologyRevision,
    windowGeneration: action.windowGeneration,
    windowId: action.windowId
  };
}

function supersedeAction(
  action: PrepareAction,
  managedShortcutRetirements: readonly ManagedShortcutSurfaceRetirementReceiptRecord[] = []
): SupersedeAction {
  return {
    type: "embeddedSupersedeTabRoleReload",
    managedShortcutRetirements: [...managedShortcutRetirements],
    reason: "coreCleanup",
    reloadOperationId: action.reloadOperationId,
    roleIds: action.roles.map((role) => role.roleId),
    tabId: action.tabId
  };
}

interface RoleState {
  documentInstanceId: string;
  readonly generation: number;
  navigationSequence: number;
}

function harness(roleIds: readonly string[] = ["role-1"]) {
  const roles = new Map(roleIds.map((roleId, index) => [roleId, {
    documentInstanceId: `document:${roleId}:0`,
    generation: 7 + index,
    navigationSequence: 0
  } satisfies RoleState]));
  const surfaceFences = new Map<string, Set<string>>();
  let navigationListener:
    | ((event: ChromiumRoleNavigationLifecycleEvent) => boolean | void)
    | null = null;
  const submitted: string[] = [];
  const submissionWaiters = new Set<Readonly<{
    count: number;
    resolve: () => void;
  }>>();
  const surfaces = {
    subscribeNavigationLifecycle: vi.fn((listener) => {
      navigationListener = listener;
      return () => { navigationListener = null; };
    }),
    preflightControlledReload: vi.fn((roleId: string, generation: number) => {
      const state = roles.get(roleId);
      if (!state || state.generation !== generation) throw new Error("stale surface");
      return Object.freeze({
        documentInstanceId: state.documentInstanceId,
        navigationSequence: state.navigationSequence,
        roleId,
        surfaceGeneration: state.generation,
        tabId
      });
    }),
    acquireControlledReloadFence: vi.fn((
      preparation: ChromiumRoleControlledReloadPreparation,
      operationId: string
    ) => {
      const operations = surfaceFences.get(preparation.roleId) ?? new Set();
      operations.add(operationId);
      surfaceFences.set(preparation.roleId, operations);
      return preparation;
    }),
    releaseControlledReloadFence: vi.fn((
      roleId: string,
      generation: number,
      operationId: string,
      expectedDocumentInstanceId?: string
    ) => {
      const state = roles.get(roleId);
      if (!state || state.generation !== generation ||
        !surfaceFences.get(roleId)?.has(operationId) ||
        (expectedDocumentInstanceId !== undefined &&
          state.documentInstanceId !== expectedDocumentInstanceId)) return false;
      const operations = surfaceFences.get(roleId)!;
      operations.delete(operationId);
      if (operations.size === 0) surfaceFences.delete(roleId);
      return true;
    }),
    submitControlledReload: vi.fn((
      preparation: ChromiumRoleControlledReloadPreparation,
      operationId: string
    ) => {
      if (!surfaceFences.get(preparation.roleId)?.has(operationId)) {
        throw new Error("reload fence missing");
      }
      submitted.push(preparation.roleId);
      for (const waiter of [...submissionWaiters]) {
        if (submitted.length < waiter.count) continue;
        submissionWaiters.delete(waiter);
        waiter.resolve();
      }
    }),
    currentOverlayFrame: vi.fn((roleId: string, generation: number) => {
      const state = roles.get(roleId);
      if (!state || state.generation !== generation) throw new Error("stale surface");
      return Object.freeze({
        documentInstanceId: state.documentInstanceId,
        frame,
        frameToken,
        generation,
        roleId
      } satisfies ChromiumRoleOverlayFrameIdentity);
    })
  };

  const managedFences = new Map<string, string>();
  const managedRetired = new Set<string>();
  const managedActive = new Set(roleIds);
  const managedPrepareControls = new Map<string, Deferred<void>>();
  const managed = {
    prepareDocumentReplacement: vi.fn((input: Readonly<{
      operationId: string;
      roleId: string;
    }>) => {
      managedFences.set(input.roleId, input.operationId);
      return managedPrepareControls.get(input.roleId)?.promise ?? Promise.resolve();
    }),
    reconcileDocumentReplacementRetirement: vi.fn((input: Readonly<{
      operationId: string;
      roleId: string;
    }>, receipt: ManagedShortcutSurfaceRetirementReceiptRecord) => {
      if (managedFences.get(input.roleId) !== input.operationId ||
        receipt.roleId !== input.roleId || receipt.terminal !== true) return false;
      managedRetired.add(input.roleId);
      managedActive.delete(input.roleId);
      return true;
    }),
    canCommitDocumentReplacement: vi.fn((input: Readonly<{
      operationId: string;
      roleId: string;
    }>) => managedFences.get(input.roleId) === input.operationId &&
      managedRetired.has(input.roleId)),
    commitDocumentReplacement: vi.fn((input: Readonly<{
      operationId: string;
      roleId: string;
    }>) => {
      if (managedFences.get(input.roleId) !== input.operationId) return false;
      return managedRetired.has(input.roleId);
    }),
    releaseDocumentReplacementFence: vi.fn((input: Readonly<{
      operationId: string;
      roleId: string;
    }>) => {
      if (managedFences.get(input.roleId) !== input.operationId) return false;
      managedFences.delete(input.roleId);
      managedRetired.delete(input.roleId);
      return true;
    })
  };

  const trustedFences = new Map<string, ChromiumTrustedInputDocumentReplacementLease>();
  const quarantined = new Set<string>();
  const trusted = {
    prepareControlledDocumentReplacement: vi.fn(async (
      lease: ChromiumTrustedInputDocumentReplacementLease
    ) => {
      if (quarantined.has(lease.roleId)) throw new Error("quarantined");
      trustedFences.set(lease.roleId, lease);
    }),
    confirmControlledDocumentReplacementNeutral: vi.fn(async (
      lease: ChromiumTrustedInputDocumentReplacementLease
    ) => trustedFences.get(lease.roleId) === lease && !quarantined.has(lease.roleId)),
    resumeControlledDocumentReplacement: vi.fn(async (
      lease: ChromiumTrustedInputDocumentReplacementLease,
      nextDocumentInstanceId: string
    ) => {
      const state = roles.get(lease.roleId);
      if (trustedFences.get(lease.roleId) !== lease ||
        state?.documentInstanceId !== nextDocumentInstanceId) return false;
      trustedFences.delete(lease.roleId);
      return true;
    }),
    supersedeControlledDocumentReplacement: vi.fn((
      lease: ChromiumTrustedInputDocumentReplacementLease,
      wasSubmitted: boolean
    ) => {
      if (trustedFences.get(lease.roleId) !== lease) return false;
      if (wasSubmitted) quarantined.add(lease.roleId);
      else trustedFences.delete(lease.roleId);
      return true;
    })
  };

  const popupFences = new Map<string, string>();
  const popupPrepareControls = new Map<string, Deferred<void>>();
  const popups = {
    prepareOwnerReload: vi.fn(async (owner: Readonly<{ ownerId: string }>, op: string) => {
      popupFences.set(owner.ownerId, op);
      const control = popupPrepareControls.get(owner.ownerId);
      if (control) await control.promise;
      if (popupFences.get(owner.ownerId) !== op) throw new Error("popup superseded");
    }),
    releaseOwnerReload: vi.fn((owner: Readonly<{ ownerId: string }>, op: string) => {
      if (popupFences.get(owner.ownerId) !== op) return false;
      popupFences.delete(owner.ownerId);
      return true;
    })
  };

  let contextListener:
    | ((identity: ChromiumAutomaticInputContextIdentity) => void)
    | null = null;
  const inputContexts = {
    subscribeContextObservations: vi.fn((listener) => {
      contextListener = listener;
      return () => { contextListener = null; };
    })
  };
  const refreshTargets: Array<"document" | "embedded-frame" | "game"> = [];
  let refreshCount = 0;
  const refreshWaiters = new Set<Readonly<{
    count: number;
    resolve: () => void;
  }>>();
  const overlays = {
    install: vi.fn(async () => undefined),
    refresh: vi.fn(async (requestedRoleIds: readonly string[]) =>
      requestedRoleIds.map((roleId) => {
        const state = roles.get(roleId)!;
        refreshCount += 1;
        for (const waiter of [...refreshWaiters]) {
          if (refreshCount < waiter.count) continue;
          refreshWaiters.delete(waiter);
          waiter.resolve();
        }
        return Object.freeze({
          documentInstanceId: state.documentInstanceId,
          frameToken,
          generation: state.generation,
          inputContext: Object.freeze({
            documentInstanceId: frameToken,
            revision: refreshCount,
            target: refreshTargets.shift() ?? "game" as const
          }),
          refreshId: `10000000-0000-4000-8000-${String(refreshCount).padStart(12, "0")}`,
          requestVersion: refreshCount,
          roleId,
          status: "applied" as const,
          worldId: 1004 as const
        });
      }))
  };
  const snapshot: ChromiumRuntimeExecutorSnapshot = {
    roles: roleIds.map((roleId, index) => ({
      generation: roles.get(roleId)!.generation,
      ownerGeneration: 4 + index,
      roleId,
      tabId,
      windowId
    })),
    tabs: [{ audioMuted: false, audible: false, tabId, windowId }],
    webSurfaces: [],
    windows: [{
      activeTabId: "another-tab",
      bounds: { height: 600, width: 800, x: 0, y: 0 },
      displayId: 1,
      focused: false,
      presentation: "normal",
      tabIds: ["another-tab", tabId],
      topologyRevision: 9,
      visible: false,
      windowGeneration: 2,
      windowId
    }]
  };
  const coordinator = new ChromiumRoleReloadCoordinator({
    inputContexts: inputContexts as never,
    managedShortcuts: managed as unknown as ChromiumManagedShortcutCoordinator,
    overlays: overlays as unknown as ChromiumRoleOverlayCoordinator,
    popups: popups as unknown as ChromiumPopupOwnerLifecyclePort,
    readSnapshot: () => snapshot,
    surfaces: surfaces as unknown as ChromiumRoleSurfaceRegistry,
    trustedInput: trusted as unknown as ChromiumTrustedInputCoordinator
  });

  const emitStart = (roleId: string): void => {
    const state = roles.get(roleId)!;
    const previousDocumentInstanceId = state.documentInstanceId;
    state.navigationSequence += 1;
    state.documentInstanceId = `document:${roleId}:${state.navigationSequence}`;
    navigationListener?.({
      generation: state.generation,
      navigationSequence: state.navigationSequence,
      previousDocumentInstanceId,
      roleId,
      tabId,
      type: "document-started"
    });
  };
  const emitFinish = (roleId: string, sequence?: number): void => {
    const state = roles.get(roleId)!;
    navigationListener?.({
      documentInstanceId: state.documentInstanceId,
      generation: state.generation,
      navigationSequence: sequence ?? state.navigationSequence,
      roleId,
      tabId,
      type: "page-finished",
      validatedUrl: "https://game.test/launch"
    });
  };
  const emitFailure = (roleId: string, errorCode: number): void => {
    const state = roles.get(roleId)!;
    navigationListener?.({
      errorCode,
      generation: state.generation,
      navigationSequence: state.navigationSequence,
      roleId,
      tabId,
      type: "page-failed"
    });
  };
  const emitRetired = (roleId: string): void => {
    const state = roles.get(roleId)!;
    navigationListener?.({
      generation: state.generation,
      navigationSequence: state.navigationSequence,
      roleId,
      tabId,
      type: "surface-retired"
    });
    surfaceFences.delete(roleId);
  };
  const emitContext = (roleId: string): void => {
    const state = roles.get(roleId)!;
    contextListener?.({
      documentInstanceId: state.documentInstanceId,
      roleId,
      surfaceGeneration: state.generation
    });
  };
  const waitForRefresh = (count: number): Promise<void> => {
    if (refreshCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      refreshWaiters.add(Object.freeze({ count, resolve }));
    });
  };
  const waitForSubmission = (count: number): Promise<void> => {
    if (submitted.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      submissionWaiters.add(Object.freeze({ count, resolve }));
    });
  };
  return {
    coordinator,
    emitContext,
    emitFailure,
    emitFinish,
    emitRetired,
    emitStart,
    managedActive,
    managedFences,
    managedPrepareControls,
    popupFences,
    popupPrepareControls,
    refreshTargets,
    roles,
    snapshot,
    submitted,
    surfaceFences,
    trustedFences,
    waitForRefresh,
    waitForSubmission
  };
}

async function prepare(subject: ReturnType<typeof harness>, action: PrepareAction) {
  return subject.coordinator.prepare(effect(action), action);
}

describe("ChromiumRoleReloadCoordinator", () => {
  it("requires the reload identity on the child effect parent fence", () => {
    const subject = harness();
    const action = prepareAction("reload-parent-fence");
    expect(() => subject.coordinator.prepare({
      ...effect(action),
      parentOperationId: "another-reload"
    }, action)).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_RELOAD_EFFECT_INVALID"
    }));
    subject.coordinator.dispose();
  });

  it("reloads an inactive retained native tab twice and replays immutable receipts", async () => {
    const subject = harness();
    const actionA = prepareAction("reload-a");
    const preparedA = await prepare(subject, actionA);
    expect(subject.managedActive.has("role-1")).toBe(true);
    const commitA = commitAction(actionA, preparedA.roles.map((role) => ({
      ...role,
      navigationSequence: 0,
      tabId
    })));
    const terminalA = subject.coordinator.commit(effect(commitA), commitA);
    expect(subject.managedActive.has("role-1")).toBe(false);
    await subject.waitForSubmission(1);
    subject.emitStart("role-1");
    subject.emitFinish("role-1");
    await expect(terminalA).resolves.toMatchObject({ status: "applied" });

    const actionB = prepareAction("reload-b");
    const preparedB = await prepare(subject, actionB);
    const commitB = commitAction(actionB, preparedB.roles.map((role) => ({
      ...role,
      navigationSequence: 1,
      tabId
    })));
    const terminalB = subject.coordinator.commit(effect(commitB), commitB);
    await subject.waitForSubmission(2);
    subject.emitStart("role-1");
    subject.emitFinish("role-1");
    await expect(terminalB).resolves.toMatchObject({
      roles: [{ navigationSequence: 2, nativeInputResumed: true }],
      status: "applied"
    });
    await expect(prepare(subject, actionA)).resolves.toBe(preparedA);
    await expect(subject.coordinator.commit(effect(commitA), commitA))
      .resolves.toBe(await terminalA);
    const changedCommitReplay: CommitAction = {
      ...commitA,
      managedShortcutRetirements: [{
        ...commitA.managedShortcutRetirements[0]!,
        cleanupRequestIds: ["changed-commit-replay"]
      }]
    };
    await expect(subject.coordinator.commit(
      effect(changedCommitReplay),
      changedCommitReplay
    )).rejects.toMatchObject({
      code: "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH"
    });
    expect(subject.submitted).toEqual(["role-1", "role-1"]);
    subject.coordinator.dispose();
  });

  it("rejects commit while prepare is pending and releases a superseded popup drain", async () => {
    const subject = harness();
    const popup = deferred<void>();
    subject.popupPrepareControls.set("role-1", popup);
    const action = prepareAction("reload-pending");
    const pending = prepare(subject, action);
    const state = subject.roles.get("role-1")!;
    const premature = commitAction(action, [{
      documentInstanceId: state.documentInstanceId,
      navigationSequence: state.navigationSequence,
      roleId: "role-1",
      surfaceGeneration: state.generation,
      tabId
    }]);
    await expect(subject.coordinator.commit(effect(premature), premature))
      .rejects.toMatchObject({ code: "ELECTRON_ROLE_RELOAD_PREPARATION_NOT_APPLIED" });
    const cleanup = supersedeAction(action);
    expect(subject.coordinator.supersede(effect(cleanup), cleanup)).toMatchObject({
      roles: [{ nativeInputResumed: true, status: "applied" }],
      status: "applied"
    });
    popup.resolve();
    await expect(pending).resolves.toMatchObject({ status: "superseded" });
    expect(subject.popupFences.size).toBe(0);
    expect(subject.surfaceFences.size).toBe(0);
    expect(subject.submitted).toEqual([]);
    subject.coordinator.dispose();
  });

  it("keeps every uncompensated no-mutation tombstone beyond replay capacity", async () => {
    const subject = harness();
    const actions = Array.from({ length: 65 }, (_, index) =>
      prepareAction(`invalid-${index}`, ["role-1"], 100 + index));
    for (const action of actions) {
      await expect(prepare(subject, action)).rejects.toMatchObject({
        code: "ELECTRON_ROLE_RELOAD_TOPOLOGY_STALE"
      });
    }
    const cleanup = supersedeAction(actions[0]!);
    expect(subject.coordinator.supersede(effect(cleanup), cleanup)).toMatchObject({
      roles: [{ status: "applied", submissionState: "notSubmitted" }],
      status: "applied"
    });
    expect(subject.surfaceFences.size).toBe(0);
    subject.coordinator.dispose();
  });

  it("preflights every role before acquiring the first local fence", async () => {
    const subject = harness(["role-1"]);
    const action = prepareAction("reload-two-roles", ["role-1", "role-stale"]);
    (subject.snapshot.roles as ChromiumRuntimeExecutorSnapshot["roles"][number][])
      .push({
        generation: 8,
        ownerGeneration: 5,
        roleId: "role-stale",
        tabId,
        windowId
      });
    await expect(prepare(subject, action)).rejects.toThrow("stale surface");
    expect(subject.surfaceFences.size).toBe(0);
    const cleanup = supersedeAction(action);
    expect(subject.coordinator.supersede(effect(cleanup), cleanup).status)
      .toBe("applied");
    subject.coordinator.dispose();
  });

  it("reconciles only Core-proven shortcut retirements after a later role fails", async () => {
    const subject = harness(["role-1", "role-2"]);
    const action = prepareAction("reload-partial-shortcut-retirement", [
      "role-1",
      "role-2"
    ]);
    const prepared = await prepare(subject, action);
    const allEvidence = commitAction(action, prepared.roles.map((role) => ({
      ...role,
      navigationSequence: 0,
      tabId
    }))).managedShortcutRetirements;
    const firstRoleEvidence = allEvidence.filter((receipt) =>
      receipt.roleId === "role-1");
    const cleanup = supersedeAction(action, firstRoleEvidence);

    const receipt = subject.coordinator.supersede(effect(cleanup), cleanup);
    expect(receipt).toMatchObject({
      roles: [
        { roleId: "role-1", status: "applied" },
        { roleId: "role-2", status: "applied" }
      ],
      status: "applied"
    });
    expect(subject.managedActive.has("role-1")).toBe(false);
    expect(subject.managedActive.has("role-2")).toBe(true);
    expect(subject.coordinator.supersede(effect(cleanup), cleanup)).toBe(receipt);

    const changedEvidence = supersedeAction(action, [{
      ...firstRoleEvidence[0]!,
      cleanupRequestIds: ["changed-replay-cleanup"]
    }]);
    expect(() => subject.coordinator.supersede(
      effect(changedEvidence),
      changedEvidence
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_RELOAD_SHORTCUT_RETIREMENT_MISMATCH"
    }));
    subject.coordinator.dispose();
  });

  it("reconciles all retired shortcut roles before a post-drain cleanup", async () => {
    const subject = harness(["role-1", "role-2"]);
    const action = prepareAction("reload-post-drain-cleanup", [
      "role-1",
      "role-2"
    ]);
    const prepared = await prepare(subject, action);
    const allEvidence = commitAction(action, prepared.roles.map((role) => ({
      ...role,
      navigationSequence: 0,
      tabId
    }))).managedShortcutRetirements;
    const cleanup = supersedeAction(action, allEvidence);

    expect(subject.coordinator.supersede(effect(cleanup), cleanup)).toMatchObject({
      roles: [
        { roleId: "role-1", nativeInputResumed: true, status: "applied" },
        { roleId: "role-2", nativeInputResumed: true, status: "applied" }
      ],
      status: "applied"
    });
    expect(subject.managedActive.size).toBe(0);
    expect(subject.managedFences.size).toBe(0);
    subject.coordinator.dispose();
  });

  it("waits event-bound for a fresh isolated game challenge and ignores finish noise", async () => {
    const subject = harness();
    subject.refreshTargets.push("document", "document", "game");
    const action = prepareAction("reload-readiness");
    const prepared = await prepare(subject, action);
    const commit = commitAction(action, prepared.roles.map((role) => ({
      ...role,
      navigationSequence: 0,
      tabId
    })));
    const terminal = subject.coordinator.commit(effect(commit), commit);
    let settled = false;
    void terminal.then(() => { settled = true; });
    subject.emitFinish("role-1", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    await subject.waitForSubmission(1);
    subject.emitStart("role-1");
    subject.emitFinish("role-1");
    await subject.waitForRefresh(1);
    expect(settled).toBe(false);
    // A late old-document observation may wake a new challenge, but cannot
    // itself prove readiness even with a reused Electron frame token.
    subject.emitContext("role-1");
    await subject.waitForRefresh(2);
    expect(settled).toBe(false);
    subject.emitContext("role-1");
    await expect(terminal).resolves.toMatchObject({ status: "applied" });
    subject.emitFinish("role-1");
    expect(subject.submitted).toEqual(["role-1"]);
    subject.coordinator.dispose();
  });

  it("quarantines overlapping navigation through late ERR_ABORTED until retirement", async () => {
    const subject = harness();
    const action = prepareAction("reload-overlap");
    const prepared = await prepare(subject, action);
    const commit = commitAction(action, prepared.roles.map((role) => ({
      ...role,
      navigationSequence: 0,
      tabId
    })));
    const terminal = subject.coordinator.commit(effect(commit), commit);
    await subject.waitForSubmission(1);
    subject.emitStart("role-1");
    subject.emitStart("role-1");
    subject.emitFailure("role-1", -3);
    subject.emitFinish("role-1");
    await expect(terminal).resolves.toMatchObject({
      roles: [{ nativeInputResumed: false, restartRequired: true }],
      status: "indeterminate"
    });
    const next = prepareAction("reload-after-overlap");
    await expect(prepare(subject, next)).resolves.toMatchObject({
      status: "superseded"
    });
    subject.emitRetired("role-1");
    subject.coordinator.dispose();
  });

  it.each(["newer-cleanup-first", "older-supersede-first"] as const)(
    "never lets a rejected replacement reopen input around an older submitted reload: %s",
    async (ordering) => {
      const subject = harness();
      const older = prepareAction(`reload-older-${ordering}`);
      const olderPreparation = await prepare(subject, older);
      const olderCommit = commitAction(older, olderPreparation.roles.map((role) => ({
        ...role,
        navigationSequence: 0,
        tabId
      })));
      const olderTerminal = subject.coordinator.commit(
        effect(olderCommit),
        olderCommit
      );
      await subject.waitForSubmission(1);

      const replacement = prepareAction(`reload-replacement-${ordering}`);
      await expect(prepare(subject, replacement)).resolves.toMatchObject({
        status: "superseded"
      });
      const replacementCleanup = supersedeAction(replacement);

      if (ordering === "newer-cleanup-first") {
        expect(subject.coordinator.supersede(
          effect(replacementCleanup),
          replacementCleanup
        )).toMatchObject({
          roles: [{
            nativeInputResumed: false,
            restartRequired: true,
            status: "indeterminate"
          }],
          status: "indeterminate"
        });
        subject.emitStart("role-1");
        subject.emitFinish("role-1");
        await expect(olderTerminal).resolves.toMatchObject({ status: "applied" });
      } else {
        const olderCleanup = supersedeAction(
          older,
          olderCommit.managedShortcutRetirements
        );
        expect(subject.coordinator.supersede(
          effect(olderCleanup),
          olderCleanup
        )).toMatchObject({
          roles: [{
            nativeInputResumed: false,
            restartRequired: true,
            status: "indeterminate"
          }],
          status: "indeterminate"
        });
        await expect(olderTerminal).resolves.toMatchObject({
          status: "indeterminate"
        });
        expect(subject.coordinator.supersede(
          effect(replacementCleanup),
          replacementCleanup
        )).toMatchObject({
          roles: [{
            nativeInputResumed: false,
            restartRequired: true,
            status: "indeterminate"
          }],
          status: "indeterminate"
        });
        subject.emitRetired("role-1");
      }

      expect(subject.surfaceFences.size).toBe(0);
      subject.coordinator.dispose();
    }
  );
});
