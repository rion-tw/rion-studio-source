import type {
  AppKitRuntimeEventReceiptRecord,
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord,
  RuntimeTabMoveResultRecord,
  RuntimeWindowProvisionReceiptRecord,
  RuntimeWindowProvisionTargetRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumNewWindowMovePort } from "./chromiumRuntimeActionBackend";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { MacosAppKitRuntimeHostFactoryPort } from
  "./chromiumRuntimeHostFactory";
import type { MacosAppKitRendererActionPort } from
  "./macosAppKitRuntimeEventBridge";

const MAX_RETAINED_MOVE_RECEIPTS = 512;

export interface ChromiumNewWindowTargetResolverPort {
  resolve: (input: Readonly<{
    operationId: string;
    tabId: string;
    sourceWindow: CoreAppSnapshotRecord["logicalWindows"][number];
    sourceNative: ChromiumRuntimeExecutorSnapshot["windows"][number];
  }>) => Promise<RuntimeWindowProvisionTargetRecord>;
}

export interface ChromiumNewWindowMoveControllerInput {
  readonly core: ElectronCoreCommandPort;
  readonly platform: "darwin" | "win32";
  readonly readDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly targets: ChromiumNewWindowTargetResolverPort;
  readonly appKit?: Readonly<{
    factory: MacosAppKitRuntimeHostFactoryPort;
    events: MacosAppKitRendererActionPort;
  }>;
}

interface ExactWindow {
  readonly logical: CoreAppSnapshotRecord["logicalWindows"][number];
  readonly native: ChromiumRuntimeExecutorSnapshot["windows"][number];
}

interface MoveReceiptEntry {
  readonly tabId: string;
  readonly result: RuntimeTabMoveResultRecord;
}

function moveError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactBounds(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function summaryFromAppKit(
  operationId: string,
  targetWindowId: string,
  tabId: string,
  receipt: AppKitRuntimeEventReceiptRecord
): SystemRuntimeOperationSummaryRecord {
  const capturedAt = new Date().toISOString();
  return Object.freeze({
    acceptedAt: capturedAt,
    capturedAt,
    completionPolicy: "eventBound",
    platform: "macos",
    subsystem: "drag",
    status: receipt.status,
    stage: receipt.nativeApplied
      ? "appKitNewWindowMoveApplied"
      : "appKitNewWindowMoveTerminal",
    completionScope: "dragCommitted",
    operationId,
    trigger: "moveGameWindowTabToNewWindow",
    elapsedMs: 0,
    revision: receipt.topologyRevision,
    topologyRevision: receipt.topologyRevision,
    windowGeneration: receipt.windowGeneration,
    windowId: targetWindowId,
    tabId,
    ...(receipt.failureCode === undefined
      ? {}
      : { failureCode: receipt.failureCode })
  });
}

/**
 * Two-phase Core-owned transaction for moving a live tab into a new window.
 * Core allocates the logical ID/generation/revision, the platform factory
 * creates an invisible zero-tab host, then Windows consumes the Core topology
 * effect or macOS enters the privileged AppKit event lane. The committed and
 * persisted destination enters Core's ordinary show/focus transition before
 * the user action becomes terminal.
 */
export class ChromiumNewWindowMoveController
implements ChromiumNewWindowMovePort {
  readonly #input: ChromiumNewWindowMoveControllerInput;
  readonly #receipts = new Map<string, MoveReceiptEntry>();
  readonly #receiptOrder: string[] = [];
  #lane: Promise<void> = Promise.resolve();

  constructor(input: ChromiumNewWindowMoveControllerInput) {
    this.#input = input;
    if ((input.platform === "darwin") !== (input.appKit !== undefined)) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_PLATFORM_INVALID",
        "The new-window move controller lost its platform-native adapter."
      );
    }
  }

  moveTabToNewWindow(
    operationId: string,
    tabId: string
  ): Promise<RuntimeTabMoveResultRecord> {
    const operation = this.#lane.then(() => this.#move(operationId, tabId));
    this.#lane = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #move(
    operationId: string,
    tabId: string
  ): Promise<RuntimeTabMoveResultRecord> {
    const retained = this.#receipts.get(operationId);
    if (retained) {
      if (retained.tabId !== tabId) {
        throw moveError(
          "ELECTRON_CHROMIUM_NEW_WINDOW_OPERATION_REUSED",
          "A new-window move identity was reused for another tab."
        );
      }
      return retained.result;
    }
    const resumed = await this.#input.core.invoke({
      type: "embeddedWindowProvisionResume",
      operationId: operationId + ":provision",
      tabId
    });
    if (resumed) {
      const completed = await this.#resumeCommittedMove(
        operationId,
        tabId,
        resumed
      );
      if (completed) {
        this.#retain(operationId, tabId, completed);
        return completed;
      }
    }
    const source = resumed
      ? await this.#exactWindow(resumed.sourceWindowId)
      : await this.#exactTabOwner(tabId);
    const priorOrder = source.logical.tabs.map((tab) => tab.id);
    const priorHidden = source.logical.tabs.find((tab) => tab.id === tabId)!.hidden;
    const proposed = resumed
      ? this.#proposedTarget(resumed)
      : await this.#input.targets.resolve({
          operationId,
          tabId,
          sourceWindow: source.logical,
          sourceNative: source.native
        });
    const provision = resumed ?? await this.#input.core.invoke({
      type: "embeddedWindowProvisionForTabMove",
      operationId: `${operationId}:provision`,
      tabId,
      sourceWindowId: source.logical.windowId,
      sourceWindowGeneration: source.logical.windowGeneration,
      sourceTopologyRevision: source.logical.revision,
      target: proposed
    });
    if (provision.sourceWindowId !== source.logical.windowId) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_PROVISION_SOURCE_STALE",
        "The retained Core provision receipt no longer matches its exact source owner."
      );
    }
    const target = await this.#exactWindow(provision.target.windowId);
    if (
      target.logical.windowGeneration !== provision.windowGeneration ||
      target.logical.revision !== provision.topologyRevision ||
      target.logical.tabs.length !== 0 || target.native.tabIds.length !== 0 ||
      target.native.visible || target.native.focused
    ) {
      await this.#bestEffortRetire(provision.target.windowId);
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_PROVISION_STALE",
        "The Core/native empty-window provision receipt is not exact."
      );
    }

    let receipt: SystemRuntimeOperationSummaryRecord;
    try {
      receipt = await this.#commitMove(
        `${operationId}:move`,
        tabId,
        source,
        target
      );
    } catch (error) {
      await this.#retireOrQuarantine(provision.target.windowId, source.logical.windowId, error);
      throw error;
    }
    if (receipt.status !== "applied") {
      await this.#retireOrQuarantine(
        provision.target.windowId,
        source.logical.windowId,
        moveError(
          receipt.failureCode ?? "ELECTRON_CHROMIUM_NEW_WINDOW_MOVE_NOT_APPLIED",
          "The Core-owned new-window move did not apply."
        )
      );
      const result = Object.freeze({
        targetWindowId: provision.target.windowId,
        receipt
      });
      this.#retain(operationId, tabId, result);
      return result;
    }

    try {
      await this.#persistTarget(provision.target.windowId, proposed);
      await this.#presentTarget(provision.target.windowId);
    } catch (error) {
      try {
        await this.#rollbackMove(
          `${operationId}:persistence-compensation`,
          tabId,
          source.logical.windowId,
          provision.target.windowId,
          priorOrder,
          priorHidden
        );
        await this.#retireExactEmpty(provision.target.windowId);
      } catch (compensationError) {
        this.#quarantineAppKitHosts(
          [provision.target.windowId, source.logical.windowId],
          compensationError
        );
        throw moveError(
          "ELECTRON_CHROMIUM_NEW_WINDOW_COMPENSATION_FAILED",
          "The new-window move could not restore exact ownership after persistence failed."
        );
      }
      throw error;
    }

    const after = await this.#exactTabOwner(tabId);
    if (after.logical.windowId !== provision.target.windowId) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_OWNER_STALE",
        "The moved tab did not retain its exact Core/native target owner."
      );
    }
    const sourceAfterMove = await this.#exactWindow(source.logical.windowId);
    if (sourceAfterMove.logical.tabs.length === 0) {
      try {
        await this.#retireExactEmpty(source.logical.windowId);
      } catch (error) {
        this.#quarantineAppKitHosts([source.logical.windowId], error);
        receipt = Object.freeze({
          ...receipt,
          status: "indeterminate",
          stage: "newWindowMoveEmptySourceRetireIndeterminate",
          failureCode: "ELECTRON_CHROMIUM_EMPTY_SOURCE_RETIRE_INDETERMINATE"
        });
      }
    }
    const result = Object.freeze({
      targetWindowId: provision.target.windowId,
      receipt
    });
    this.#retain(operationId, tabId, result);
    return result;
  }

  async #resumeCommittedMove(
    operationId: string,
    tabId: string,
    provision: RuntimeWindowProvisionReceiptRecord
  ): Promise<RuntimeTabMoveResultRecord | undefined> {
    const owner = await this.#exactTabOwner(tabId);
    const target = await this.#exactWindow(provision.target.windowId);
    if (owner.logical.windowId === provision.sourceWindowId) {
      if (
        target.logical.tabs.length !== 0 ||
        target.native.tabIds.length !== 0 ||
        target.native.visible ||
        target.native.focused
      ) {
        throw moveError(
          "ELECTRON_CHROMIUM_NEW_WINDOW_RESUME_TARGET_STALE",
          "The retained empty target changed before the ownership move resumed."
        );
      }
      return undefined;
    }
    if (owner.logical.windowId !== provision.target.windowId) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_RESUME_OWNER_STALE",
        "The retained provision no longer fences the tab's exact owner."
      );
    }
    if (
      target.logical.tabs.length !== 1 ||
      target.logical.tabs[0]?.id !== tabId ||
      !exactIds(target.native.tabIds, [tabId])
    ) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_RESUME_TARGET_STALE",
        "The resumed target does not contain the exact provisioned tab."
      );
    }
    await this.#persistTarget(
      provision.target.windowId,
      this.#proposedTarget(provision)
    );
    await this.#presentTarget(provision.target.windowId);
    let receipt = this.#resumedSummary(operationId, tabId, target);
    const source = await this.#maybeExactWindow(provision.sourceWindowId);
    if (source?.logical.tabs.length === 0) {
      try {
        await this.#retireExactEmpty(provision.sourceWindowId);
      } catch (error) {
        this.#quarantineAppKitHosts([provision.sourceWindowId], error);
        receipt = Object.freeze({
          ...receipt,
          status: "indeterminate",
          stage: "newWindowMoveResumeEmptySourceRetireIndeterminate",
          failureCode: "ELECTRON_CHROMIUM_EMPTY_SOURCE_RETIRE_INDETERMINATE"
        });
      }
    }
    return Object.freeze({
      targetWindowId: provision.target.windowId,
      receipt
    });
  }

  #proposedTarget(
    provision: RuntimeWindowProvisionReceiptRecord
  ): RuntimeWindowProvisionTargetRecord {
    return Object.freeze({
      ...(provision.target.persistedName === undefined
        ? {}
        : { persistedName: provision.target.persistedName }),
      displayId: provision.target.displayId,
      scaleFactor: provision.target.scaleFactor,
      workArea: { ...provision.target.workArea },
      bounds: { ...provision.target.bounds },
      presentation: provision.target.presentation
    });
  }

  #resumedSummary(
    operationId: string,
    tabId: string,
    target: ExactWindow
  ): SystemRuntimeOperationSummaryRecord {
    const capturedAt = new Date().toISOString();
    return Object.freeze({
      acceptedAt: capturedAt,
      capturedAt,
      completionPolicy: "eventBound",
      platform: this.#input.platform === "darwin" ? "macos" : "windows",
      subsystem: "drag",
      status: "applied",
      stage: "newWindowMoveResumedFromCoreOwnership",
      completionScope: "dragCommitted",
      operationId: operationId + ":move",
      trigger: "moveGameWindowTabToNewWindow",
      elapsedMs: 0,
      revision: target.logical.revision,
      topologyRevision: target.logical.revision,
      windowGeneration: target.logical.windowGeneration,
      windowId: target.logical.windowId,
      tabId
    });
  }

  async #commitMove(
    operationId: string,
    tabId: string,
    source: ExactWindow,
    target: ExactWindow
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    if (this.#input.platform === "darwin") {
      const hosts = this.#input.appKit!.factory.captureHostObservations([
        target.logical.windowId,
        source.logical.windowId
      ]);
      const native = await this.#input.appKit!.events.moveTab(hosts, {
        sessionId: operationId,
        tabId,
        sourceWindowId: source.logical.windowId,
        targetWindowId: target.logical.windowId,
        orderedTabIds: [tabId]
      });
      return summaryFromAppKit(
        operationId,
        target.logical.windowId,
        tabId,
        native
      );
    }
    return this.#input.core.invoke({
      type: "embeddedTabMove",
      operationId,
      tabId,
      sourceWindowId: source.logical.windowId,
      sourceWindowGeneration: source.logical.windowGeneration,
      sourceTopologyRevision: source.logical.revision,
      targetWindowId: target.logical.windowId,
      targetWindowGeneration: target.logical.windowGeneration,
      targetTopologyRevision: target.logical.revision
    });
  }

  async #rollbackMove(
    operationId: string,
    tabId: string,
    sourceWindowId: string,
    targetWindowId: string,
    priorOrder: readonly string[],
    priorHidden: boolean
  ): Promise<void> {
    const moved = await this.#exactTabOwner(tabId);
    const source = await this.#exactWindow(sourceWindowId);
    if (moved.logical.windowId !== targetWindowId) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_ROLLBACK_STALE",
        "The persistence rollback lost its exact moved-tab owner."
      );
    }
    const nextIndex = priorOrder.indexOf(tabId) + 1;
    const beforeTabId = nextIndex > 0 && nextIndex < priorOrder.length
      ? priorOrder[nextIndex]
      : undefined;
    let summary: SystemRuntimeOperationSummaryRecord;
    if (this.#input.platform === "darwin") {
      const hosts = this.#input.appKit!.factory.captureHostObservations([
        sourceWindowId,
        targetWindowId
      ]);
      summary = summaryFromAppKit(
        operationId,
        sourceWindowId,
        tabId,
        await this.#input.appKit!.events.moveTab(hosts, {
          sessionId: operationId,
          tabId,
          sourceWindowId: targetWindowId,
          targetWindowId: sourceWindowId,
          ...(beforeTabId === undefined ? {} : { beforeTabId }),
          orderedTabIds: priorOrder
        })
      );
    } else {
      summary = await this.#input.core.invoke({
        type: "embeddedTabMove",
        operationId,
        tabId,
        sourceWindowId: moved.logical.windowId,
        sourceWindowGeneration: moved.logical.windowGeneration,
        sourceTopologyRevision: moved.logical.revision,
        targetWindowId: source.logical.windowId,
        targetWindowGeneration: source.logical.windowGeneration,
        targetTopologyRevision: source.logical.revision,
        ...(beforeTabId === undefined ? {} : { beforeTabId })
      });
    }
    if (summary.status !== "applied") {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_ROLLBACK_NOT_APPLIED",
        "The Core/native ownership rollback did not apply."
      );
    }
    if (priorHidden) {
      const owner = await this.#exactTabOwner(tabId);
      if (this.#input.platform === "darwin") {
        const observations = this.#input.appKit!.factory.captureHostObservations([
          sourceWindowId
        ]);
        await this.#input.appKit!.events.setTabHidden(observations, tabId, true);
      } else {
        const hidden = await this.#input.core.invoke({
          type: "embeddedTabHide",
          operationId: `${operationId}:restore-hidden`,
          tabId,
          windowId: sourceWindowId,
          windowGeneration: owner.logical.windowGeneration,
          topologyRevision: owner.logical.revision,
          hidden: true
        });
        if (hidden.status !== "applied") {
          throw moveError(
            "ELECTRON_CHROMIUM_NEW_WINDOW_ROLLBACK_HIDDEN_FAILED",
            "The moved tab's prior hidden state could not be restored."
          );
        }
      }
    }
  }

  async #persistTarget(
    windowId: string,
    target: RuntimeWindowProvisionTargetRecord
  ): Promise<void> {
    const exact = await this.#exactWindow(windowId);
    const display = this.#input.readDisplayTopology().displays.find(
      (candidate) => candidate.id === target.displayId
    );
    if (
      !display || display.scaleFactor !== target.scaleFactor ||
      !exactBounds(display.workArea, target.workArea)
    ) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_DISPLAY_STALE",
        "The detached Game Window display changed before persistence."
      );
    }
    const saved = await this.#input.core.invoke({
      type: "gameWindowSaveRuntime",
      input: {
        windowId,
        name: target.persistedName ?? "Game Window",
        targetDisplay: {
          id: target.displayId,
          fingerprint: {
            label: display.label,
            bounds: { ...display.bounds },
            resolution: { ...display.resolution },
            scaleFactor: display.scaleFactor,
            isPrimary: display.isPrimary,
            isInternal: display.isInternal
          }
        },
        placement: {
          normalBounds: target.bounds,
          savedWorkArea: target.workArea,
          presentation: target.presentation
        },
        tabs: exact.logical.tabs,
        ...(exact.logical.activeTabId === undefined
          ? {}
          : { activeTabId: exact.logical.activeTabId })
      }
    });
    if (saved.id !== windowId) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_PERSISTENCE_RECEIPT_INVALID",
        "Core returned a mismatched saved Game Window receipt."
      );
    }
  }

  async #presentTarget(windowId: string): Promise<void> {
    await this.#input.core.invoke({
      type: "embeddedWindowsShow",
      windowId
    });
    const exact = await this.#exactWindow(windowId);
    if (!exact.native.visible) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_PRESENTATION_INCOMPLETE",
        "The moved tab's new runtime window did not become visible."
      );
    }
  }

  async #retireExactEmpty(windowId: string): Promise<void> {
    const exact = await this.#exactWindow(windowId);
    if (exact.logical.tabs.length !== 0 || exact.native.tabIds.length !== 0) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_RETIRE_NONEMPTY",
        "Only an exact empty runtime window can be retired."
      );
    }
    await this.#input.core.invoke({
      type: "embeddedWindowRetireProvision",
      operationId: `retire:${windowId}:${exact.logical.revision}`,
      windowId,
      windowGeneration: exact.logical.windowGeneration,
      topologyRevision: exact.logical.revision
    });
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const native = this.#input.readNativeSnapshot();
    if (
      core.logicalWindows.some((window) => window.windowId === windowId) ||
      native.windows.some((window) => window.windowId === windowId)
    ) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_RETIRE_RECEIPT_INVALID",
        "The empty runtime-window retirement did not remove both exact owners."
      );
    }
  }

  async #bestEffortRetire(windowId: string): Promise<void> {
    try {
      await this.#retireExactEmpty(windowId);
    } catch {
      // The caller reports the primary stale provision. The exact factory or
      // effect executor already leaves an unknown host generation quarantined.
    }
  }

  async #retireOrQuarantine(
    targetWindowId: string,
    sourceWindowId: string,
    error: unknown
  ): Promise<void> {
    try {
      await this.#retireExactEmpty(targetWindowId);
    } catch (retireError) {
      this.#quarantineAppKitHosts(
        [targetWindowId, sourceWindowId],
        retireError
      );
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_RETIRE_FAILED",
        "The failed new-window move left an unknown host generation quarantined."
      );
    }
    if (this.#input.platform === "darwin") {
      // Keep the original AppKit failure observable after exact compensation.
      void error;
    }
  }

  #quarantineAppKitHosts(windowIds: readonly string[], error: unknown): void {
    if (!this.#input.appKit) return;
    try {
      const observations = this.#input.appKit.factory.captureHostObservations(windowIds);
      for (const observation of observations) {
        this.#input.appKit.factory.quarantineHost(observation.identity, error);
      }
    } catch {
      // A host already removed or poisoned is no longer an active exact owner.
    }
  }

  async #exactTabOwner(tabId: string): Promise<ExactWindow> {
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const owners = core.logicalWindows.filter((window) =>
      window.tabs.some((tab) => tab.id === tabId)
    );
    if (owners.length !== 1) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_TAB_STALE",
        "The tab has no unique Core logical owner."
      );
    }
    return this.#exactWindowFromSnapshot(core, owners[0]!.windowId);
  }

  async #exactWindow(windowId: string): Promise<ExactWindow> {
    return this.#exactWindowFromSnapshot(
      await this.#input.core.invoke({ type: "appSnapshot" }),
      windowId
    );
  }

  async #maybeExactWindow(windowId: string): Promise<ExactWindow | undefined> {
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const logical = core.logicalWindows.find(
      (window) => window.windowId === windowId
    );
    const native = this.#input.readNativeSnapshot().windows.find(
      (window) => window.windowId === windowId
    );
    if (!logical && !native) return undefined;
    if (!logical || !native) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_FENCE_STALE",
        "The Core and native runtime-window ownership fence is incomplete."
      );
    }
    return this.#exactWindowFromSnapshot(core, windowId);
  }

  #exactWindowFromSnapshot(
    core: CoreAppSnapshotRecord,
    windowId: string
  ): ExactWindow {
    const logical = core.logicalWindows.find((window) => window.windowId === windowId);
    const native = this.#input.readNativeSnapshot().windows.find(
      (window) => window.windowId === windowId
    );
    if (
      !logical || !native ||
      logical.windowGeneration !== native.windowGeneration ||
      logical.revision !== native.topologyRevision ||
      !exactIds(logical.tabs.map((tab) => tab.id), native.tabIds)
    ) {
      throw moveError(
        "ELECTRON_CHROMIUM_NEW_WINDOW_FENCE_STALE",
        "The Core and native runtime-window ownership fence is stale."
      );
    }
    return { logical, native };
  }

  #retain(
    operationId: string,
    tabId: string,
    result: RuntimeTabMoveResultRecord
  ): void {
    this.#receipts.set(operationId, { tabId, result });
    this.#receiptOrder.push(operationId);
    while (this.#receiptOrder.length > MAX_RETAINED_MOVE_RECEIPTS) {
      this.#receipts.delete(this.#receiptOrder.shift()!);
    }
  }
}
