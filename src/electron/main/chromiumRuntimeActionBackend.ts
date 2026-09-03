import type {
  AppKitRuntimeEventReceiptRecord,
  CoreAppSnapshotRecord,
  RuntimeTabMoveResultRecord,
  RuntimeWindowPreferencesRecord,
  StateGameWindowRecord,
  SystemRuntimeOperationStatus,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type {
  AnyAuthenticatedChromiumRuntimeAction,
  AnyChromiumRuntimeActionReceipt,
  ChromiumRuntimeActionBackend,
  ChromiumRuntimeActionKind,
  ChromiumRuntimeActionResultMap,
  ChromiumRuntimeActionStatus
} from "./chromiumRuntimeActionController";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import type { MacosAppKitRuntimeHostFactoryPort } from
  "./chromiumRuntimeHostFactory";
import type { MacosAppKitRendererActionPort } from
  "./macosAppKitRuntimeEventBridge";
import type { ChromiumQuickAccessRequestPort } from
  "./chromiumQuickAccessRequestController";
import type { ChromiumRuntimeWindowPreferencesProjectionPort } from
  "./chromiumRuntimeFullscreenToolbar";

const MAX_RETAINED_ACTION_RECEIPTS = 512;

export interface ChromiumSavedWindowActionPort {
  openEmpty: (windowId: string) => Promise<void>;
  restore: (
    input: Extract<
      AnyAuthenticatedChromiumRuntimeAction["action"],
      { type: "restoreSavedGameWindows" }
    >["input"]
  ) => Promise<void>;
  discard: (
    input: Extract<
      AnyAuthenticatedChromiumRuntimeAction["action"],
      { type: "discardSavedGameWindows" }
    >["input"]
  ) => Promise<void>;
}

export interface ChromiumNewWindowMovePort {
  moveTabToNewWindow: (
    operationId: string,
    tabId: string
  ) => Promise<RuntimeTabMoveResultRecord>;
}

export interface ChromiumRuntimeActionBackendInput {
  readonly core: ElectronCoreCommandPort;
  readonly platform: "darwin" | "win32";
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly appKit?: Readonly<{
    factory: MacosAppKitRuntimeHostFactoryPort;
    events: MacosAppKitRendererActionPort;
  }>;
  readonly savedWindows: ChromiumSavedWindowActionPort;
  readonly newWindowMoves: ChromiumNewWindowMovePort;
  readonly quickAccess: ChromiumQuickAccessRequestPort;
  readonly windowPreferences: ChromiumRuntimeWindowPreferencesProjectionPort;
}

interface CoherentWindowFence {
  readonly core: CoreAppSnapshotRecord;
  readonly logical: CoreAppSnapshotRecord["logicalWindows"][number];
  readonly native: ChromiumRuntimeExecutorSnapshot["windows"][number];
}

interface RetainedReceipt {
  readonly fingerprint: string;
  readonly receipt: AnyChromiumRuntimeActionReceipt;
}

function backendError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function exactStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function platformName(platform: "darwin" | "win32"): "macos" | "windows" {
  return platform === "darwin" ? "macos" : "windows";
}

function terminalSummary(input: Readonly<{
  platform: "darwin" | "win32";
  operationId: string;
  trigger: string;
  subsystem: SystemRuntimeOperationSummaryRecord["subsystem"];
  completionScope: SystemRuntimeOperationSummaryRecord["completionScope"];
  status?: SystemRuntimeOperationStatus;
  stage: string;
  windowId?: string;
  tabId?: string;
  windowGeneration?: number;
  topologyRevision?: number;
  failureCode?: string;
}>): SystemRuntimeOperationSummaryRecord {
  const capturedAt = new Date().toISOString();
  return Object.freeze({
    acceptedAt: capturedAt,
    capturedAt,
    completionPolicy: "eventBound",
    platform: platformName(input.platform),
    subsystem: input.subsystem,
    status: input.status ?? "applied",
    stage: input.stage,
    completionScope: input.completionScope,
    operationId: input.operationId,
    trigger: input.trigger,
    elapsedMs: 0,
    ...(input.windowId === undefined ? {} : { windowId: input.windowId }),
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    ...(input.windowGeneration === undefined
      ? {}
      : { windowGeneration: input.windowGeneration }),
    ...(input.topologyRevision === undefined
      ? {}
      : { revision: input.topologyRevision, topologyRevision: input.topologyRevision }),
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode })
  });
}

function summaryFromAppKit(
  platform: "darwin" | "win32",
  operationId: string,
  trigger: string,
  subsystem: SystemRuntimeOperationSummaryRecord["subsystem"],
  completionScope: SystemRuntimeOperationSummaryRecord["completionScope"],
  windowId: string,
  tabId: string | undefined,
  receipt: AppKitRuntimeEventReceiptRecord
): SystemRuntimeOperationSummaryRecord {
  return terminalSummary({
    platform,
    operationId,
    trigger,
    subsystem,
    completionScope,
    status: receipt.status,
    stage: receipt.nativeApplied
      ? "appKitRuntimeActionApplied"
      : "appKitRuntimeActionTerminal",
    windowId,
    ...(tabId === undefined ? {} : { tabId }),
    windowGeneration: receipt.windowGeneration,
    topologyRevision: receipt.topologyRevision,
    ...(receipt.failureCode === undefined ? {} : { failureCode: receipt.failureCode })
  });
}

/**
 * Executes authenticated renderer intents against an exact Core/native fence.
 * The outer receipt is idempotent; domain failure remains in the returned
 * System Runtime summary and is never promoted from elapsed time.
 */
export class CoreOwnedChromiumRuntimeActionBackend
implements ChromiumRuntimeActionBackend {
  readonly #input: ChromiumRuntimeActionBackendInput;
  readonly #receipts = new Map<string, RetainedReceipt>();
  readonly #receiptOrder: string[] = [];
  readonly #lastSequenceByRenderer = new Map<string, number>();
  #windowPreferencesLane: Promise<void> = Promise.resolve();

  constructor(input: ChromiumRuntimeActionBackendInput) {
    this.#input = input;
    if ((input.platform === "darwin") !== (input.appKit !== undefined)) {
      throw backendError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_PLATFORM_INVALID",
        "The runtime action backend lost its platform-native host adapter."
      );
    }
  }

  async execute(
    intent: AnyAuthenticatedChromiumRuntimeAction
  ): Promise<AnyChromiumRuntimeActionReceipt> {
    const fingerprint = JSON.stringify(intent.action);
    const retained = this.#receipts.get(intent.intentId);
    if (retained) {
      if (retained.fingerprint !== fingerprint) {
        throw backendError(
          "ELECTRON_CHROMIUM_RUNTIME_ACTION_ID_REUSED",
          "A runtime action identity was reused for a different payload."
        );
      }
      return Object.freeze({ ...retained.receipt, status: "duplicate" });
    }
    const lastSequence = this.#lastSequenceByRenderer.get(intent.rendererInstanceId) ?? 0;
    if (
      !Number.isSafeInteger(intent.adapterSequence) || intent.adapterSequence <= lastSequence ||
      !Number.isSafeInteger(intent.rendererGeneration) || intent.rendererGeneration < 1
    ) {
      throw backendError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_SEQUENCE_STALE",
        "The authenticated runtime action sequence is stale."
      );
    }
    this.#lastSequenceByRenderer.set(intent.rendererInstanceId, intent.adapterSequence);
    const value = await this.#dispatch(intent);
    const status = value.status;
    const receipt = Object.freeze({
      intentId: intent.intentId,
      adapterSequence: intent.adapterSequence,
      rendererInstanceId: intent.rendererInstanceId,
      rendererGeneration: intent.rendererGeneration,
      actionType: intent.action.type,
      status,
      value: value.value
    }) as AnyChromiumRuntimeActionReceipt;
    this.#retain(intent.intentId, fingerprint, receipt);
    return receipt;
  }

  async #dispatch(intent: AnyAuthenticatedChromiumRuntimeAction): Promise<Readonly<{
    status: ChromiumRuntimeActionStatus;
    value: ChromiumRuntimeActionResultMap[ChromiumRuntimeActionKind];
  }>> {
    const { action } = intent;
    switch (action.type) {
      case "updateGameWindow":
        return this.#applied(await this.#updateGameWindow(
          action.windowId,
          action.input
        ));
      case "showGameWindow": {
        return {
          status: await this.#showWindow(action.windowId),
          value: undefined
        };
      }
      case "hideGameWindow": {
        const summary = await this.#setWindowVisibility(intent.intentId, action.windowId, false);
        return { status: this.#status(summary.status), value: summary };
      }
      case "stopGameWindow": {
        const summary = await this.#stopWindow(intent, action.windowId, false);
        return { status: this.#status(summary.status), value: summary };
      }
      case "deleteGameWindow": {
        const summary = await this.#stopWindow(intent, action.windowId, true);
        return { status: this.#status(summary.status), value: summary };
      }
      case "showGameWindowTab": {
        const summary = await this.#activateTab(intent.intentId, action.tabId);
        return { status: this.#status(summary.status), value: summary };
      }
      case "moveGameWindowTab": {
        const summary = await this.#moveTab(
          intent.intentId,
          action.tabId,
          action.windowId
        );
        return { status: this.#status(summary.status), value: summary };
      }
      case "moveGameWindowTabToNewWindow": {
        const receipt = await this.#input.newWindowMoves.moveTabToNewWindow(
          intent.intentId,
          action.tabId
        );
        return { status: this.#status(receipt.receipt.status), value: receipt };
      }
      case "reorderGameWindowTab": {
        const summary = await this.#reorderTab(
          intent.intentId,
          action.tabId,
          action.beforeTabId
        );
        return { status: this.#status(summary.status), value: summary };
      }
      case "setGameWindowTabMuted": {
        const summary = await this.#input.core.invoke({
          type: "browserTabAudioMute",
          tabId: action.tabId,
          muted: action.muted
        });
        return { status: this.#status(summary.status), value: summary };
      }
      case "setGameWindowTabHidden": {
        const summary = await this.#setTabHidden(
          intent.intentId,
          action.tabId,
          action.hidden
        );
        return { status: this.#status(summary.status), value: summary };
      }
      case "stopGameWindowTab": {
        const summary = await this.#stopTab(intent, action.tabId);
        return { status: this.#status(summary.status), value: summary };
      }
      case "restoreSavedGameWindows":
        await this.#input.savedWindows.restore(action.input);
        return this.#applied(undefined);
      case "discardSavedGameWindows":
        await this.#input.savedWindows.discard(action.input);
        return this.#applied(undefined);
      case "updateRuntimeWindowPreferences":
        return this.#applied(await this.#updateWindowPreferencesOrdered(
          action.preferences
        ));
      case "consumePendingQuickAccessRequest":
        return this.#applied(this.#input.quickAccess.consumePending());
      case "presentQuickAccessRequest":
        return this.#applied(await this.#input.quickAccess.present(action.requestId));
      case "resolveQuickAccessRequest": {
        const restoreTabId = await this.#input.quickAccess.resolve(
          action.requestId,
          action.resolution
        );
        if (restoreTabId !== null) {
          await this.#activateTab(
            intent.intentId + ":restore-quick-access-origin",
            restoreTabId
          );
          const restored = await this.#coherentTab(restoreTabId);
          // Selection alone is not a process-global focus request on AppKit.
          // Re-enter Core's existing EventBound show/focus transition so the
          // exact origin host becomes key only after its native focus event.
          await this.#input.core.invoke({
            type: "embeddedWindowsShow",
            windowId: restored.logical.windowId
          });
        }
        return this.#applied(undefined);
      }
    }
  }

  #applied<Value>(value: Value): Readonly<{
    status: "applied";
    value: Value;
  }> {
    return Object.freeze({ status: "applied", value });
  }

  #status(status: SystemRuntimeOperationStatus): ChromiumRuntimeActionStatus {
    return status === "superseded" ? "superseded" : "applied";
  }

  async #coherentWindow(windowId: string): Promise<CoherentWindowFence> {
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const logical = core.logicalWindows.find((window) => window.windowId === windowId);
    const native = this.#input.readNativeSnapshot().windows.find(
      (window) => window.windowId === windowId
    );
    if (
      !logical || !native ||
      logical.windowGeneration !== native.windowGeneration ||
      logical.revision !== native.topologyRevision ||
      logical.presentation !== native.presentation ||
      !exactStringArrays(logical.tabs.map((tab) => tab.id), native.tabIds)
    ) {
      throw backendError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_WINDOW_STALE",
        "The Core and native Game Window fence is stale."
      );
    }
    return { core, logical, native };
  }

  async #coherentTab(tabId: string): Promise<CoherentWindowFence> {
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const owners = core.logicalWindows.filter((window) =>
      window.tabs.some((tab) => tab.id === tabId)
    );
    if (owners.length !== 1) {
      throw backendError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_TAB_STALE",
        "The runtime tab has no exact Core window owner."
      );
    }
    return this.#coherentWindow(owners[0]!.windowId);
  }

  #appKitObservations(windowIds: readonly string[]) {
    const observations = this.#input.appKit!.factory.captureHostObservations(windowIds);
    if (observations.length !== windowIds.length) {
      throw backendError(
        "ELECTRON_MACOS_APPKIT_ACTION_OBSERVATION_STALE",
        "The AppKit action did not capture every exact host observation."
      );
    }
    return observations;
  }

  async #showWindow(windowId: string): Promise<ChromiumRuntimeActionStatus> {
    const snapshot = await this.#input.core.invoke({ type: "appSnapshot" });
    if (!snapshot.logicalWindows.some((window) => window.windowId === windowId)) {
      const dormant = snapshot.state.gameWindows.find(
        (window) => window.id === windowId
      );
      if (dormant) {
        if (dormant.tabs.length === 0) {
          await this.#input.savedWindows.openEmpty(windowId);
        } else {
          await this.#input.savedWindows.restore({ scope: "window", windowId });
        }
      }
    }
    await this.#input.core.invoke({
      type: "embeddedWindowsShow",
      windowId
    });
    return "applied";
  }

  async #setWindowVisibility(
    operationId: string,
    windowId: string,
    visible: boolean
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const fence = await this.#coherentWindow(windowId);
    if (this.#input.platform === "darwin") {
      const receipt = await this.#input.appKit!.events.setWindowVisibility(
        this.#appKitObservations([windowId]),
        visible
      );
      return summaryFromAppKit(
        this.#input.platform,
        operationId,
        visible ? "showGameWindow" : "hideGameWindow",
        "presentation",
        "nativeAcknowledgement",
        windowId,
        undefined,
        receipt
      );
    }
    return this.#input.core.invoke({
      type: "embeddedWindowVisibility",
      operationId,
      windowId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision,
      visible
    });
  }

  async #activateTab(
    operationId: string,
    tabId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const fence = await this.#coherentTab(tabId);
    if (this.#input.platform === "darwin") {
      const receipt = await this.#input.appKit!.events.activateTab(
        this.#appKitObservations([fence.logical.windowId]),
        tabId
      );
      return summaryFromAppKit(
        this.#input.platform,
        operationId,
        "showGameWindowTab",
        "tabActivation",
        "topologyCommitted",
        fence.logical.windowId,
        tabId,
        receipt
      );
    }
    return this.#input.core.invoke({
      type: "embeddedTabActivate",
      operationId,
      tabId,
      windowId: fence.logical.windowId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision
    });
  }

  async #setTabHidden(
    operationId: string,
    tabId: string,
    hidden: boolean
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const fence = await this.#coherentTab(tabId);
    if (this.#input.platform === "darwin") {
      const receipt = await this.#input.appKit!.events.setTabHidden(
        this.#appKitObservations([fence.logical.windowId]),
        tabId,
        hidden
      );
      return summaryFromAppKit(
        this.#input.platform,
        operationId,
        "setGameWindowTabHidden",
        "tabMutation",
        "topologyCommitted",
        fence.logical.windowId,
        tabId,
        receipt
      );
    }
    return this.#input.core.invoke({
      type: "embeddedTabHide",
      operationId,
      tabId,
      windowId: fence.logical.windowId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision,
      hidden
    });
  }

  async #reorderTab(
    operationId: string,
    tabId: string,
    beforeTabId?: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const fence = await this.#coherentTab(tabId);
    if (beforeTabId !== undefined && !fence.logical.tabs.some(
      (tab) => tab.id === beforeTabId
    )) {
      throw backendError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_REORDER_STALE",
        "The reorder target is not an exact sibling tab."
      );
    }
    if (this.#input.platform === "darwin") {
      const receipt = await this.#input.appKit!.events.reorderTab(
        this.#appKitObservations([fence.logical.windowId]),
        tabId,
        beforeTabId
      );
      return summaryFromAppKit(
        this.#input.platform,
        operationId,
        "reorderGameWindowTab",
        "drag",
        "dragCommitted",
        fence.logical.windowId,
        tabId,
        receipt
      );
    }
    return this.#input.core.invoke({
      type: "embeddedTabReorder",
      operationId,
      tabId,
      windowId: fence.logical.windowId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision,
      ...(beforeTabId === undefined ? {} : { beforeTabId })
    });
  }

  async #moveTab(
    operationId: string,
    tabId: string,
    targetWindowId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const source = await this.#coherentTab(tabId);
    const target = targetWindowId === source.logical.windowId
      ? source
      : await this.#coherentWindow(targetWindowId);
    const beforeTabId: string | undefined = undefined;
    let summary: SystemRuntimeOperationSummaryRecord;
    if (this.#input.platform === "darwin") {
      const targetOrder = target.logical.tabs
        .filter((tab) => !tab.hidden && tab.id !== tabId)
        .map((tab) => tab.id);
      targetOrder.push(tabId);
      const receipt = await this.#input.appKit!.events.moveTab(
        this.#appKitObservations(
          source.logical.windowId === targetWindowId
            ? [targetWindowId]
            : [targetWindowId, source.logical.windowId]
        ),
        {
          sessionId: operationId,
          tabId,
          sourceWindowId: source.logical.windowId,
          targetWindowId,
          orderedTabIds: targetOrder
        }
      );
      summary = summaryFromAppKit(
        this.#input.platform,
        operationId,
        "moveGameWindowTab",
        "drag",
        "dragCommitted",
        targetWindowId,
        tabId,
        receipt
      );
    } else {
      summary = await this.#input.core.invoke({
        type: "embeddedTabMove",
        operationId,
        tabId,
        sourceWindowId: source.logical.windowId,
        sourceWindowGeneration: source.logical.windowGeneration,
        sourceTopologyRevision: source.logical.revision,
        targetWindowId,
        targetWindowGeneration: target.logical.windowGeneration,
        targetTopologyRevision: target.logical.revision,
        ...(beforeTabId === undefined ? {} : { beforeTabId })
      });
    }
    if (
      summary.status === "applied" &&
      source.logical.windowId !== targetWindowId
    ) {
      try {
        await this.#retireEmptyMovedSource(operationId, source.logical.windowId);
      } catch (error) {
        if (this.#input.appKit) {
          try {
            for (const observation of this.#input.appKit.factory
              .captureHostObservations([source.logical.windowId])) {
              this.#input.appKit.factory.quarantineHost(
                observation.identity,
                error
              );
            }
          } catch {
            // A source host already removed from AppKit has no live native
            // generation left to quarantine.
          }
        }
        return terminalSummary({
          platform: this.#input.platform,
          operationId,
          trigger: "moveGameWindowTab",
          subsystem: "drag",
          completionScope: "dragCommitted",
          status: "indeterminate",
          stage: "moveEmptySourceRetireIndeterminate",
          windowId: targetWindowId,
          tabId,
          windowGeneration: summary.windowGeneration,
          topologyRevision: summary.topologyRevision,
          failureCode:
            "ELECTRON_CHROMIUM_MOVE_EMPTY_SOURCE_RETIRE_INDETERMINATE"
        });
      }
    }
    return summary;
  }

  async #retireEmptyMovedSource(
    operationId: string,
    sourceWindowId: string
  ): Promise<void> {
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const logical = core.logicalWindows.find(
      (window) => window.windowId === sourceWindowId
    );
    const native = this.#input.readNativeSnapshot().windows.find(
      (window) => window.windowId === sourceWindowId
    );
    if (!logical && !native) return;
    if (
      !logical || !native ||
      logical.windowGeneration !== native.windowGeneration ||
      logical.revision !== native.topologyRevision ||
      !exactStringArrays(logical.tabs.map((tab) => tab.id), native.tabIds)
    ) {
      throw backendError(
        "ELECTRON_CHROMIUM_MOVE_EMPTY_SOURCE_STALE",
        "The moved tab left an incoherent source Game Window."
      );
    }
    if (logical.tabs.length > 0) return;
    await this.#input.core.invoke({
      type: "embeddedWindowRetireProvision",
      operationId: `${operationId}:retire-empty-source`,
      windowId: sourceWindowId,
      windowGeneration: logical.windowGeneration,
      topologyRevision: logical.revision
    });
    const afterCore = await this.#input.core.invoke({ type: "appSnapshot" });
    const afterNative = this.#input.readNativeSnapshot();
    if (
      afterCore.logicalWindows.some((window) => window.windowId === sourceWindowId) ||
      afterNative.windows.some((window) => window.windowId === sourceWindowId)
    ) {
      throw backendError(
        "ELECTRON_CHROMIUM_MOVE_EMPTY_SOURCE_RETIRE_INCOMPLETE",
        "The empty source Game Window did not reach exact native retirement."
      );
    }
  }

  async #stopTab(
    intent: AnyAuthenticatedChromiumRuntimeAction,
    tabId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const fence = await this.#coherentTab(tabId);
    const tab = fence.logical.tabs.find((candidate) => candidate.id === tabId)!;
    if (this.#input.platform === "darwin") {
      const remaining = fence.logical.tabs
        .filter((candidate) => !candidate.hidden && candidate.id !== tabId)
        .map((candidate) => candidate.id);
      const receipt = await this.#input.appKit!.events.stopTab(
        this.#appKitObservations([fence.logical.windowId]),
        tabId,
        remaining
      );
      return summaryFromAppKit(
        this.#input.platform,
        intent.intentId,
        "stopGameWindowTab",
        "tabMutation",
        "nativeDestroyed",
        fence.logical.windowId,
        tabId,
        receipt
      );
    }
    await this.#input.core.invoke({
      type: "embeddedTabStop",
      request: {
        operationId: intent.intentId,
        mutationKind: "stop",
        tabId,
        sourceWindowId: fence.logical.windowId,
        sourceWindowGeneration: fence.logical.windowGeneration,
        lifecycleEpoch: intent.adapterSequence
      },
      sourceId: tab.sourceId,
      tabType: tab.tabType
    });
    return terminalSummary({
      platform: this.#input.platform,
      operationId: intent.intentId,
      trigger: "stopGameWindowTab",
      subsystem: "tabMutation",
      completionScope: "nativeDestroyed",
      stage: "runtimeTabStopped",
      windowId: fence.logical.windowId,
      tabId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision
    });
  }

  async #stopWindow(
    intent: AnyAuthenticatedChromiumRuntimeAction,
    windowId: string,
    deleteWindow: boolean
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const core = await this.#input.core.invoke({ type: "appSnapshot" });
    const logical = core.logicalWindows.find((window) => window.windowId === windowId);
    if (!logical) {
      if (deleteWindow) await this.#input.core.invoke({ type: "gameWindowDelete", id: windowId });
      return terminalSummary({
        platform: this.#input.platform,
        operationId: intent.intentId,
        trigger: deleteWindow ? "deleteGameWindow" : "stopGameWindow",
        subsystem: "windowLifecycle",
        completionScope: "nativeDestroyed",
        stage: deleteWindow ? "savedGameWindowDeleted" : "gameWindowAlreadyStopped",
        windowId
      });
    }
    const fence = await this.#coherentWindow(windowId);
    if (this.#input.platform === "darwin") {
      const receipt = await this.#input.appKit!.events.closeWindow(
        this.#appKitObservations([windowId])
      );
      const summary = summaryFromAppKit(
        this.#input.platform,
        intent.intentId,
        deleteWindow ? "deleteGameWindow" : "stopGameWindow",
        "windowLifecycle",
        "nativeDestroyed",
        windowId,
        undefined,
        receipt
      );
      if (deleteWindow && receipt.status === "applied" && receipt.nativeApplied) {
        await this.#input.core.invoke({ type: "gameWindowDelete", id: windowId });
      }
      return summary;
    }
    const request = {
      parentOperationId: intent.intentId,
      windowId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision,
      tabIds: fence.logical.tabs.map((tab) => tab.id),
      intentOrigin: "rendererAdapter"
    };
    const admitted = await this.#input.core.invoke({
      type: "browserWindowCloseAdmit",
      request
    });
    if (
      admitted.parentOperationId !== request.parentOperationId ||
      admitted.windowId !== windowId ||
      admitted.windowGeneration !== request.windowGeneration ||
      admitted.topologyRevision !== request.topologyRevision ||
      !exactStringArrays(admitted.tabIds, request.tabIds)
    ) {
      throw backendError(
        "ELECTRON_CHROMIUM_WINDOW_CLOSE_ADMISSION_STALE",
        "Core returned a mismatched Game Window close admission."
      );
    }
    await this.#input.core.invoke(deleteWindow
      ? { type: "browserWindowDelete", request: admitted }
      : { type: "browserWindowStop", request: admitted });
    return terminalSummary({
      platform: this.#input.platform,
      operationId: intent.intentId,
      trigger: deleteWindow ? "deleteGameWindow" : "stopGameWindow",
      subsystem: "windowLifecycle",
      completionScope: "nativeDestroyed",
      stage: deleteWindow ? "gameWindowDeleted" : "gameWindowStopped",
      windowId,
      windowGeneration: fence.logical.windowGeneration,
      topologyRevision: fence.logical.revision
    });
  }

  async #updateGameWindow(
    windowId: string,
    input: Extract<
      AnyAuthenticatedChromiumRuntimeAction["action"],
      { type: "updateGameWindow" }
    >["input"]
  ): Promise<StateGameWindowRecord> {
    const prior = await this.#input.core.invoke({ type: "gameWindowGet", id: windowId });
    const live = this.#input.readNativeSnapshot().windows.find(
      (window) => window.windowId === windowId
    );
    const observation = this.#input.platform === "darwin" && live
      ? this.#appKitObservations([windowId])[0]
      : undefined;
    const updated = await this.#input.core.invoke({
      type: "gameWindowSaveConfiguration",
      id: windowId,
      input
    });
    if (!updated || updated.id !== windowId) {
      throw backendError(
        "ELECTRON_CHROMIUM_WINDOW_UPDATE_RECEIPT_INVALID",
        "Core returned a mismatched Game Window update receipt."
      );
    }
    if (!observation || updated.name === prior.name) return updated;
    try {
      const native = this.#input.appKit!.factory.applyWindowName(
        observation.identity,
        updated.name
      );
      if (native.name !== updated.name) {
        throw backendError(
          "ELECTRON_MACOS_APPKIT_WINDOW_NAME_RECEIPT_INVALID",
          "AppKit returned a mismatched Game Window name receipt."
        );
      }
      return updated;
    } catch (error) {
      try {
        await this.#input.core.invoke({
          type: "gameWindowSaveConfiguration",
          id: windowId,
          input: {
            name: prior.name,
            targetDisplay: prior.targetDisplay,
            placement: prior.placement,
            tabs: prior.tabs,
            activeTabId: prior.activeTabId ?? null
          }
        });
      } catch (compensationError) {
        this.#input.appKit!.factory.quarantineHost(
          observation.identity,
          compensationError
        );
        throw backendError(
          "ELECTRON_MACOS_APPKIT_WINDOW_NAME_COMPENSATION_FAILED",
          "The Core Game Window name could not be compensated after native failure."
        );
      }
      throw error;
    }
  }

  async #updateWindowPreferences(
    preferences: Extract<
      AnyAuthenticatedChromiumRuntimeAction["action"],
      { type: "updateRuntimeWindowPreferences" }
    >["preferences"]
  ) {
    const prior = await this.#input.core.invoke({ type: "runtimeWindowPreferencesGet" });
    const liveWindowIds = this.#input.readNativeSnapshot().windows.map(
      (window) => window.windowId
    );
    const observations = this.#input.platform === "darwin" &&
      liveWindowIds.length > 0
      ? this.#appKitObservations(liveWindowIds)
      : [];
    const updated = await this.#input.core.invoke({
      type: "runtimeWindowPreferencesReplace",
      preferences
    });
    try {
      await this.#input.windowPreferences.applyWindowPreferences(updated);
      return updated;
    } catch (error) {
      try {
        await this.#input.core.invoke({
          type: "runtimeWindowPreferencesReplace",
          preferences: prior
        });
        await this.#input.windowPreferences.applyWindowPreferences(prior);
      } catch (compensationError) {
        if (this.#input.platform === "darwin") {
          for (const observation of observations) {
            this.#input.appKit!.factory.quarantineHost(
              observation.identity,
              compensationError
            );
          }
        }
        throw backendError(
          "ELECTRON_RUNTIME_WINDOW_PREFERENCES_COMPENSATION_FAILED",
          "Runtime-window preferences could not be compensated after native failure."
        );
      }
      throw error;
    }
  }

  #updateWindowPreferencesOrdered(
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<RuntimeWindowPreferencesRecord> {
    const operation = this.#windowPreferencesLane.then(
      () => this.#updateWindowPreferences(preferences)
    );
    this.#windowPreferencesLane = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  #retain(
    intentId: string,
    fingerprint: string,
    receipt: AnyChromiumRuntimeActionReceipt
  ): void {
    this.#receipts.set(intentId, { fingerprint, receipt });
    this.#receiptOrder.push(intentId);
    while (this.#receiptOrder.length > MAX_RETAINED_ACTION_RECEIPTS) {
      const expired = this.#receiptOrder.shift()!;
      this.#receipts.delete(expired);
    }
  }
}
