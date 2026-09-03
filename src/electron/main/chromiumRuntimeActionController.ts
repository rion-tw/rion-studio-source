import { randomUUID } from "node:crypto";

import type {
  RuntimeTabMoveResultRecord,
  RuntimeWindowPreferencesRecord,
  StateGameWindowRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import type {
  DiscardSavedGameWindowsInput,
  QuickAccessPresentationRequest,
  QuickAccessRequestResolution,
  RestoreSavedGameWindowsInput,
  UpdateGameWindowInput
} from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { RendererIdentity } from "./rendererIdentity";

const MAX_QUEUED_RUNTIME_ACTIONS = 64;
const MAX_IDENTIFIER_BYTES = 256;

export type ChromiumRuntimeActionStatus =
  | "applied"
  | "duplicate"
  | "superseded";

export interface ChromiumRuntimeActionRequestMap {
  updateGameWindow: Readonly<{
    windowId: string;
    input: UpdateGameWindowInput;
  }>;
  showGameWindow: Readonly<{ windowId: string }>;
  hideGameWindow: Readonly<{ windowId: string }>;
  stopGameWindow: Readonly<{ windowId: string }>;
  deleteGameWindow: Readonly<{ windowId: string }>;
  showGameWindowTab: Readonly<{ tabId: string }>;
  moveGameWindowTab: Readonly<{ tabId: string; windowId: string }>;
  moveGameWindowTabToNewWindow: Readonly<{ tabId: string }>;
  reorderGameWindowTab: Readonly<{ tabId: string; beforeTabId?: string }>;
  setGameWindowTabMuted: Readonly<{ tabId: string; muted: boolean }>;
  setGameWindowTabHidden: Readonly<{ tabId: string; hidden: boolean }>;
  stopGameWindowTab: Readonly<{ tabId: string }>;
  restoreSavedGameWindows: Readonly<{ input: RestoreSavedGameWindowsInput }>;
  discardSavedGameWindows: Readonly<{ input: DiscardSavedGameWindowsInput }>;
  updateRuntimeWindowPreferences: Readonly<{
    preferences: RuntimeWindowPreferencesRecord;
  }>;
  consumePendingQuickAccessRequest: Readonly<Record<string, never>>;
  presentQuickAccessRequest: Readonly<{ requestId: string }>;
  resolveQuickAccessRequest: Readonly<{
    requestId: string;
    resolution: QuickAccessRequestResolution;
  }>;
}

export interface ChromiumRuntimeActionResultMap {
  updateGameWindow: StateGameWindowRecord;
  showGameWindow: undefined;
  hideGameWindow: SystemRuntimeOperationSummaryRecord;
  stopGameWindow: SystemRuntimeOperationSummaryRecord;
  deleteGameWindow: SystemRuntimeOperationSummaryRecord;
  showGameWindowTab: SystemRuntimeOperationSummaryRecord;
  moveGameWindowTab: SystemRuntimeOperationSummaryRecord;
  moveGameWindowTabToNewWindow: RuntimeTabMoveResultRecord;
  reorderGameWindowTab: SystemRuntimeOperationSummaryRecord;
  setGameWindowTabMuted: SystemRuntimeOperationSummaryRecord;
  setGameWindowTabHidden: SystemRuntimeOperationSummaryRecord;
  stopGameWindowTab: SystemRuntimeOperationSummaryRecord;
  restoreSavedGameWindows: undefined;
  discardSavedGameWindows: undefined;
  updateRuntimeWindowPreferences: RuntimeWindowPreferencesRecord;
  consumePendingQuickAccessRequest: QuickAccessPresentationRequest | null;
  presentQuickAccessRequest: boolean;
  resolveQuickAccessRequest: undefined;
}

export type ChromiumRuntimeActionKind = keyof ChromiumRuntimeActionRequestMap;

export type AuthenticatedChromiumRuntimeAction<
  Kind extends ChromiumRuntimeActionKind
> = Readonly<{
  intentId: string;
  adapterSequence: number;
  rendererInstanceId: string;
  rendererGeneration: number;
  action: Readonly<{ type: Kind }> & ChromiumRuntimeActionRequestMap[Kind];
}>;

export type ChromiumRuntimeActionReceipt<
  Kind extends ChromiumRuntimeActionKind
> = Readonly<{
  intentId: string;
  adapterSequence: number;
  rendererInstanceId: string;
  rendererGeneration: number;
  actionType: Kind;
  status: ChromiumRuntimeActionStatus;
  value: ChromiumRuntimeActionResultMap[Kind];
}>;

export type AnyAuthenticatedChromiumRuntimeAction = {
  [Kind in ChromiumRuntimeActionKind]: AuthenticatedChromiumRuntimeAction<Kind>;
}[ChromiumRuntimeActionKind];

export type AnyChromiumRuntimeActionReceipt = {
  [Kind in ChromiumRuntimeActionKind]: ChromiumRuntimeActionReceipt<Kind>;
}[ChromiumRuntimeActionKind];

/**
 * Privileged implementation boundary for runtime UI actions.
 *
 * Implementations must derive every native window/tab owner and generation
 * from an exact Core/native snapshot. On macOS they must capture exact host
 * observations and enter MacosAppKitRuntimeEventBridge; they may never call a
 * generic Electron host directly. On Windows they must submit the fenced Core
 * intent and consume only its event-bound native receipt.
 */
export interface ChromiumRuntimeActionBackend {
  execute(
    intent: AnyAuthenticatedChromiumRuntimeAction
  ): Promise<AnyChromiumRuntimeActionReceipt>;
}

export interface ChromiumRuntimeActionControllerInput {
  readonly backend: ChromiumRuntimeActionBackend;
  readonly createIntentId?: () => string;
}

export interface ElectronChromiumRuntimeActionPort {
  updateGameWindow: (
    identity: RendererIdentity,
    windowId: string,
    input: UpdateGameWindowInput
  ) => Promise<StateGameWindowRecord>;
  showGameWindow: (identity: RendererIdentity, windowId: string) => Promise<void>;
  hideGameWindow: (
    identity: RendererIdentity,
    windowId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  stopGameWindow: (
    identity: RendererIdentity,
    windowId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  deleteGameWindow: (
    identity: RendererIdentity,
    windowId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  showGameWindowTab: (
    identity: RendererIdentity,
    tabId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  moveGameWindowTab: (
    identity: RendererIdentity,
    tabId: string,
    windowId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  moveGameWindowTabToNewWindow: (
    identity: RendererIdentity,
    tabId: string
  ) => Promise<RuntimeTabMoveResultRecord>;
  reorderGameWindowTab: (
    identity: RendererIdentity,
    tabId: string,
    beforeTabId?: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  setGameWindowTabMuted: (
    identity: RendererIdentity,
    tabId: string,
    muted: boolean
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  setGameWindowTabHidden: (
    identity: RendererIdentity,
    tabId: string,
    hidden: boolean
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  stopGameWindowTab: (
    identity: RendererIdentity,
    tabId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  restoreSavedGameWindows: (
    identity: RendererIdentity,
    input: RestoreSavedGameWindowsInput
  ) => Promise<void>;
  discardSavedGameWindows: (
    identity: RendererIdentity,
    input: DiscardSavedGameWindowsInput
  ) => Promise<void>;
  updateRuntimeWindowPreferences: (
    identity: RendererIdentity,
    preferences: RuntimeWindowPreferencesRecord
  ) => Promise<RuntimeWindowPreferencesRecord>;
  consumePendingQuickAccessRequest: (
    identity: RendererIdentity
  ) => Promise<QuickAccessPresentationRequest | null>;
  presentQuickAccessRequest: (
    identity: RendererIdentity,
    requestId: string
  ) => Promise<boolean>;
  resolveQuickAccessRequest: (
    identity: RendererIdentity,
    requestId: string,
    resolution: QuickAccessRequestResolution
  ) => Promise<void>;
}

function actionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    value !== value.trim() || value.includes("/") || value.includes("\\") ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw actionError(
      "ELECTRON_CHROMIUM_RUNTIME_ACTION_ID_INVALID",
      `The ${field} identity is malformed.`
    );
  }
  return value;
}

function rendererInstanceId(identity: RendererIdentity): string {
  if (
    identity.kind !== "main-renderer" ||
    !Number.isSafeInteger(identity.windowId) || identity.windowId < 1 ||
    !Number.isSafeInteger(identity.webContentsId) || identity.webContentsId < 1 ||
    !Number.isSafeInteger(identity.generation) || identity.generation < 1
  ) {
    throw actionError(
      "ELECTRON_CHROMIUM_RUNTIME_ACTION_SENDER_INVALID",
      "The runtime action lost its authenticated main-renderer generation."
    );
  }
  return `main:${identity.windowId}:${identity.webContentsId}:${identity.generation}`;
}

function cloneUpdateInput(input: UpdateGameWindowInput): UpdateGameWindowInput {
  return structuredClone(input);
}

/**
 * Converts authenticated bridge calls into an ordered privileged intent lane.
 * No deadline is used: each action terminalizes only from the backend's exact
 * Core/native receipt, cancellation/supersede, or stream failure.
 */
export class ChromiumRuntimeActionController
implements ElectronChromiumRuntimeActionPort {
  readonly #input: ChromiumRuntimeActionControllerInput;
  readonly #latestGenerationByRenderer = new Map<string, number>();
  #adapterSequence = 0;
  #lane: Promise<void> = Promise.resolve();
  #queuedActions = 0;

  constructor(input: ChromiumRuntimeActionControllerInput) {
    this.#input = input;
  }

  updateGameWindow(
    identity: RendererIdentity,
    windowId: string,
    input: UpdateGameWindowInput
  ): Promise<StateGameWindowRecord> {
    return this.#submit(identity, "updateGameWindow", {
      windowId: requireIdentifier(windowId, "Game Window"),
      input: cloneUpdateInput(input)
    });
  }

  showGameWindow(identity: RendererIdentity, windowId: string): Promise<void> {
    return this.#submit(identity, "showGameWindow", {
      windowId: requireIdentifier(windowId, "Game Window")
    });
  }

  hideGameWindow(
    identity: RendererIdentity,
    windowId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "hideGameWindow", {
      windowId: requireIdentifier(windowId, "Game Window")
    });
  }

  stopGameWindow(
    identity: RendererIdentity,
    windowId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "stopGameWindow", {
      windowId: requireIdentifier(windowId, "Game Window")
    });
  }

  deleteGameWindow(
    identity: RendererIdentity,
    windowId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "deleteGameWindow", {
      windowId: requireIdentifier(windowId, "Game Window")
    });
  }

  showGameWindowTab(
    identity: RendererIdentity,
    tabId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "showGameWindowTab", {
      tabId: requireIdentifier(tabId, "runtime tab")
    });
  }

  moveGameWindowTab(
    identity: RendererIdentity,
    tabId: string,
    windowId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "moveGameWindowTab", {
      tabId: requireIdentifier(tabId, "runtime tab"),
      windowId: requireIdentifier(windowId, "target Game Window")
    });
  }

  moveGameWindowTabToNewWindow(
    identity: RendererIdentity,
    tabId: string
  ): Promise<RuntimeTabMoveResultRecord> {
    return this.#submit(identity, "moveGameWindowTabToNewWindow", {
      tabId: requireIdentifier(tabId, "runtime tab")
    });
  }

  reorderGameWindowTab(
    identity: RendererIdentity,
    tabId: string,
    beforeTabId?: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const exactTabId = requireIdentifier(tabId, "runtime tab");
    const exactBeforeTabId = beforeTabId === undefined
      ? undefined
      : requireIdentifier(beforeTabId, "reorder target tab");
    if (exactBeforeTabId === exactTabId) {
      throw actionError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_REORDER_INVALID",
        "A runtime tab cannot be reordered before itself."
      );
    }
    return this.#submit(identity, "reorderGameWindowTab", {
      tabId: exactTabId,
      ...(exactBeforeTabId === undefined ? {} : { beforeTabId: exactBeforeTabId })
    });
  }

  setGameWindowTabMuted(
    identity: RendererIdentity,
    tabId: string,
    muted: boolean
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "setGameWindowTabMuted", {
      tabId: requireIdentifier(tabId, "runtime tab"),
      muted
    });
  }

  setGameWindowTabHidden(
    identity: RendererIdentity,
    tabId: string,
    hidden: boolean
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "setGameWindowTabHidden", {
      tabId: requireIdentifier(tabId, "runtime tab"),
      hidden
    });
  }

  stopGameWindowTab(
    identity: RendererIdentity,
    tabId: string
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    return this.#submit(identity, "stopGameWindowTab", {
      tabId: requireIdentifier(tabId, "runtime tab")
    });
  }

  restoreSavedGameWindows(
    identity: RendererIdentity,
    input: RestoreSavedGameWindowsInput
  ): Promise<void> {
    return this.#submit(identity, "restoreSavedGameWindows", {
      input: structuredClone(input)
    });
  }

  discardSavedGameWindows(
    identity: RendererIdentity,
    input: DiscardSavedGameWindowsInput
  ): Promise<void> {
    return this.#submit(identity, "discardSavedGameWindows", {
      input: structuredClone(input)
    });
  }

  updateRuntimeWindowPreferences(
    identity: RendererIdentity,
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<RuntimeWindowPreferencesRecord> {
    return this.#submit(identity, "updateRuntimeWindowPreferences", {
      preferences: Object.freeze({ ...preferences })
    });
  }

  consumePendingQuickAccessRequest(
    identity: RendererIdentity
  ): Promise<QuickAccessPresentationRequest | null> {
    return this.#submit(identity, "consumePendingQuickAccessRequest", {});
  }

  presentQuickAccessRequest(
    identity: RendererIdentity,
    requestId: string
  ): Promise<boolean> {
    return this.#submit(identity, "presentQuickAccessRequest", {
      requestId: requireIdentifier(requestId, "Quick Access request")
    });
  }

  resolveQuickAccessRequest(
    identity: RendererIdentity,
    requestId: string,
    resolution: QuickAccessRequestResolution
  ): Promise<void> {
    if (!(["cancel", "complete", "ignored"] as const).includes(resolution)) {
      throw actionError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_RESOLUTION_INVALID",
        "The Quick Access resolution is invalid."
      );
    }
    return this.#submit(identity, "resolveQuickAccessRequest", {
      requestId: requireIdentifier(requestId, "Quick Access request"),
      resolution
    });
  }

  #submit<Kind extends ChromiumRuntimeActionKind>(
    identity: RendererIdentity,
    type: Kind,
    request: ChromiumRuntimeActionRequestMap[Kind]
  ): Promise<ChromiumRuntimeActionResultMap[Kind]> {
    if (this.#queuedActions >= MAX_QUEUED_RUNTIME_ACTIONS) {
      return Promise.reject(actionError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_QUEUE_FULL",
        "The ordered runtime action lane is full."
      ));
    }
    const instanceId = this.#authenticateRenderer(identity);
    this.#queuedActions += 1;
    const result = this.#lane.then(async () => {
      const sequence = this.#nextAdapterSequence();
      const intent = Object.freeze({
        intentId: requireIdentifier(
          (this.#input.createIntentId ?? randomUUID)(),
          "runtime action"
        ),
        adapterSequence: sequence,
        rendererInstanceId: instanceId,
        rendererGeneration: identity.generation,
        action: Object.freeze({ type, ...request })
      }) as AuthenticatedChromiumRuntimeAction<Kind>;
      const receipt = await this.#input.backend.execute(
        intent as AnyAuthenticatedChromiumRuntimeAction
      ) as ChromiumRuntimeActionReceipt<Kind>;
      this.#validateReceipt(intent, receipt);
      return receipt.value;
    });
    this.#lane = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.#queuedActions -= 1;
    });
  }

  #authenticateRenderer(identity: RendererIdentity): string {
    const instanceId = rendererInstanceId(identity);
    const key = `${identity.windowId}:${identity.webContentsId}`;
    const latest = this.#latestGenerationByRenderer.get(key) ?? 0;
    if (identity.generation < latest) {
      throw actionError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_SENDER_STALE",
        "The runtime action came from a superseded renderer generation."
      );
    }
    this.#latestGenerationByRenderer.set(key, identity.generation);
    return instanceId;
  }

  #nextAdapterSequence(): number {
    const next = this.#adapterSequence + 1;
    if (!Number.isSafeInteger(next)) {
      throw actionError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_SEQUENCE_EXHAUSTED",
        "The runtime action adapter sequence is exhausted."
      );
    }
    this.#adapterSequence = next;
    return next;
  }

  #validateReceipt<Kind extends ChromiumRuntimeActionKind>(
    intent: AuthenticatedChromiumRuntimeAction<Kind>,
    receipt: ChromiumRuntimeActionReceipt<Kind>
  ): void {
    if (
      receipt.intentId !== intent.intentId ||
      receipt.adapterSequence !== intent.adapterSequence ||
      receipt.rendererInstanceId !== intent.rendererInstanceId ||
      receipt.rendererGeneration !== intent.rendererGeneration ||
      receipt.actionType !== intent.action.type ||
      !(["applied", "duplicate", "superseded"] as const).includes(receipt.status)
    ) {
      throw actionError(
        "ELECTRON_CHROMIUM_RUNTIME_ACTION_RECEIPT_INVALID",
        "The runtime action backend returned a mismatched terminal receipt."
      );
    }
  }
}
