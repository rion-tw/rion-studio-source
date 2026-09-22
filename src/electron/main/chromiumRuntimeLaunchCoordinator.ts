import { inspectLaunchWindowFence, type LaunchWindowRevision } from "./chromiumRuntimeLaunchWindowFence";
import { recordRuntimeTransition } from "./runtimeOperationJournal";
import { canonicalWebSurfaceIdentities } from "./chromiumRuntimeLaunchWebIdentity";
import { recordLaunchAdmission, runRecordedLaunch } from "./runtimeLaunchJournal";
import { RuntimeScopedQueue } from "./runtimeScopedQueue";
import { randomUUID } from "node:crypto";

import type {
  BrowserLaunchAdmissionRecord,
  BrowserRoleStatusRecord,
  CoreAppSnapshotRecord,
  CoreCommand,
  CoreCommandResult,
  DisplayTopologySnapshotRecord,
  EmbeddedLaunchTargetRecord,
  RuntimeLaunchDestinationRequest,
  StateGameWindowRecord
} from "../../shared/generated";
import type {
  AppSnapshot,
  RoleLaunchResult,
  WorkspaceLaunchResult
} from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import {
  cloneTarget,
  displayById,
  targetMatchesDisplay,
  sameBounds,
  sameOrderedIds,
  sameNormalBounds,
  validBounds
} from "./chromiumRuntimeLaunchGeometry";

import { displayFingerprintMatches, resolveSavedWindowDisplay } from "./chromiumSavedWindowDisplay";

type MaybePromise<Value> = Value | Promise<Value>;
type LaunchSourceType = "role" | "workspace";

const MAX_QUEUED_LAUNCHES = 64;
const MAX_RETAINED_TARGETS = 256;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ChromiumRuntimeLaunchCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

export interface ChromiumRuntimeLaunchCoordinatorInput {
  readonly core: ChromiumRuntimeLaunchCorePort;
  readonly createId?: () => string;
  /** Presentation snapshots may contain unrelated pending windows. */
  readonly observedSnapshots?: boolean;
  readonly settleWindowNativeEvents?: (windowId: string) => Promise<boolean>;
  readonly settleWindowProjection?: (windowId: string) => Promise<boolean>;
  readonly settleNativeEvents?: () => Promise<void>;
  readonly settleRuntimeProjection?: () => Promise<number>;
  readonly waitForRuntimeProjection?: (afterSequence: number) => Promise<number>;
  readonly beginSavedWindowRestore?: (windowId: string, foreground?: boolean) => void;
  readonly finishSavedWindowRestore?: (
    windowId: string
  ) => MaybePromise<void>;
  readonly activateRestoredTab?: (
    windowId: string,
    tabId: string
  ) => Promise<void>;
  readonly reorderRestoredTab?: (
    windowId: string,
    tabId: string,
    beforeTabId?: string
  ) => Promise<void>;
  /**
   * Commits an existing launch source as the active, visible native tab before
   * Core emits its focus-only effect. The callback owns the platform-specific
   * AppKit/Win32 event lane and must finish from its exact native projection.
   */
  readonly activateExistingTab?: (
    fence: ChromiumRuntimeExistingTabActivationFence
  ) => Promise<void>;
  readonly projectAppSnapshot: (
    core: CoreAppSnapshotRecord,
    native: ChromiumRuntimeLaunchNativeSnapshot,
    displayTopology: DisplayTopologySnapshotRecord
  ) => MaybePromise<AppSnapshot>;
  readonly readDisplayTopology: () => MaybePromise<DisplayTopologySnapshotRecord>;
  readonly readNativeSnapshot: () => ChromiumRuntimeLaunchNativeSnapshot;
  readonly launchCompletions?: ChromiumRuntimeLaunchCompletionPort;
}

export interface ChromiumRuntimeExistingTabActivationFence {
  readonly hidden: boolean;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface ChromiumRuntimeLaunchCompletionPort {
  awaitExact: (expected: Readonly<{
    operationId: string;
    tabId: string;
    sourceId: string;
    sourceType: LaunchSourceType;
  }>) => Promise<Readonly<{
    operationId: string;
    tabId: string;
    sourceId: string;
    sourceType: LaunchSourceType;
    ok: boolean;
    errorCode?: string;
  }>>;
}

export type ChromiumRuntimeLaunchNativeSnapshot = ChromiumRuntimeExecutorSnapshot;

export interface ElectronRuntimeLaunchPort {
  launchRole: (
    roleId: string,
    destination?: RuntimeLaunchDestinationRequest
  ) => Promise<RoleLaunchResult>;
  launchWorkspace: (
    workspaceId: string,
    destination?: RuntimeLaunchDestinationRequest
  ) => Promise<WorkspaceLaunchResult>;
  restoreSavedGameWindow?: (window: StateGameWindowRecord, foreground?: boolean) => Promise<void>;
  openEmptySavedGameWindow?: (window: StateGameWindowRecord) => Promise<void>;
}

interface RestoreLaunchTab {
  readonly tabId: string;
  readonly roleSlots: StateGameWindowRecord["tabs"][number]["roleSlots"];
}


interface CoherentLaunchSnapshot {
  readonly app: AppSnapshot;
  readonly core: CoreAppSnapshotRecord;
  readonly native: ChromiumRuntimeLaunchNativeSnapshot;
}

interface ResolvedLaunchDestination {
  readonly reason: string;
  readonly target: EmbeddedLaunchTargetRecord;
}

interface TargetCacheRecord extends LaunchWindowRevision {
  readonly persistedName?: string;
  readonly state: "observed";
}

interface ValidatedAdmission {
  readonly logicalWindow: CoreAppSnapshotRecord["logicalWindows"][number];
  readonly statuses: BrowserRoleStatusRecord[];
}

function launchError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireCanonicalId(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw launchError(
      "ELECTRON_CHROMIUM_LAUNCH_ID_INVALID",
      `The Chromium launch ${label} identity is invalid.`
    );
  }
  return value;
}

function safePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameTargetEnvelope(
  left: EmbeddedLaunchTargetRecord,
  right: EmbeddedLaunchTargetRecord
): boolean {
  return left.windowId === right.windowId &&
    left.persistedName === right.persistedName &&
    left.displayId === right.displayId &&
    left.scaleFactor === right.scaleFactor &&
    left.presentation === right.presentation &&
    sameBounds(left.workArea, right.workArea);
}

function sameEmptySavedWindowIdentity(
  initial: StateGameWindowRecord,
  current: StateGameWindowRecord,
  target: EmbeddedLaunchTargetRecord,
  topology: DisplayTopologySnapshotRecord
): boolean {
  const initialUpdatedAt = Date.parse(initial.updatedAt);
  const currentUpdatedAt = Date.parse(current.updatedAt);
  if (!Number.isFinite(initialUpdatedAt) || !Number.isFinite(currentUpdatedAt)) return false;
  // Registration may precede the native placement event that upgrades legacy metadata.
  if (JSON.stringify(initial) === JSON.stringify(current) &&
      resolveSavedWindowDisplay(current, topology)?.id === target.displayId) return true;
  const display = displayById(topology, current.targetDisplay.id);
  const fingerprint = current.targetDisplay.fingerprint;
  if (!display || !fingerprint) return false;
  const persistedTarget: EmbeddedLaunchTargetRecord = {
    windowId: current.id,
    persistedName: current.name,
    displayId: current.targetDisplay.id,
    scaleFactor: display.scaleFactor,
    workArea: { ...current.placement.savedWorkArea },
    bounds: { ...current.placement.normalBounds },
    presentation: current.placement.presentation
  };
  return current.id === initial.id && current.name === initial.name &&
    current.createdAt === initial.createdAt && currentUpdatedAt >= initialUpdatedAt &&
    current.tabs.length === 0 && current.activeTabId === undefined &&
    displayFingerprintMatches(fingerprint, display) &&
    sameTargetEnvelope(persistedTarget, target) &&
    targetMatchesDisplay(persistedTarget, topology);
}

function registeredGeometryAccepted(
  initial: EmbeddedLaunchTargetRecord,
  current: EmbeddedLaunchTargetRecord,
  topologyRevision: number
): boolean {
  if (sameNormalBounds(initial.bounds, current.bounds)) return true;
  // The registration projection begins at revision 1. A later revision is
  // exact evidence that Core accepted an authoritative native window-state
  // event, including AppKit's work-area fitting of a newly framed window.
  return topologyRevision > 1;
}

function runtimeWindowAbsent(
  core: CoreAppSnapshotRecord,
  native: ChromiumRuntimeLaunchNativeSnapshot,
  windowId: string
): boolean {
  return !core.logicalWindows.some((window) => window.windowId === windowId) &&
    !core.browserRuntime.windows.some((window) => window.windowId === windowId) &&
    !core.browserRuntime.tabs.some((tab) => tab.windowId === windowId) &&
    !native.windows.some((window) => window.windowId === windowId) &&
    !native.tabs.some((tab) => tab.windowId === windowId) &&
    !native.roles.some((role) => role.windowId === windowId) &&
    !native.webSurfaces.some((surface) => surface.windowId === windowId);
}

function canonicalTopology(topology: DisplayTopologySnapshotRecord): string {
  if (!Number.isSafeInteger(topology.revision) || topology.revision < 1) {
    throw launchError(
      "ELECTRON_CHROMIUM_LAUNCH_TOPOLOGY_INVALID",
      "The Electron display-topology revision is invalid."
    );
  }
  const displayIds = new Set<number>();
  const displays = [...topology.displays].map((display) => {
    if (
      !Number.isSafeInteger(display.id) ||
      displayIds.has(display.id) ||
      !Number.isFinite(display.scaleFactor) ||
      display.scaleFactor <= 0 ||
      display.scaleFactor > 8 ||
      !validBounds(display.bounds) ||
      !validBounds(display.workArea)
    ) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_TOPOLOGY_INVALID",
        "Electron reported an invalid display while resolving a Chromium launch."
      );
    }
    displayIds.add(display.id);
    return {
      id: display.id,
      label: display.label,
      bounds: { ...display.bounds },
      workArea: { ...display.workArea },
      resolution: { ...display.resolution },
      scaleFactor: display.scaleFactor,
      isPrimary: display.isPrimary,
      isInternal: display.isInternal
    };
  }).sort((left, right) => left.id - right.id);
  const primary = displays.filter((display) => display.isPrimary);
  // Core's snapshot sequence is a unique read identity and advances for every
  // projection. State and runtime revisions are the authoritative coherence
  // fences shared by these two sequential reads.
  if (
    primary.length !== 1 ||
    topology.primaryDisplayId !== String(primary[0]!.id)
  ) {
    throw launchError(
      "ELECTRON_CHROMIUM_LAUNCH_TOPOLOGY_INVALID",
      "Electron reported an ambiguous primary display."
    );
  }
  return JSON.stringify({
    primaryDisplayId: topology.primaryDisplayId,
    displays
  });
}

function sameTopologyRevision(
  expected: DisplayTopologySnapshotRecord,
  received: DisplayTopologySnapshotRecord
): boolean {
  return expected.revision === received.revision &&
    canonicalTopology(expected) === canonicalTopology(received);
}

function normalizedDestination(
  destination: RuntimeLaunchDestinationRequest | undefined
): RuntimeLaunchDestinationRequest {
  if (destination === undefined || destination === null) return { kind: "automatic" };
  if (typeof destination !== "object" || Array.isArray(destination)) {
    throw launchError(
      "ELECTRON_CHROMIUM_LAUNCH_DESTINATION_INVALID",
      "The Chromium launch destination is invalid."
    );
  }
  const value = destination as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    (value.kind === "automatic" || value.kind === "new-window") &&
    keys.length === 1 && keys[0] === "kind"
  ) {
    return { kind: value.kind };
  }
  if (
    value.kind === "game-window" &&
    keys.length === 2 && keys[0] === "kind" && keys[1] === "windowId"
  ) {
    return {
      kind: "game-window",
      windowId: requireCanonicalId(value.windowId, "Game Window")
    };
  }
  throw launchError(
    "ELECTRON_CHROMIUM_LAUNCH_DESTINATION_INVALID",
    "The Chromium launch destination contains unsupported fields."
  );
}

function clampBounds(
  bounds: EmbeddedLaunchTargetRecord["bounds"],
  workArea: EmbeddedLaunchTargetRecord["workArea"]
): EmbeddedLaunchTargetRecord["bounds"] {
  if (!validBounds(bounds) || !validBounds(workArea, 640, 480)) {
    throw launchError(
      "ELECTRON_CHROMIUM_SAVED_WINDOW_GEOMETRY_INVALID",
      "The saved Game Window geometry is invalid for Chromium."
    );
  }
  const width = Math.min(Math.max(bounds.width, 640), workArea.width);
  const height = Math.min(Math.max(bounds.height, 480), workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height
  };
}

function validateSnapshotRevisions(
  core: CoreAppSnapshotRecord,
  app: AppSnapshot
): void {
  for (const revision of [
    core.revision,
    core.stateRevision,
    core.runtimeRevision,
    app.revision,
    app.stateRevision,
    app.runtimeRevision
  ]) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_SNAPSHOT_INVALID",
        "Core returned an invalid launch snapshot revision."
      );
    }
  }
  if (
    core.revision !== app.revision ||
    core.stateRevision !== app.stateRevision ||
    core.runtimeRevision !== app.runtimeRevision
  ) {
    throw launchError(
      "ELECTRON_CHROMIUM_LAUNCH_SNAPSHOT_CHANGED",
      "Core or native Chromium topology changed while the launch destination was resolved."
    );
  }
}

export class ChromiumRuntimeLaunchCoordinator implements ElectronRuntimeLaunchPort {
  readonly #input: ChromiumRuntimeLaunchCoordinatorInput;
  readonly #targets = new Map<string, TargetCacheRecord>();
  readonly #observedWindows = new Map<string, LaunchWindowRevision>();
  readonly #quarantinedWindows = new Set<string>();
  readonly #queue = new RuntimeScopedQueue(MAX_QUEUED_LAUNCHES);

  constructor(input: ChromiumRuntimeLaunchCoordinatorInput) {
    this.#input = input;
  }

  launchRole(
    roleId: string,
    destination?: RuntimeLaunchDestinationRequest
  ): Promise<RoleLaunchResult> {
    return this.#enqueue(requestId => this.#launch(
      requireCanonicalId(roleId, "Role"),
      "role",
      normalizedDestination(destination), undefined, requestId
    ).then(({ admission, receipt }) => ({
      launchReceipt: receipt,
      windowId: receipt.windowId,
      status: admission.statuses[0] ?? null
    })), this.#launchScopes("role", roleId, destination));
  }

  launchWorkspace(
    workspaceId: string,
    destination?: RuntimeLaunchDestinationRequest
  ): Promise<WorkspaceLaunchResult> {
    return this.#enqueue(requestId => this.#launch(
      requireCanonicalId(workspaceId, "Workspace"),
      "workspace",
      normalizedDestination(destination), undefined, requestId
    ).then(({ admission, receipt }) => ({
      kind: "launched" as const,
      launchReceipt: receipt,
      windowId: receipt.windowId,
      statuses: admission.statuses
    })), this.#launchScopes("workspace", workspaceId, destination));
  }

  restoreSavedGameWindow(window: StateGameWindowRecord, foreground = false): Promise<void> {
    return this.#enqueue(async requestId => {
      const windowId = requireCanonicalId(window.id, "restore Game Window");
      const tabIds = window.tabs.map((tab) => requireCanonicalId(tab.id, "restore tab"));
      if (new Set(tabIds).size !== tabIds.length) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_TAB_SET_INVALID",
          "The saved Game Window contains duplicate runtime tab identities."
        );
      }
      if (window.tabs.length === 0) {
        throw launchError(
          "ELECTRON_CHROMIUM_EMPTY_WINDOW_PROVISION_REQUIRED",
          "An empty saved Game Window requires the Core host-provision transaction."
        );
      }
      const activeTabId = window.activeTabId === undefined
        ? tabIds.at(-1)!
        : requireCanonicalId(window.activeTabId, "restore active tab");
      if (!tabIds.includes(activeTabId)) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_ACTIVE_TAB_INVALID",
          "The saved Game Window active tab is absent from its exact tab set."
        );
      }
      const beginRestore = this.#input.beginSavedWindowRestore;
      const finishRestore = this.#input.finishSavedWindowRestore;
      const activateRestoredTab = this.#input.activateRestoredTab;
      const reorderRestoredTab = this.#input.reorderRestoredTab;
      if (
        !beginRestore || !finishRestore || !activateRestoredTab ||
        (window.tabs.length > 1 && !reorderRestoredTab)
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_TRANSACTION_UNAVAILABLE",
          "The saved-window restore presentation transaction is unavailable."
        );
      }
      // Core merges each partial restore against the saved ordered cohort. Keep
      // admission in that order, revealing the first tab only for explicit Show.
      // Commit the saved active tab once the complete cohort is hydrated.
      const launchOrder = window.tabs;
      beginRestore(windowId, foreground);
      for (const tab of launchOrder) {
        const sourceType = tab.tabType;
        const result = await this.#launch(
          requireCanonicalId(tab.sourceId, `restore ${sourceType}`),
          sourceType,
          { kind: "game-window", windowId },
          { tabId: tab.id, roleSlots: tab.roleSlots }, requestId
        );
        // An explicit Show claims foreground at admission, never after navigation.
        if (foreground && tab === launchOrder[0]) {
          await this.#readCoherentSnapshot();
          await this.#input.core.invoke({ type: "embeddedWindowsShow", windowId });
        }
        if (result.admission.completion === "pendingNativeCompletion") {
          const completions = this.#input.launchCompletions;
          if (!completions) {
            throw launchError(
              "ELECTRON_CHROMIUM_RESTORE_COMPLETION_STREAM_UNAVAILABLE",
              "The saved-window restore lost its authoritative launch completion stream."
            );
          }
          const completed = await completions.awaitExact({
            operationId: result.admission.operationId,
            tabId: result.admission.tabId,
            sourceId: tab.sourceId,
            sourceType
          });
          if (
            completed.operationId !== result.admission.operationId ||
            completed.tabId !== result.admission.tabId ||
            completed.sourceId !== tab.sourceId ||
            completed.sourceType !== sourceType || !completed.ok
          ) {
            throw launchError(
              completed.errorCode ?? "ELECTRON_CHROMIUM_RESTORE_NATIVE_FAILED",
              "A saved Game Window tab did not reach its exact native launch completion."
            );
          }
        }
        await this.#readCoherentSnapshot();
      }
      if (reorderRestoredTab) {
        for (let index = tabIds.length - 1; index >= 0; index -= 1) {
          const beforeMove = await this.#readCoherentSnapshot();
          const current = beforeMove.core.logicalWindows.find(
            (candidate) => candidate.windowId === windowId
          );
          const currentIds = current?.tabs.map((tab) => tab.id) ?? [];
          const tabIndex = currentIds.indexOf(tabIds[index]!);
          const beforeTabId = tabIds[index + 1];
          const alreadyPlaced = beforeTabId === undefined
            ? tabIndex === currentIds.length - 1
            : tabIndex >= 0 && tabIndex + 1 === currentIds.indexOf(beforeTabId);
          if (alreadyPlaced) continue;
          await reorderRestoredTab(
            windowId,
            tabIds[index]!,
            beforeTabId
          );
          await this.#readCoherentSnapshot();
        }
      }
      const beforeActivation = await this.#readCoherentSnapshot();
      const currentActiveTabId = beforeActivation.core.logicalWindows.find(
        (candidate) => candidate.windowId === windowId
      )?.activeTabId;
      if (currentActiveTabId !== activeTabId) {
        await activateRestoredTab(windowId, activeTabId);
        await this.#readCoherentSnapshot();
      }
      await this.#claimRestoredActiveRoleSlots(window, activeTabId);
      const final = await this.#readCoherentSnapshot();
      const logical = final.core.logicalWindows.find(
        (candidate) => candidate.windowId === windowId
      );
      const native = final.native.windows?.find(
        (candidate) => candidate.windowId === windowId
      );
      if (
        !logical || !native ||
        !sameOrderedIds(logical.tabs.map((tab) => tab.id), tabIds) ||
        !sameOrderedIds(native.tabIds, tabIds) ||
        logical.activeTabId !== activeTabId ||
        native.activeTabId !== activeTabId ||
        logical.windowGeneration !== native.windowGeneration ||
        logical.revision !== native.topologyRevision
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_RECEIPT_STALE",
          "The saved Game Window restore did not reach one exact Core/native topology."
        );
      }
      await finishRestore(windowId);
      const presented = await this.#readCoherentSnapshot();
      const presentedLogical = presented.core.logicalWindows.find(
        (candidate) => candidate.windowId === windowId
      );
      const presentedNative = presented.native.windows?.find(
        (candidate) => candidate.windowId === windowId
      );
      if (
        !presentedLogical || !presentedNative ||
        !sameOrderedIds(presentedLogical.tabs.map((tab) => tab.id), tabIds) ||
        !sameOrderedIds(presentedNative.tabIds, tabIds) ||
        presentedLogical.activeTabId !== activeTabId ||
        presentedNative.activeTabId !== activeTabId ||
        presentedLogical.windowGeneration !== presentedNative.windowGeneration ||
        presentedLogical.revision !== presentedNative.topologyRevision
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_PRESENTATION_STALE",
          "The restored Game Window changed while committing its presentation."
        );
      }
    }, [`window:${window.id}`, ...window.tabs.map(tab => `${tab.tabType}:${tab.sourceId}`)]);
  }

  openEmptySavedGameWindow(window: StateGameWindowRecord): Promise<void> {
    return this.#enqueue(async () => {
      const windowId = requireCanonicalId(window.id, "empty saved Game Window");
      if (window.tabs.length !== 0) {
        throw launchError(
          "ELECTRON_CHROMIUM_EMPTY_WINDOW_TABS_PRESENT",
          "Only a dormant saved Game Window with no tabs may use empty-host registration."
        );
      }
      const before = await this.#readCoherentSnapshot();
      const saved = before.core.state.gameWindows.find(
        (candidate) => candidate.id === windowId
      );
      if (
        !saved || saved.tabs.length !== 0 ||
        JSON.stringify(saved) !== JSON.stringify(window) ||
        before.core.logicalWindows.some((candidate) => candidate.windowId === windowId) ||
        before.app.embeddedRuntimeState.windows.some(
          (candidate) => candidate.windowId === windowId
        )
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_EMPTY_WINDOW_SAVED_FENCE_STALE",
          "The empty saved Game Window changed or became live before registration."
        );
      }
      const target = this.#savedTarget(saved, before.app.displayTopology);
      await this.#registerEmptyWindow(before, target, saved);
    });
  }

  async #claimRestoredActiveRoleSlots(
    window: StateGameWindowRecord,
    activeTabId: string
  ): Promise<void> {
    const activeTab = window.tabs.find((tab) => tab.id === activeTabId)!;
    const seenRoleIds = new Set<string>();
    for (const slot of activeTab.roleSlots) {
      if (seenRoleIds.has(slot.roleId)) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_ROLE_SET_INVALID",
          "The saved active tab contains a duplicate Role ownership target."
        );
      }
      seenRoleIds.add(slot.roleId);
      const before = await this.#readCoherentSnapshot();
      const coreRole = before.core.browserRuntime.roles.find(
        (role) => role.roleId === slot.roleId
      );
      const nativeRole = before.native.roles.find(
        (role) => role.roleId === slot.roleId
      );
      if (!coreRole) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_ROLE_OWNER_MISSING",
          "The saved active tab Role has no authoritative runtime owner."
        );
      }
      const coreAlreadyOwned = coreRole.owner.tabId === activeTabId &&
        coreRole.owner.slotId === slot.slotId;
      const nativeAlreadyOwned = nativeRole?.tabId === activeTabId &&
        nativeRole.windowId === window.id &&
        nativeRole.ownerGeneration === coreRole.owner.generation;
      if (coreAlreadyOwned && nativeAlreadyOwned) continue;
      if (coreAlreadyOwned || nativeAlreadyOwned) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_ROLE_OWNER_STALE",
          "The saved active tab Role has a divergent Core/native ownership fence."
        );
      }
      const expectedOwnerGeneration = coreRole.owner.generation;
      const claimed = await this.#input.core.invoke({
        type: "browserRoleSlotClaim",
        tabId: activeTabId,
        slotId: slot.slotId,
        expectedOwnerGeneration
      });
      const claimedOwner = claimed.roles.find(
        (role) => role.roleId === slot.roleId
      )?.owner;
      if (
        !claimedOwner || claimedOwner.tabId !== activeTabId ||
        claimedOwner.slotId !== slot.slotId ||
        claimedOwner.generation <= expectedOwnerGeneration
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_ROLE_CLAIM_STALE",
          "Core did not commit the saved active tab Role ownership claim."
        );
      }
      const after = await this.#readCoherentSnapshot();
      const afterCore = after.core.browserRuntime.roles.find(
        (role) => role.roleId === slot.roleId
      );
      const afterNative = after.native.roles.find(
        (role) => role.roleId === slot.roleId
      );
      if (
        afterCore?.owner.tabId !== activeTabId ||
        afterCore.owner.slotId !== slot.slotId ||
        afterCore.owner.generation !== claimedOwner.generation ||
        afterNative?.tabId !== activeTabId ||
        afterNative.windowId !== window.id ||
        afterNative.ownerGeneration !== claimedOwner.generation
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_RESTORE_ROLE_CLAIM_STALE",
          "The saved active tab Role claim did not reach one exact Core/native owner."
        );
      }
    }
  }

  openEmptyTransientGameWindow(
    target: EmbeddedLaunchTargetRecord
  ): Promise<void> {
    const exactTarget = cloneTarget(target);
    return this.#enqueue(async () => {
      const windowId = requireCanonicalId(
        exactTarget.windowId,
        "empty transient Game Window"
      );
      if (exactTarget.persistedName !== undefined) {
        throw launchError(
          "ELECTRON_CHROMIUM_TRANSIENT_WINDOW_NAME_INVALID",
          "A transient New Game Window cannot carry a persisted name."
        );
      }
      const before = await this.#readCoherentSnapshot();
      if (
        before.core.state.gameWindows.some((window) => window.id === windowId) ||
        before.core.browserRuntime.windows.some(
          (window) => window.windowId === windowId
        ) ||
        before.core.logicalWindows.some((window) => window.windowId === windowId) ||
        before.app.embeddedRuntimeState.windows.some(
          (window) => window.windowId === windowId
        ) ||
        before.native.windows.some((window) => window.windowId === windowId)
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_TRANSIENT_WINDOW_ID_COLLISION",
          "The transient New Game Window identity is already owned."
        );
      }
      await this.#registerEmptyWindow(before, exactTarget, null);
    });
  }

  async #registerEmptyWindow(
    before: CoherentLaunchSnapshot,
    target: EmbeddedLaunchTargetRecord,
    saved: StateGameWindowRecord | null
  ): Promise<void> {
    if (!targetMatchesDisplay(target, before.app.displayTopology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_EMPTY_WINDOW_TARGET_INVALID",
        "The empty Game Window target does not match the exact display topology."
      );
    }
    if (!this.#targets.has(target.windowId) &&
      this.#targets.size >= MAX_RETAINED_TARGETS) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_TARGET_CAPACITY",
        "The Chromium launch target registry is full."
      );
    }
    const expectedTopology = before.app.displayTopology;
    const preRegistrationTopology = await this.#input.readDisplayTopology();
    if (!sameTopologyRevision(expectedTopology, preRegistrationTopology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_EMPTY_WINDOW_DISPLAY_CHANGED",
        "The display topology changed before Core could register the empty Game Window."
      );
    }
    await this.#input.core.invoke({
      type: "embeddedWindowRegister",
      target: cloneTarget(target)
    });
    try {
      const postRegistrationTopology = await this.#input.readDisplayTopology();
      if (!sameTopologyRevision(expectedTopology, postRegistrationTopology)) {
        throw launchError(
          "ELECTRON_CHROMIUM_EMPTY_WINDOW_DISPLAY_CHANGED",
          "The display topology changed after Core registered the empty Game Window."
        );
      }
      let after = await this.#readCoherentSnapshot();
      try {
        // Registration can emit a native placement event whose Core revision
        // precedes its chrome projection. Wait only for this host's admitted
        // work, as ordinary live-target admission already does.
        if (inspectLaunchWindowFence(after.core, after.native, target.windowId).reason !== null) {
          after = await this.#awaitLiveTarget(after, target.windowId);
        }
      } catch (error) {
        if (error instanceof RionBridgeError && error.code === "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE") {
          throw launchError("ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE",
            "The empty Game Window did not reach one exact visible Core/native topology.");
        }
        throw error;
      }
      const logicalMatches = after.core.logicalWindows.filter(
        (window) => window.windowId === target.windowId
      );
      const runtimeMatches = after.core.browserRuntime.windows.filter(
        (window) => window.windowId === target.windowId
      );
      const liveMatches = after.app.embeddedRuntimeState.windows.filter(
        (window) => window.windowId === target.windowId
      );
      const nativeMatches = after.native.windows.filter(
        (window) => window.windowId === target.windowId
      );
      const storedMatches = after.core.state.gameWindows.filter(
        (window) => window.id === target.windowId
      );
      const logical = logicalMatches[0];
      const runtime = runtimeMatches[0];
      const live = liveMatches[0];
      const native = nativeMatches[0];
      const currentTarget = live
        ? this.#currentLiveTarget(
            live,
            after.app.displayTopology,
            saved?.name
          )
        : undefined;
      const storedIdentityMatches = saved === null
        ? storedMatches.length === 0
        : storedMatches.length === 1 && storedMatches[0] !== undefined &&
          sameEmptySavedWindowIdentity(
            saved,
            storedMatches[0],
            target,
            after.app.displayTopology
          );
      if (
        !sameTopologyRevision(expectedTopology, after.app.displayTopology) ||
        logicalMatches.length !== 1 || runtimeMatches.length !== 1 ||
        liveMatches.length !== 1 || nativeMatches.length !== 1 ||
        !logical || !runtime || !live || !native || !currentTarget ||
        !storedIdentityMatches || !sameTargetEnvelope(currentTarget, target) ||
        !registeredGeometryAccepted(target, currentTarget, logical.revision) ||
        !live.visible || live.tabCount !== 0 ||
        logical.tabs.length !== 0 || logical.activeTabId !== undefined ||
        logical.presentation !== target.presentation ||
        !safePositiveInteger(logical.windowGeneration) ||
        !safePositiveInteger(logical.revision) ||
        runtime.tabIds.length !== 0 || runtime.activeTabId !== undefined ||
        native.tabIds.length !== 0 || native.activeTabId !== "" ||
        native.displayId !== target.displayId ||
        native.presentation !== target.presentation ||
        !sameNormalBounds(native.bounds, currentTarget.bounds) ||
        logical.windowGeneration !== native.windowGeneration ||
        logical.revision !== native.topologyRevision
      ) {
        recordRuntimeTransition({ operationId: randomUUID(), action: "empty-window-receipt",
          targetKind: "window", targetId: target.windowId, stage: "rejected",
          errorCode: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE",
          fences: { ...inspectLaunchWindowFence(after.core, after.native, target.windowId).fences,
            storedIdentity: Number(storedIdentityMatches),
            targetEnvelope: Number(!!currentTarget && sameTargetEnvelope(currentTarget, target)),
            registeredGeometry: Number(!!currentTarget && !!logical && registeredGeometryAccepted(target, currentTarget, logical.revision)),
            nativeBounds: Number(!!native && !!currentTarget && sameNormalBounds(native.bounds, currentTarget.bounds)),
            visible: Number(live?.visible === true) } });
        throw launchError(
          "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE",
          "The empty Game Window did not reach one exact visible Core/native topology."
        );
      }
      this.#targets.set(target.windowId, {
        ...(saved === null ? {} : { persistedName: saved.name }),
        windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision,
        state: "observed"
      });
    } catch (error) {
      this.#targets.delete(target.windowId);
      await this.#compensateEmptyWindowRegistration(target.windowId);
      throw error;
    }
  }

  async #compensateEmptyWindowRegistration(windowId: string): Promise<void> {
    try {
      const before = await this.#input.core.invoke({ type: "appSnapshot" });
      const beforeNative = this.#input.readNativeSnapshot();
      if (runtimeWindowAbsent(before, beforeNative, windowId)) return;

      const logicalMatches = before.logicalWindows.filter(
        (window) => window.windowId === windowId
      );
      const logical = logicalMatches[0];
      if (
        logicalMatches.length !== 1 || !logical ||
        logical.tabs.length !== 0 || logical.activeTabId !== undefined ||
        !safePositiveInteger(logical.windowGeneration) ||
        !safePositiveInteger(logical.revision)
      ) {
        throw new Error("The failed registration has no exact empty logical owner.");
      }

      try {
        await this.#input.core.invoke({
          type: "embeddedWindowRetireProvision",
          operationId: randomUUID(),
          windowId,
          windowGeneration: logical.windowGeneration,
          topologyRevision: logical.revision
        });
      } catch {
        // A rejected acknowledgement may still follow an applied Core effect.
        // The exact post-state read below decides whether compensation completed.
      }
      const after = await this.#input.core.invoke({ type: "appSnapshot" });
      const afterNative = this.#input.readNativeSnapshot();
      if (!runtimeWindowAbsent(after, afterNative, windowId)) {
        throw new Error("The failed registration still has a Core or native owner.");
      }
    } catch {
      this.#quarantinedWindows.add(windowId);
      throw launchError(
        "ELECTRON_CHROMIUM_EMPTY_WINDOW_COMPENSATION_INDETERMINATE",
        "The failed empty-window registration could not prove exact Core/native retirement."
      );
    } finally {
      this.#targets.delete(windowId);
    }
  }

  #launchScopes(source: LaunchSourceType, id: string, destination?: RuntimeLaunchDestinationRequest): string[] {
    return [`${source}:${id}`, ...(destination?.kind === "game-window" ? [`window:${destination.windowId}`] : [])];
  }

  #enqueue<Result>(task: (requestId: string) => Promise<Result>, scopes: readonly string[] = ["admission"]): Promise<Result> {
    return runRecordedLaunch(this.#queue, scopes, task);
  }

  async #launch(
    sourceId: string,
    sourceType: LaunchSourceType,
    destination: RuntimeLaunchDestinationRequest,
    restore?: RestoreLaunchTab,
    requestId?: string
  ): Promise<{
    admission: BrowserLaunchAdmissionRecord;
    receipt: RoleLaunchResult["launchReceipt"];
  }> {
    let before = await this.#readCoherentSnapshot();
    let resolved = this.#resolveDestination(
      before,
      sourceId,
      sourceType,
      destination,
      restore !== undefined,
      false
    );
    if (before.app.embeddedRuntimeState.windows.some(window => window.windowId === resolved.target.windowId)) {
      before = await this.#awaitLiveTarget(before, resolved.target.windowId);
      before = await this.#activateExistingSourceTab(before, sourceId, sourceType);
      resolved = { ...resolved, target: this.#liveTarget(before, resolved.target.windowId) };
    }
    if (!this.#targets.has(resolved.target.windowId) &&
      this.#targets.size >= MAX_RETAINED_TARGETS) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_TARGET_CAPACITY",
        "The Chromium launch target registry is full."
      );
    }
    const expectedTopology = before.app.displayTopology;
    const preAdmissionTopology = await this.#input.readDisplayTopology();
    if (!sameTopologyRevision(expectedTopology, preAdmissionTopology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_DISPLAY_CHANGED",
        "The Electron display topology changed before Core could admit the Chromium launch."
      );
    }
    const admission = sourceType === "role"
      ? await this.#input.core.invoke({
          type: "browserRoleLaunch",
          roleId: sourceId,
          target: cloneTarget(resolved.target),
          ...(restore === undefined ? {} : {
            launchTabId: restore.tabId,
            restoreRoleSlots: restore.roleSlots
          })
        })
      : await this.#input.core.invoke({
          type: "browserWorkspaceLaunch",
          workspaceId: sourceId,
          target: cloneTarget(resolved.target),
          ...(restore === undefined ? {} : {
            launchTabId: restore.tabId,
            restoreRoleSlots: restore.roleSlots
          })
        });
    recordLaunchAdmission(admission, requestId, resolved.target.windowId);
    const afterTopology = await this.#input.readDisplayTopology();
    if (!sameTopologyRevision(expectedTopology, afterTopology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_DISPLAY_CHANGED",
        "The Electron display topology changed after Core admitted the Chromium launch."
      );
    }
    const afterCore = await this.#input.core.invoke({ type: "appSnapshot" });
    const validated = this.#validateAdmission(
      admission,
      afterCore,
      sourceId,
      sourceType,
      resolved.target,
      restore !== undefined
    );
    this.#rememberTarget(validated.logicalWindow, resolved.target);
    // Observe an already acknowledged effect without making cached admission
    // metadata a prerequisite for later host reuse.
    try {
      await this.#readCoherentSnapshot(false);
    } catch {
      // A later intent still validates fresh exact Core/native identities.
    }
    const existingTabId = admission.completion === "completed" &&
      (admission.disposition === "existing" || admission.disposition === "joined")
      ? admission.tabId
      : undefined;
    return {
      admission: { ...admission, statuses: validated.statuses },
      receipt: {
        intentId: admission.operationId,
        status: "applied",
        destinationReason: resolved.reason,
        windowId: resolved.target.windowId,
        windowGeneration: validated.logicalWindow.windowGeneration,
        topologyRevision: validated.logicalWindow.revision,
        ...(existingTabId === undefined ? {} : { existingTabId })
      }
    };
  }

  async #activateExistingSourceTab(
    before: CoherentLaunchSnapshot,
    sourceId: string,
    sourceType: LaunchSourceType
  ): Promise<CoherentLaunchSnapshot> {
    const owners = before.core.logicalWindows.flatMap((window) =>
      window.tabs
        .filter((tab) => tab.tabType === sourceType && tab.sourceId === sourceId)
        .map((tab) => ({ tab, window }))
    );
    if (owners.length > 1) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_OWNER_DIVERGED",
        "Core reported the launch source in more than one logical Chromium tab."
      );
    }
    const owner = owners[0];
    if (
      !owner ||
      (!owner.tab.hidden && owner.window.activeTabId === owner.tab.id)
    ) {
      return before;
    }
    if (!this.#input.activateExistingTab) {
      throw launchError(
        "ELECTRON_CHROMIUM_EXISTING_TAB_ACTIVATION_UNAVAILABLE",
        "The existing launch source has no platform-native tab activation lane."
      );
    }
    const fence = Object.freeze({
      hidden: owner.tab.hidden,
      tabId: owner.tab.id,
      topologyRevision: owner.window.revision,
      windowGeneration: owner.window.windowGeneration,
      windowId: owner.window.windowId
    });
    await this.#input.activateExistingTab(fence);
    const after = await this.#readCoherentSnapshot();
    const exactWindow = after.core.logicalWindows.find(
      (window) => window.windowId === fence.windowId
    );
    const exactTab = exactWindow?.tabs.find((tab) => tab.id === fence.tabId);
    if (
      !exactWindow || !exactTab || exactTab.hidden ||
      exactWindow.activeTabId !== fence.tabId ||
      exactWindow.windowGeneration !== fence.windowGeneration ||
      exactWindow.revision <= fence.topologyRevision
    ) {
      throw launchError(
        "ELECTRON_CHROMIUM_EXISTING_TAB_ACTIVATION_STALE",
        "The existing launch source did not reach one exact active Core/native projection."
      );
    }
    return after;
  }

  async #readCoherentSnapshot(waitForProjection = true): Promise<CoherentLaunchSnapshot> {
    // Presentation reads are observational; exact mutation fences stay target-local.
    if (waitForProjection && !this.#input.observedSnapshots) await this.#input.settleNativeEvents?.();
    let projectionSequence = waitForProjection && !this.#input.observedSnapshots
      ? await this.#input.settleRuntimeProjection?.() ?? 0 : 0;
    while (true) {
      const core = await this.#input.core.invoke({ type: "appSnapshot" });
      const displayTopology = await this.#input.readDisplayTopology();
      const native = this.#input.readNativeSnapshot();
      let app: AppSnapshot;
      try {
        app = await this.#input.projectAppSnapshot(
          core,
          native,
          displayTopology
        );
      } catch (error) {
        if (
          error instanceof RionBridgeError &&
          error.code === "ELECTRON_RUNTIME_PROJECTION_NOT_READY" &&
          waitForProjection && !this.#input.observedSnapshots && this.#input.waitForRuntimeProjection
        ) {
          projectionSequence = await this.#input.waitForRuntimeProjection(
            projectionSequence
          );
          continue;
        }
        throw error;
      }
      validateSnapshotRevisions(core, app);
      if (!sameTopologyRevision(displayTopology, app.displayTopology)) {
        throw launchError(
          "ELECTRON_CHROMIUM_LAUNCH_SNAPSHOT_CHANGED",
          "The display topology changed while the Chromium launch snapshot was projected."
        );
      }
      for (const id of new Set([...this.#targets.keys(), ...this.#observedWindows.keys(), ...this.#quarantinedWindows])) {
        if (!core.logicalWindows.some(window => window.windowId === id)) {
          this.#targets.delete(id);
          this.#observedWindows.delete(id);
          if (runtimeWindowAbsent(core, native, id)) this.#quarantinedWindows.delete(id);
        }
      }
      return { app, core, native };
    }
  }

  #resolveDestination(
    snapshot: CoherentLaunchSnapshot,
    sourceId: string,
    sourceType: LaunchSourceType,
    destination: RuntimeLaunchDestinationRequest,
    allowNonemptySavedWindow = false,
    validateLive = true
  ): ResolvedLaunchDestination {
    const owners = snapshot.app.embeddedRuntimeState.tabs.filter(
      (tab) => tab.type === sourceType && tab.sourceId === sourceId
    );
    if (owners.length > 1) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_OWNER_DIVERGED",
        "Core reported the launch source in more than one live Chromium tab."
      );
    }
    if (owners[0]) {
      return {
        reason: "existing-source-window",
        target: this.#liveTarget(snapshot, owners[0].windowId, validateLive)
      };
    }

    if (destination.kind === "new-window") {
      return {
        reason: "requested-new-game-window",
        target: this.#newTarget(snapshot)
      };
    }
    if (destination.kind === "game-window") {
      const live = snapshot.app.embeddedRuntimeState.windows.find(
        (window) => window.windowId === destination.windowId
      );
      if (live) {
        return {
          reason: "requested-live-game-window",
          target: this.#liveTarget(snapshot, live.windowId, validateLive)
        };
      }
      const saved = snapshot.core.state.gameWindows.find(
        (window) => window.id === destination.windowId
      );
      if (!saved) {
        throw launchError(
          "ELECTRON_CHROMIUM_LAUNCH_TARGET_NOT_FOUND",
          "The requested Game Window was not found."
        );
      }
      if (saved.tabs.length !== 0 && !allowNonemptySavedWindow) {
        throw launchError(
          "ELECTRON_CHROMIUM_SAVED_WINDOW_RESTORE_UNSUPPORTED",
          "Electron cannot launch into a nonempty dormant saved Game Window until exact hydration is migrated."
        );
      }
      return {
        reason: "requested-empty-saved-game-window",
        target: this.#savedTarget(saved, snapshot.app.displayTopology)
      };
    }

    const focused = snapshot.app.embeddedRuntimeState.windows.filter(
      (window) => window.focused === true
    );
    if (focused.length > 1 || (focused[0] && !focused[0].visible)) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_FOCUS_INVALID",
        "Electron reported an ambiguous focused runtime window."
      );
    }
    if (focused[0]) {
      return {
        reason: "last-native-focused-live-window",
        target: this.#liveTarget(snapshot, focused[0].windowId, validateLive)
      };
    }
    const persistedWindowId = snapshot.core.state.runtimeRestoreSession
      ?.lastFocusedWindowId;
    if (persistedWindowId && snapshot.app.embeddedRuntimeState.windows.some(
      (window) => window.windowId === persistedWindowId
    )) {
      return {
        reason: "last-persisted-focused-live-window",
        target: this.#liveTarget(snapshot, persistedWindowId, validateLive)
      };
    }
    if (snapshot.app.embeddedRuntimeState.windows.length === 1) {
      return {
        reason: "only-live-window",
        target: this.#liveTarget(
          snapshot,
          snapshot.app.embeddedRuntimeState.windows[0]!.windowId,
          validateLive
        )
      };
    }
    return {
      reason: "new-game-window",
      target: this.#newTarget(snapshot)
    };
  }

  async #awaitLiveTarget(snapshot: CoherentLaunchSnapshot, windowId: string): Promise<CoherentLaunchSnapshot> {
    const generation = snapshot.core.logicalWindows.find(window => window.windowId === windowId)?.windowGeneration;
    while (true) {
      // Include already-received AppKit events before looking only at emitted effects.
      const nativeEvents = await this.#input.settleWindowNativeEvents?.(windowId) ?? false;
      const projection = await this.#input.settleWindowProjection?.(windowId) ?? false;
      // Re-read even when a receipt finished between the initial snapshot and the fence.
      snapshot = await this.#readCoherentSnapshot(false);
      if (snapshot.core.logicalWindows.find(window => window.windowId === windowId)?.windowGeneration !== generation) {
        throw launchError("ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE",
          "The requested window closed or changed generation before launch admission.");
      }
      try { this.#liveTarget(snapshot, windowId, true, {
        waitedNativeEvents: Number(nativeEvents), waitedProjection: Number(projection)
      }); return snapshot; }
      catch (error) {
        if (!(error instanceof RionBridgeError) || error.code !== "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE") throw error;
        // A completion may enqueue a successor projection. Only that actual work
        // permits another read; no polling or elapsed-time reconciliation.
        if (nativeEvents || projection) continue;
        // The snapshot RPC can admit a placement projection after the fences
        // above. Capture that exact host's newly admitted work before rejecting.
        const lateNativeEvents = await this.#input.settleWindowNativeEvents?.(windowId) ?? false;
        const lateProjection = await this.#input.settleWindowProjection?.(windowId) ?? false;
        if (lateNativeEvents || lateProjection) continue;
        throw error;
      }
    }
  }

  #liveTarget(
    snapshot: CoherentLaunchSnapshot,
    windowId: string,
    validate = true,
    waitEvidence: Readonly<Record<string, number>> = {}
  ): EmbeddedLaunchTargetRecord {
    const cached = this.#targets.get(windowId);
    const live = snapshot.app.embeddedRuntimeState.windows.find(
      (window) => window.windowId === windowId
    );
    const logical = snapshot.core.logicalWindows.find(
      (window) => window.windowId === windowId
    );
    const inspection = inspectLaunchWindowFence(snapshot.core, snapshot.native, windowId,
      this.#observedWindows.get(windowId), this.#quarantinedWindows.has(windowId));
    if (!live || !logical || (validate && inspection.reason !== null)) {
      recordRuntimeTransition({ operationId: randomUUID(), action: "launch-window-fence",
        targetKind: "window", targetId: windowId, stage: "rejected",
        errorCode: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE",
        fences: { ...inspection.fences, ...waitEvidence, cacheState: cached?.state ?? "absent",
          cacheGeneration: cached?.windowGeneration ?? -1, cacheRevision: cached?.topologyRevision ?? -1 } });
      throw launchError("ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE",
        "The requested window has not applied its exact Core topology; unrelated windows remain available.");
    }
    if (validate) this.#observedWindows.set(windowId, {
      windowGeneration: logical.windowGeneration, topologyRevision: logical.revision
    });

    return this.#currentLiveTarget(
      live,
      snapshot.app.displayTopology,
      cached?.persistedName ??
        snapshot.core.state.gameWindows.find(window => window.id === windowId)?.name
    );
  }

  #currentLiveTarget(
    live: AppSnapshot["embeddedRuntimeState"]["windows"][number],
    topology: DisplayTopologySnapshotRecord,
    persistedName?: string
  ): EmbeddedLaunchTargetRecord {
    const display = displayById(topology, live.displayId);
    if (!display) {
      throw launchError(
        "ELECTRON_CHROMIUM_LIVE_WINDOW_DISPLAY_UNAVAILABLE",
        "The live Chromium window is attached to an unavailable display."
      );
    }
    const target: EmbeddedLaunchTargetRecord = {
      windowId: live.windowId,
      ...(persistedName === undefined ? {} : { persistedName }),
      displayId: display.id,
      scaleFactor: display.scaleFactor,
      workArea: { ...display.workArea },
      bounds: { ...live.bounds },
      presentation: live.presentation
    };
    if (!targetMatchesDisplay(target, topology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_LIVE_WINDOW_GEOMETRY_INVALID",
        "The current Chromium window geometry is outside its exact display work area."
      );
    }
    return target;
  }

  #newTarget(snapshot: CoherentLaunchSnapshot): EmbeddedLaunchTargetRecord {
    const topology = snapshot.app.displayTopology;
    const primaryId = Number(topology.primaryDisplayId);
    const display = displayById(topology, primaryId);
    if (!display || !display.isPrimary || !validBounds(display.workArea, 640, 480)) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_DISPLAY_UNAVAILABLE",
        "Electron did not report a launchable primary display."
      );
    }
    const existingOnDisplay = snapshot.core.state.gameWindows.filter(
      (window) => window.targetDisplay.id === display.id
    ).length;
    const width = Math.min(
      display.workArea.width,
      Math.max(Math.round(display.workArea.width * 0.8), 960)
    );
    const height = Math.min(
      display.workArea.height,
      Math.max(Math.round(display.workArea.height * 0.8), 640)
    );
    const cascade = Math.min(existingOnDisplay * 24, 240);
    const maximumX = display.workArea.x + display.workArea.width - width;
    const maximumY = display.workArea.y + display.workArea.height - height;
    const target: EmbeddedLaunchTargetRecord = {
      windowId: requireCanonicalId(
        (this.#input.createId ?? randomUUID)(),
        "new Game Window"
      ),
      displayId: display.id,
      scaleFactor: display.scaleFactor,
      workArea: { ...display.workArea },
      bounds: {
        x: Math.min(
          display.workArea.x + Math.floor((display.workArea.width - width) / 2) + cascade,
          maximumX
        ),
        y: Math.min(
          display.workArea.y + Math.floor((display.workArea.height - height) / 2) + cascade,
          maximumY
        ),
        width,
        height
      },
      presentation: "normal"
    };
    if (!targetMatchesDisplay(target, topology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_GEOMETRY_INVALID",
        "Electron could not resolve exact Chromium launch geometry."
      );
    }
    return target;
  }

  #savedTarget(
    saved: StateGameWindowRecord,
    topology: DisplayTopologySnapshotRecord
  ): EmbeddedLaunchTargetRecord {
    requireCanonicalId(saved.id, "saved Game Window");
    const display = resolveSavedWindowDisplay(saved, topology);
    if (!display) {
      throw launchError(
        "ELECTRON_CHROMIUM_SAVED_WINDOW_DISPLAY_UNAVAILABLE",
        "The saved Game Window display identity is unavailable or changed."
      );
    }
    const target: EmbeddedLaunchTargetRecord = {
      windowId: saved.id,
      persistedName: saved.name,
      displayId: display.id,
      scaleFactor: display.scaleFactor,
      workArea: { ...display.workArea },
      bounds: clampBounds(saved.placement.normalBounds, display.workArea),
      presentation: saved.placement.presentation
    };
    if (!targetMatchesDisplay(target, topology)) {
      throw launchError(
        "ELECTRON_CHROMIUM_SAVED_WINDOW_GEOMETRY_INVALID",
        "The saved Game Window target is outside its exact display work area."
      );
    }
    return target;
  }

  #validateAdmission(
    admission: BrowserLaunchAdmissionRecord,
    snapshot: CoreAppSnapshotRecord,
    sourceId: string,
    sourceType: LaunchSourceType,
    target: EmbeddedLaunchTargetRecord,
    restoring: boolean
  ): ValidatedAdmission {
    requireCanonicalId(admission.operationId, "operation");
    requireCanonicalId(admission.attemptId, "attempt");
    requireCanonicalId(admission.tabId, "tab");
    if (
      admission.operationId === admission.attemptId ||
      !(["existing", "admitted", "joined"] as const).includes(admission.disposition) ||
      !(["pendingNativeCompletion", "completed"] as const).includes(admission.completion) ||
      (admission.completion === "pendingNativeCompletion" &&
        admission.disposition !== "admitted") ||
      (restoring && admission.disposition !== "admitted") ||
      (!restoring && admission.completion === "completed" &&
        admission.disposition === "admitted")
    ) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_ADMISSION_INVALID",
        "Core returned an inconsistent Chromium launch admission."
      );
    }
    const tab = snapshot.browserRuntime.tabs.find((item) => item.id === admission.tabId);
    const window = snapshot.browserRuntime.windows.find(
      (item) => item.windowId === target.windowId
    );
    const logicalWindow = snapshot.logicalWindows.find(
      (item) => item.windowId === target.windowId
    );
    if (
      !tab ||
      !window ||
      !logicalWindow ||
      tab.sourceId !== sourceId ||
      tab.tabType !== sourceType ||
      tab.windowId !== target.windowId ||
      !window.tabIds.includes(tab.id) ||
      !logicalWindow.tabs.some((item) => item.id === tab.id) ||
      !Number.isSafeInteger(logicalWindow.windowGeneration) ||
      logicalWindow.windowGeneration < 1 ||
      !Number.isSafeInteger(logicalWindow.revision) ||
      logicalWindow.revision < 1 ||
      (admission.completion === "pendingNativeCompletion" &&
        tab.attemptGeneration !== admission.attemptId)
    ) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_ADMISSION_IDENTITY_MISMATCH",
        "Core did not retain the exact Chromium launch tab and window identity."
      );
    }
    const statusRoleIds = new Set<string>();
    const workspaceRoleIds = sourceType === "workspace"
      ? new Set(snapshot.state.launchWorkspaces
          .find((workspace) => workspace.id === sourceId)
          ?.slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []) ?? [])
      : null;
    const statuses = admission.statuses.map((status) => {
      requireCanonicalId(status.roleId, "status Role");
      if (
        statusRoleIds.has(status.roleId) ||
        (sourceType === "role" && status.roleId !== sourceId) ||
        (workspaceRoleIds !== null && !workspaceRoleIds.has(status.roleId))
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_LAUNCH_STATUS_IDENTITY_MISMATCH",
          "Core returned a Chromium launch status outside the admitted source."
        );
      }
      statusRoleIds.add(status.roleId);
      return { ...status };
    });
    if (sourceType === "role" && statuses.length > 1) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_STATUS_IDENTITY_MISMATCH",
        "Core returned duplicate Role statuses for one Chromium launch."
      );
    }
    const webSurfaces = canonicalWebSurfaceIdentities(tab, sourceType);
    if (!webSurfaces) {
      throw launchError(
        "ELECTRON_CHROMIUM_LAUNCH_WEB_SURFACE_IDENTITY_MISMATCH",
        "Core returned malformed, duplicated, or role-owned Web surface identities."
      );
    }
    return { logicalWindow, statuses };
  }

  #rememberTarget(
    logicalWindow: CoreAppSnapshotRecord["logicalWindows"][number],
    target: EmbeddedLaunchTargetRecord
  ): void {
    const observed = this.#observedWindows.get(target.windowId);
    if (!observed || observed.windowGeneration !== logicalWindow.windowGeneration ||
        observed.topologyRevision < logicalWindow.revision) this.#observedWindows.set(target.windowId, {
      windowGeneration: logicalWindow.windowGeneration, topologyRevision: logicalWindow.revision
    });
    this.#targets.set(target.windowId, {
      ...(target.persistedName === undefined ? {} : { persistedName: target.persistedName }),
      windowGeneration: logicalWindow.windowGeneration,
      topologyRevision: logicalWindow.revision,
      state: "observed"
    });
  }
}
