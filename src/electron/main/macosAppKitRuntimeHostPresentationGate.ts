import { RionBridgeError } from "../ipc/errors";

export type MacosAppKitPendingPresentationEvent =
  | Readonly<{ kind: "layout"; sequence: number }>
  | Readonly<{
      action: Readonly<Record<string, unknown>>;
      kind: "windowState";
      sequence: number;
    }>;

/** Admission is owned by the first exact Core host projection, never page loading. */
export class MacosAppKitRuntimeHostPresentationGate {
  #admitted = false;
  #nextSequence = 0;
  #layoutSequence: number | null = null;
  readonly #windowStates = new Map<string, Extract<MacosAppKitPendingPresentationEvent, { kind: "windowState" }>>();

  get admitted(): boolean { return this.#admitted; }

  deferLayout(): boolean {
    if (this.#admitted) return false;
    this.#layoutSequence = ++this.#nextSequence;
    return true;
  }

  deferWindowState(action: Readonly<Record<string, unknown>>): boolean {
    if (this.#admitted) return false;
    this.#windowStates.set(String(action.type), Object.freeze({
      action: Object.freeze({ ...action }), kind: "windowState", sequence: ++this.#nextSequence
    }));
    return true;
  }

  admit(): readonly MacosAppKitPendingPresentationEvent[] {
    if (this.#admitted) return [];
    this.#admitted = true;
    const pending: MacosAppKitPendingPresentationEvent[] = [...this.#windowStates.values()];
    if (this.#layoutSequence !== null) pending.push({ kind: "layout", sequence: this.#layoutSequence });
    this.#layoutSequence = null;
    this.#windowStates.clear();
    return pending.sort((left, right) => left.sequence - right.sequence);
  }
}

export function requireMacosAppKitSurfaceAttachmentOwner(
  ownsTab: boolean, outcome: "completed" | "discarded"
): void {
  requireOwnedTab(ownsTab, outcome);
}

function requireOwnedTab(ownsTab: boolean, outcome: "completed" | "discarded"): void {
  if (ownsTab) return;
  throw new RionBridgeError({
    code: "ELECTRON_MACOS_APPKIT_SURFACE_ATTACHMENT_STALE",
    message: `The ${outcome} Chromium surface attachment no longer owns an AppKit tab.`
  });
}
