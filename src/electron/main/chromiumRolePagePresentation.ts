import type {
  BrowserWorkspaceDividerPointerReceiptRecord,
  BrowserWorkspaceDividerPointerRecord,
  GameBrowserSettingsRecord
} from "../../shared/generated";
import {
  DEFAULT_GAME_EFFECT_SETTINGS,
  gameEffectRuntimeSettings,
  normalizeGameEffectSettings,
  type GameEffectRuntimeSettings
} from "../../shared/gameEffects";
import type { ChromiumRolePagePresentationMessage } from
  "../ipc/chromiumRolePagePresentationProtocol";
import type { ChromiumRoleSurfaceRegistry } from "./chromiumRoleSurfaceRegistry";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";

/** Bootstrap hand-off: the exact registry and Windows divider receipts. */
export interface ChromiumRuntimeBootstrapPresentationPort {
  attachSurfaces: (surfaces: Pick<ChromiumRoleSurfaceRegistry, "sendPagePresentation">) => void;
  divider: (
    event: BrowserWorkspaceDividerPointerRecord,
    receipt: BrowserWorkspaceDividerPointerReceiptRecord
  ) => void;
}

export interface ChromiumRolePagePresentationInput {
  /** Presentation-only delivery to the exact live surface generation. */
  readonly send: (
    roleId: string,
    generation: number,
    message: ChromiumRolePagePresentationMessage
  ) => boolean;
  readonly snapshot: () => ChromiumRuntimeExecutorSnapshot | null;
}

function percentLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** One decimal at most, matching the workspace editor's ratios. */
function ratioLabel(value: number): string {
  const percent = Math.round(value * 1000) / 10;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function sameRuntimeSettings(left: GameEffectRuntimeSettings, right: GameEffectRuntimeSettings): boolean {
  return left.enabled === right.enabled && left.brightness === right.brightness &&
    left.dimBrightSkills === right.dimBrightSkills && left.hideHitEffects === right.hideHitEffects;
}

/**
 * Owns game-page presentation that is not authoritative state: effect
 * dimming levels and the transient zoom / divider ratio indicators. Core
 * receipts and settings snapshots are the only triggers.
 */
export class ChromiumRolePagePresentation {
  readonly #input: ChromiumRolePagePresentationInput;
  #effects: GameEffectRuntimeSettings = gameEffectRuntimeSettings(DEFAULT_GAME_EFFECT_SETTINGS);

  constructor(input: ChromiumRolePagePresentationInput) {
    this.#input = input;
  }

  /** Answer for a role document's synchronous start-up request. */
  effectsForDocumentStart(): GameEffectRuntimeSettings {
    return this.#effects;
  }

  observeGameBrowserSettings(settings: GameBrowserSettingsRecord | undefined): void {
    if (!settings) return;
    const next = gameEffectRuntimeSettings(normalizeGameEffectSettings(settings.effects));
    if (sameRuntimeSettings(next, this.#effects)) return;
    this.#effects = next;
    const message = Object.freeze({ type: "effects" as const, settings: next });
    for (const role of this.#input.snapshot()?.roles ?? []) {
      this.#deliver(role.roleId, role.generation, message);
    }
  }

  showWindowZoom(windowId: string, zoomFactor: number): void {
    const snapshot = this.#input.snapshot();
    const window = snapshot?.windows.find(candidate => candidate.windowId === windowId);
    if (!snapshot || !window) return;
    const message = Object.freeze({ type: "zoomIndicator" as const, label: percentLabel(zoomFactor) });
    for (const role of snapshot.roles) {
      if (role.windowId === windowId && role.tabId === window.activeTabId) {
        this.#deliver(role.roleId, role.generation, message);
      }
    }
  }

  /** Reads the committed base zoom of the exact surface after its receipt. */
  showRoleZoom(roleId: string, generation: number): void {
    const role = this.#input.snapshot()?.roles.find(candidate =>
      candidate.roleId === roleId && candidate.generation === generation);
    if (role?.zoomFactor === undefined) return;
    this.#deliver(roleId, generation, Object.freeze({
      type: "zoomIndicator" as const,
      label: percentLabel(role.zoomFactor)
    }));
  }

  /** Each viewport shows its own width × height share while a divider moves. */
  showWorkspaceDivider(
    event: BrowserWorkspaceDividerPointerRecord,
    receipt: BrowserWorkspaceDividerPointerReceiptRecord
  ): void {
    if (receipt.eventId !== event.eventId) return;
    const roles = this.#input.snapshot()?.roles.filter(role =>
      role.windowId === event.windowId && role.tabId === event.tabId) ?? [];
    const hide = event.phase === "end" || event.phase === "cancel" ||
      receipt.status === "superseded" || receipt.status === "cancelled";
    for (const role of roles) {
      if (hide) {
        this.#deliver(role.roleId, role.generation, Object.freeze({ type: "resizeIndicatorHide" as const }));
        continue;
      }
      const slot = receipt.workspaceSlots.find(candidate => candidate.roleId === role.roleId);
      if (!slot) continue;
      this.#deliver(role.roleId, role.generation, Object.freeze({
        type: "resizeIndicator" as const,
        label: `${ratioLabel(slot.rect.width)} × ${ratioLabel(slot.rect.height)}`
      }));
    }
  }

  #deliver(roleId: string, generation: number, message: ChromiumRolePagePresentationMessage): void {
    try {
      this.#input.send(roleId, generation, message);
    } catch {
      // A surface retiring during delivery has nothing left to present.
    }
  }
}
