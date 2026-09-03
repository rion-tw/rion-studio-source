import { RionBridgeError } from "../ipc/errors";

export type MacosAppKitPendingPresentationEvent =
  | Readonly<{ kind: "layout"; sequence: number }>
  | Readonly<{
      action: Readonly<Record<string, unknown>>;
      kind: "windowState";
      sequence: number;
    }>;

/**
 * Coalesces native presentation callbacks while an AppKit tab is still
 * acquiring its exact Chromium surfaces. User-authored tab actions stay on
 * their normal event lane; only layout/window-state evidence is deferred.
 */
export class MacosAppKitRuntimeHostPresentationGate {
  readonly #pendingTabIds = new Set<string>();
  #nextSequence = 0;
  #layoutSequence: number | null = null;
  #windowState: Extract<
    MacosAppKitPendingPresentationEvent,
    { kind: "windowState" }
  > | null = null;

  begin(tabId: string): void {
    this.#pendingTabIds.add(tabId);
  }

  deferLayout(): boolean {
    if (this.#pendingTabIds.size === 0) return false;
    this.#layoutSequence = this.#nextEventSequence();
    return true;
  }

  deferWindowState(action: Readonly<Record<string, unknown>>): boolean {
    if (this.#pendingTabIds.size === 0) return false;
    this.#windowState = Object.freeze({
      action: Object.freeze({ ...action }),
      kind: "windowState" as const,
      sequence: this.#nextEventSequence()
    });
    return true;
  }

  release(tabId: string): readonly MacosAppKitPendingPresentationEvent[] {
    if (!this.#pendingTabIds.delete(tabId) || this.#pendingTabIds.size > 0) {
      return [];
    }
    const pending: MacosAppKitPendingPresentationEvent[] = [];
    if (this.#layoutSequence !== null) {
      pending.push(Object.freeze({
        kind: "layout",
        sequence: this.#layoutSequence
      }));
    }
    if (this.#windowState) pending.push(this.#windowState);
    this.#clearPendingEvents();
    return Object.freeze(pending.sort((left, right) =>
      left.sequence - right.sequence
    ));
  }

  discard(tabId: string): void {
    if (!this.#pendingTabIds.delete(tabId) || this.#pendingTabIds.size > 0) return;
    this.#clearPendingEvents();
  }

  #nextEventSequence(): number {
    this.#nextSequence += 1;
    return this.#nextSequence;
  }

  #clearPendingEvents(): void {
    this.#layoutSequence = null;
    this.#windowState = null;
  }
}

export function releaseMacosAppKitSurfaceAttachment(input: Readonly<{
  gate: MacosAppKitRuntimeHostPresentationGate;
  ownsTab: boolean;
  publishLayout: () => void;
  publishWindowState: (action: Readonly<Record<string, unknown>>) => void;
  tabId: string;
}>): void {
  requireOwnedTab(input.ownsTab, "completed");
  for (const event of input.gate.release(input.tabId)) {
    if (event.kind === "layout") input.publishLayout();
    else input.publishWindowState(event.action);
  }
}

export function discardMacosAppKitSurfaceAttachment(input: Readonly<{
  gate: MacosAppKitRuntimeHostPresentationGate;
  ownsTab: boolean;
  tabId: string;
}>): void {
  requireOwnedTab(input.ownsTab, "discarded");
  input.gate.discard(input.tabId);
}

function requireOwnedTab(ownsTab: boolean, outcome: "completed" | "discarded"): void {
  if (ownsTab) return;
  throw new RionBridgeError({
    code: "ELECTRON_MACOS_APPKIT_SURFACE_ATTACHMENT_STALE",
    message: `The ${outcome} Chromium surface attachment no longer owns an AppKit tab.`
  });
}
