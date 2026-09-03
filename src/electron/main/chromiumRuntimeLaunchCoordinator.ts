import { randomUUID } from "node:crypto";

import type {
  BrowserLaunchAdmissionRecord,
  BrowserRoleStatusRecord,
  CoreAppSnapshotRecord,
  CoreCommand,
  CoreCommandResult,
  DisplayInfoRecord,
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
  readonly settleRuntimeProjection?: () => Promise<number>;
  readonly waitForRuntimeProjection?: (afterSequence: number) => Promise<number>;
  readonly activateRestoredTab?: (
    windowId: string,
    tabId: string
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
  restoreSavedGameWindow?: (window: StateGameWindowRecord) => Promise<void>;
  openEmptySavedGameWindow?: (window: StateGameWindowRecord) => Promise<void>;
}

interface RestoreLaunchTab {
  readonly tabId: string;
  readonly roleSlots: StateGameWindowRecord["tabs"][number]["roleSlots"];
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(
    (value, index) => value === right[index]
  );
}

interface CoherentLaunchSnapshot {
  readonly app: AppSnapshot;
  readonly core: CoreAppSnapshotRecord;
  readonly native: ChromiumRuntimeLaunchNativeSnapshot;
}

interface LaunchWebSurfaceIdentity {
  readonly surfaceId: string;
  readonly slotId: string;
}

interface ResolvedLaunchDestination {
  readonly reason: string;
  readonly target: EmbeddedLaunchTargetRecord;
}

interface PendingTargetCacheRecord {
  readonly admissionTarget: EmbeddedLaunchTargetRecord;
  readonly attemptId: string;
  readonly displayTopologyFingerprint: string;
  readonly displayTopologyRevision: number;
  readonly sourceId: string;
  readonly sourceType: LaunchSourceType;
  readonly tabId: string;
  readonly webSurfaces: readonly LaunchWebSurfaceIdentity[];
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly state: "pending-native-reconciliation";
}

interface ReconciledTargetCacheRecord {
  readonly persistedName?: string;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly state: "reconciled";
}

type TargetCacheRecord = PendingTargetCacheRecord | ReconciledTargetCacheRecord;

interface ValidatedAdmission {
  readonly logicalWindow: CoreAppSnapshotRecord["logicalWindows"][number];
  readonly statuses: BrowserRoleStatusRecord[];
  readonly webSurfaces: readonly LaunchWebSurfaceIdentity[];
}

type WebSurfaceReconciliation = "invalid" | "pending" | "ready";

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

function validWebSurfaceIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function canonicalWebSurfaceIdentities(
  tab: CoreAppSnapshotRecord["browserRuntime"]["tabs"][number],
  sourceType: LaunchSourceType
): LaunchWebSurfaceIdentity[] | null {
  if (sourceType === "role" && tab.webSurfaces.length !== 0) return null;
  const surfaceIds = new Set<string>();
  const slotIds = new Set<string>();
  const identities: LaunchWebSurfaceIdentity[] = [];
  for (const surface of tab.webSurfaces) {
    if (
      !validWebSurfaceIdentity(surface.surfaceId) ||
      !validWebSurfaceIdentity(surface.slotId) ||
      surfaceIds.has(surface.surfaceId) ||
      slotIds.has(surface.slotId)
    ) {
      return null;
    }
    surfaceIds.add(surface.surfaceId);
    slotIds.add(surface.slotId);
    identities.push({
      surfaceId: surface.surfaceId,
      slotId: surface.slotId
    });
  }
  return identities.sort((left, right) =>
    left.surfaceId.localeCompare(right.surfaceId) ||
    left.slotId.localeCompare(right.slotId)
  );
}

function sameWebSurfaceIdentities(
  left: readonly LaunchWebSurfaceIdentity[],
  right: readonly LaunchWebSurfaceIdentity[]
): boolean {
  return left.length === right.length && left.every((surface, index) =>
    surface.surfaceId === right[index]?.surfaceId &&
    surface.slotId === right[index]?.slotId
  );
}

function reconcileNativeWebSurfaces(
  expected: readonly LaunchWebSurfaceIdentity[],
  tabId: string,
  windowId: string,
  native: ChromiumRuntimeLaunchNativeSnapshot
): WebSurfaceReconciliation {
  const nativeBySurfaceId = new Map<
    string,
    ChromiumRuntimeLaunchNativeSnapshot["webSurfaces"][number]
  >();
  for (const surface of native.webSurfaces) {
    if (
      !validWebSurfaceIdentity(surface.surfaceId) ||
      !validWebSurfaceIdentity(surface.slotId) ||
      !validWebSurfaceIdentity(surface.tabId) ||
      !validWebSurfaceIdentity(surface.windowId) ||
      !Number.isSafeInteger(surface.generation) ||
      surface.generation < 1 ||
      nativeBySurfaceId.has(surface.surfaceId)
    ) {
      return "invalid";
    }
    nativeBySurfaceId.set(surface.surfaceId, surface);
  }

  const expectedSurfaceIds = new Set(expected.map((surface) => surface.surfaceId));
  if (native.webSurfaces.some((surface) =>
    surface.tabId === tabId && !expectedSurfaceIds.has(surface.surfaceId)
  )) {
    return "invalid";
  }

  let missing = false;
  for (const identity of expected) {
    const surface = nativeBySurfaceId.get(identity.surfaceId);
    if (!surface) {
      missing = true;
      continue;
    }
    if (
      surface.slotId !== identity.slotId ||
      surface.tabId !== tabId ||
      surface.windowId !== windowId
    ) {
      return "invalid";
    }
  }
  return missing ? "pending" : "ready";
}

function sameBounds(
  left: EmbeddedLaunchTargetRecord["bounds"],
  right: EmbeddedLaunchTargetRecord["bounds"]
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function sameNormalBounds(
  left: EmbeddedLaunchTargetRecord["bounds"],
  right: EmbeddedLaunchTargetRecord["bounds"]
): boolean {
  return Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1 &&
    Math.abs(left.width - right.width) <= 1 &&
    Math.abs(left.height - right.height) <= 1;
}

function safePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameTarget(
  left: EmbeddedLaunchTargetRecord,
  right: EmbeddedLaunchTargetRecord
): boolean {
  return left.windowId === right.windowId &&
    left.persistedName === right.persistedName &&
    left.displayId === right.displayId &&
    left.scaleFactor === right.scaleFactor &&
    left.presentation === right.presentation &&
    sameBounds(left.workArea, right.workArea) &&
    sameNormalBounds(left.bounds, right.bounds);
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

function validBounds(
  bounds: EmbeddedLaunchTargetRecord["bounds"],
  minimumWidth = 1,
  minimumHeight = 1
): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) &&
    bounds.width >= minimumWidth && bounds.height >= minimumHeight &&
    Number.isSafeInteger(bounds.x + bounds.width) &&
    Number.isSafeInteger(bounds.y + bounds.height);
}

function cloneTarget(target: EmbeddedLaunchTargetRecord): EmbeddedLaunchTargetRecord {
  return {
    ...target,
    bounds: { ...target.bounds },
    workArea: { ...target.workArea }
  };
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

function displayById(
  topology: DisplayTopologySnapshotRecord,
  displayId: number
): DisplayInfoRecord | undefined {
  return topology.displays.find((display) => display.id === displayId);
}

function targetMatchesDisplay(
  target: EmbeddedLaunchTargetRecord,
  topology: DisplayTopologySnapshotRecord
): boolean {
  const display = displayById(topology, target.displayId);
  return display !== undefined &&
    display.scaleFactor === target.scaleFactor &&
    sameBounds(display.workArea, target.workArea) &&
    validBounds(target.bounds, 640, 480) &&
    target.bounds.x >= target.workArea.x &&
    target.bounds.y >= target.workArea.y &&
    target.bounds.x + target.bounds.width <= target.workArea.x + target.workArea.width &&
    target.bounds.y + target.bounds.height <= target.workArea.y + target.workArea.height;
}

function displayFingerprintMatches(
  saved: NonNullable<StateGameWindowRecord["targetDisplay"]["fingerprint"]>,
  display: DisplayInfoRecord
): boolean {
  return saved.label === display.label &&
    sameBounds(saved.bounds, display.bounds) &&
    saved.resolution.width === display.resolution.width &&
    saved.resolution.height === display.resolution.height &&
    saved.scaleFactor === display.scaleFactor &&
    saved.isPrimary === display.isPrimary &&
    saved.isInternal === display.isInternal;
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
  #queueTail: Promise<void> = Promise.resolve();
  #queuedLaunches = 0;

  constructor(input: ChromiumRuntimeLaunchCoordinatorInput) {
    this.#input = input;
  }

  launchRole(
    roleId: string,
    destination?: RuntimeLaunchDestinationRequest
  ): Promise<RoleLaunchResult> {
    return this.#enqueue(() => this.#launch(
      requireCanonicalId(roleId, "Role"),
      "role",
      normalizedDestination(destination)
    ).then(({ admission, receipt }) => ({
      launchReceipt: receipt,
      windowId: receipt.windowId,
      status: admission.statuses[0] ?? null
    })));
  }

  launchWorkspace(
    workspaceId: string,
    destination?: RuntimeLaunchDestinationRequest
  ): Promise<WorkspaceLaunchResult> {
    return this.#enqueue(() => this.#launch(
      requireCanonicalId(workspaceId, "Workspace"),
      "workspace",
      normalizedDestination(destination)
    ).then(({ admission, receipt }) => ({
      kind: "launched" as const,
      launchReceipt: receipt,
      windowId: receipt.windowId,
      statuses: admission.statuses
    })));
  }

  restoreSavedGameWindow(window: StateGameWindowRecord): Promise<void> {
    return this.#enqueue(async () => {
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
      for (const [index, tab] of window.tabs.entries()) {
        const sourceType = tab.tabType;
        const result = await this.#launch(
          requireCanonicalId(tab.sourceId, `restore ${sourceType}`),
          sourceType,
          { kind: "game-window", windowId },
          { tabId: tab.id, roleSlots: tab.roleSlots }
        );
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
        await this.#input.activateRestoredTab?.(
          windowId,
          index === window.tabs.length - 1 ? activeTabId : tab.id
        );
        await this.#readCoherentSnapshot();
      }
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
    });
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
      const after = await this.#readCoherentSnapshot();
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
        : storedMatches.length === 1 &&
          JSON.stringify(storedMatches[0]) === JSON.stringify(saved);
      if (
        !sameTopologyRevision(expectedTopology, after.app.displayTopology) ||
        logicalMatches.length !== 1 || runtimeMatches.length !== 1 ||
        liveMatches.length !== 1 || nativeMatches.length !== 1 ||
        !logical || !runtime || !live || !native || !currentTarget ||
        !storedIdentityMatches || !sameTarget(currentTarget, target) ||
        !live.visible || live.tabCount !== 0 ||
        logical.tabs.length !== 0 || logical.activeTabId !== undefined ||
        logical.presentation !== target.presentation ||
        !safePositiveInteger(logical.windowGeneration) ||
        !safePositiveInteger(logical.revision) ||
        runtime.tabIds.length !== 0 || runtime.activeTabId !== undefined ||
        native.tabIds.length !== 0 || native.activeTabId !== "" ||
        native.displayId !== target.displayId ||
        native.presentation !== target.presentation ||
        !sameNormalBounds(native.bounds, target.bounds) ||
        logical.windowGeneration !== native.windowGeneration ||
        logical.revision !== native.topologyRevision
      ) {
        throw launchError(
          "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE",
          "The empty Game Window did not reach one exact visible Core/native topology."
        );
      }
      this.#targets.set(target.windowId, {
        ...(saved === null ? {} : { persistedName: saved.name }),
        windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision,
        state: "reconciled"
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
      throw launchError(
        "ELECTRON_CHROMIUM_EMPTY_WINDOW_COMPENSATION_INDETERMINATE",
        "The failed empty-window registration could not prove exact Core/native retirement."
      );
    } finally {
      this.#targets.delete(windowId);
    }
  }

  #enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    if (this.#queuedLaunches >= MAX_QUEUED_LAUNCHES) {
      return Promise.reject(launchError(
        "ELECTRON_CHROMIUM_LAUNCH_QUEUE_FULL",
        "The ordered Chromium launch queue is full."
      ));
    }
    this.#queuedLaunches += 1;
    const result = this.#queueTail.then(task);
    this.#queueTail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.#queuedLaunches -= 1;
    });
  }

  async #launch(
    sourceId: string,
    sourceType: LaunchSourceType,
    destination: RuntimeLaunchDestinationRequest,
    restore?: RestoreLaunchTab
  ): Promise<{
    admission: BrowserLaunchAdmissionRecord;
    receipt: RoleLaunchResult["launchReceipt"];
  }> {
    let before = await this.#readCoherentSnapshot();
    before = await this.#activateExistingSourceTab(
      before,
      sourceId,
      sourceType
    );
    const resolved = this.#resolveDestination(
      before,
      sourceId,
      sourceType,
      destination,
      restore !== undefined
    );
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
    this.#recordPendingTarget(
      admission,
      validated.logicalWindow,
      resolved.target,
      sourceId,
      sourceType,
      expectedTopology,
      canonicalTopology(expectedTopology),
      validated.webSurfaces
    );
    // One immediate event-bound read is allowed to observe an effect which has
    // already acknowledged. A still-pending native effect leaves only a
    // non-reusable cache entry; no delay, retry, or polling promotes it.
    try {
      await this.#readCoherentSnapshot();
    } catch {
      // The launch admission remains authoritative. A later user intent may
      // promote the target only after a fresh exact Core/native projection.
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

  async #readCoherentSnapshot(): Promise<CoherentLaunchSnapshot> {
    let projectionSequence = await this.#input.settleRuntimeProjection?.() ?? 0;
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
          this.#input.waitForRuntimeProjection
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
      const topologyFingerprint = canonicalTopology(app.displayTopology);
      this.#reconcileTargetCache(core, app, native, topologyFingerprint);
      return { app, core, native };
    }
  }

  #resolveDestination(
    snapshot: CoherentLaunchSnapshot,
    sourceId: string,
    sourceType: LaunchSourceType,
    destination: RuntimeLaunchDestinationRequest,
    allowNonemptySavedWindow = false
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
        target: this.#liveTarget(snapshot, owners[0].windowId)
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
          target: this.#liveTarget(snapshot, live.windowId)
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
        target: this.#liveTarget(snapshot, focused[0].windowId)
      };
    }
    const persistedWindowId = snapshot.core.state.runtimeRestoreSession
      ?.lastFocusedWindowId;
    if (persistedWindowId && snapshot.app.embeddedRuntimeState.windows.some(
      (window) => window.windowId === persistedWindowId
    )) {
      return {
        reason: "last-persisted-focused-live-window",
        target: this.#liveTarget(snapshot, persistedWindowId)
      };
    }
    if (snapshot.app.embeddedRuntimeState.windows.length === 1) {
      return {
        reason: "only-live-window",
        target: this.#liveTarget(
          snapshot,
          snapshot.app.embeddedRuntimeState.windows[0]!.windowId
        )
      };
    }
    return {
      reason: "new-game-window",
      target: this.#newTarget(snapshot)
    };
  }

  #liveTarget(
    snapshot: CoherentLaunchSnapshot,
    windowId: string
  ): EmbeddedLaunchTargetRecord {
    const cached = this.#targets.get(windowId);
    const live = snapshot.app.embeddedRuntimeState.windows.find(
      (window) => window.windowId === windowId
    );
    const logical = snapshot.core.logicalWindows.find(
      (window) => window.windowId === windowId
    );
    if (
      !cached ||
      cached.state !== "reconciled" ||
      !live ||
      !logical ||
      cached.windowGeneration !== logical.windowGeneration ||
      cached.topologyRevision !== logical.revision
    ) {
      throw launchError(
        "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE",
        "The reconciled Chromium window identity is unavailable or stale."
      );
    }
    return this.#currentLiveTarget(
      live,
      snapshot.app.displayTopology,
      cached.persistedName
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
    const display = displayById(topology, saved.targetDisplay.id);
    const fingerprint = saved.targetDisplay.fingerprint;
    if (!display || !fingerprint || !displayFingerprintMatches(fingerprint, display)) {
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
    return { logicalWindow, statuses, webSurfaces };
  }

  #recordPendingTarget(
    admission: BrowserLaunchAdmissionRecord,
    logicalWindow: CoreAppSnapshotRecord["logicalWindows"][number],
    target: EmbeddedLaunchTargetRecord,
    sourceId: string,
    sourceType: LaunchSourceType,
    topology: DisplayTopologySnapshotRecord,
    topologyFingerprint: string,
    webSurfaces: readonly LaunchWebSurfaceIdentity[]
  ): void {
    const prior = this.#targets.get(target.windowId);
    const remainsReconciled = prior?.state === "reconciled" &&
      admission.completion === "completed" &&
      prior.windowGeneration === logicalWindow.windowGeneration &&
      prior.topologyRevision === logicalWindow.revision;
    if (remainsReconciled) {
      this.#targets.set(target.windowId, {
        ...(target.persistedName === undefined
          ? prior.persistedName === undefined ? {} : { persistedName: prior.persistedName }
          : { persistedName: target.persistedName }),
        windowGeneration: logicalWindow.windowGeneration,
        topologyRevision: logicalWindow.revision,
        state: "reconciled"
      });
      return;
    }
    this.#targets.set(target.windowId, {
      admissionTarget: cloneTarget(target),
      attemptId: admission.attemptId,
      displayTopologyFingerprint: topologyFingerprint,
      displayTopologyRevision: topology.revision,
      sourceId,
      sourceType,
      tabId: admission.tabId,
      webSurfaces: webSurfaces.map((surface) => ({ ...surface })),
      windowGeneration: logicalWindow.windowGeneration,
      topologyRevision: logicalWindow.revision,
      state: "pending-native-reconciliation"
    });
  }

  #reconcileTargetCache(
    core: CoreAppSnapshotRecord,
    app: AppSnapshot,
    native: ChromiumRuntimeLaunchNativeSnapshot,
    topologyFingerprint: string
  ): void {
    for (const [windowId, cached] of this.#targets) {
      const live = app.embeddedRuntimeState.windows.find(
        (window) => window.windowId === windowId
      );
      const logical = core.logicalWindows.find((window) => window.windowId === windowId);
      let currentTarget: EmbeddedLaunchTargetRecord | undefined;
      try {
        if (live) {
          currentTarget = this.#currentLiveTarget(
            live,
            app.displayTopology,
            cached.state === "reconciled"
              ? cached.persistedName
              : cached.admissionTarget.persistedName
          );
        }
      } catch {
        currentTarget = undefined;
      }
      if (
        !live ||
        !logical ||
        !currentTarget ||
        logical.windowGeneration !== cached.windowGeneration ||
        !targetMatchesDisplay(currentTarget, app.displayTopology)
      ) {
        this.#targets.delete(windowId);
        continue;
      }
      if (cached.state === "reconciled") {
        if (logical.revision < cached.topologyRevision) {
          this.#targets.delete(windowId);
          continue;
        }
        if (logical.revision > cached.topologyRevision) {
          this.#targets.set(windowId, {
            ...cached,
            topologyRevision: logical.revision
          });
        }
        continue;
      }
      const tab = core.browserRuntime.tabs.find((item) => item.id === cached.tabId);
      const runtimeWindow = core.browserRuntime.windows.find(
        (window) => window.windowId === windowId
      );
      const nativeWindows = native.windows?.filter(
        (window) => window.windowId === windowId
      ) ?? [];
      const nativeWindow = nativeWindows.length === 1 ? nativeWindows[0] : undefined;
      const logicalTabIds = logical.tabs.map((item) => item.id);
      const currentWebSurfaces = tab
        ? canonicalWebSurfaceIdentities(tab, cached.sourceType)
        : null;
      const pendingIdentityMatches =
        logical.revision >= cached.topologyRevision &&
        runtimeWindow !== undefined &&
        nativeWindow !== undefined &&
        nativeWindow.windowGeneration === logical.windowGeneration &&
        nativeWindow.topologyRevision === logical.revision &&
        sameOrderedIds(runtimeWindow.tabIds, logicalTabIds) &&
        sameOrderedIds(nativeWindow.tabIds, logicalTabIds) &&
        tab !== undefined &&
        tab.windowId === windowId &&
        tab.sourceId === cached.sourceId &&
        tab.tabType === cached.sourceType &&
        tab.attemptGeneration === cached.attemptId &&
        currentWebSurfaces !== null &&
        sameWebSurfaceIdentities(currentWebSurfaces, cached.webSurfaces) &&
        app.displayTopology.revision === cached.displayTopologyRevision &&
        topologyFingerprint === cached.displayTopologyFingerprint &&
        currentTarget.displayId === cached.admissionTarget.displayId &&
        currentTarget.scaleFactor === cached.admissionTarget.scaleFactor &&
        currentTarget.presentation === cached.admissionTarget.presentation &&
        sameBounds(currentTarget.workArea, cached.admissionTarget.workArea) &&
        targetMatchesDisplay(currentTarget, app.displayTopology);
      if (!pendingIdentityMatches) {
        this.#targets.delete(windowId);
        continue;
      }
      const webSurfaceReconciliation = reconcileNativeWebSurfaces(
        cached.webSurfaces,
        cached.tabId,
        windowId,
        native
      );
      if (webSurfaceReconciliation === "invalid") {
        this.#targets.delete(windowId);
        continue;
      }
      if (webSurfaceReconciliation === "pending") continue;
      this.#targets.set(windowId, {
        ...(cached.admissionTarget.persistedName === undefined
          ? {}
          : { persistedName: cached.admissionTarget.persistedName }),
        windowGeneration: cached.windowGeneration,
        topologyRevision: logical.revision,
        state: "reconciled"
      });
    }
  }
}
