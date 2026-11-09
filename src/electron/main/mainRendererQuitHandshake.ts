import type { RendererIdentity } from "./rendererIdentity";

export interface ElectronMainRendererQuitWindowPort {
  focus: () => void;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
}

export interface ElectronMainRendererQuitHandshakeInput {
  publishQuitRequested: (identity: RendererIdentity) => boolean;
}

interface RendererQuitBinding {
  identity: RendererIdentity;
  ready: boolean;
  /** A hung renderer cannot answer the unsaved-change prompt; Quit must not wait on it. */
  responsive: boolean;
  window: ElectronMainRendererQuitWindowPort;
}

/**
 * Owns the event-bound readiness fence for the renderer unsaved-change guard.
 * Readiness never survives a main-frame replacement, renderer-process loss, or
 * exact window release; a later document must explicitly announce readiness.
 */
export class ElectronMainRendererQuitHandshake {
  readonly #input: ElectronMainRendererQuitHandshakeInput;
  #binding: RendererQuitBinding | null = null;

  constructor(input: ElectronMainRendererQuitHandshakeInput) {
    this.#input = input;
  }

  bind(identity: RendererIdentity, window: ElectronMainRendererQuitWindowPort): void {
    this.#binding = { identity, ready: false, responsive: true, window };
  }

  /** Follows WebContents `unresponsive`/`responsive`; readiness itself is kept. */
  markResponsive(identity: RendererIdentity, responsive: boolean): void {
    if (this.#binding?.identity === identity) this.#binding.responsive = responsive;
  }

  markReady(identity: RendererIdentity): void {
    if (this.#binding?.identity === identity) this.#binding.ready = true;
  }

  markUnavailable(identity: RendererIdentity): void {
    if (this.#binding?.identity === identity) this.#binding.ready = false;
  }

  release(identity: RendererIdentity): void {
    if (this.#binding?.identity === identity) this.#binding = null;
  }

  requestConfirmation(): boolean {
    const binding = this.#binding;
    if (!binding?.ready || !binding.responsive || binding.window.isDestroyed()) return false;
    if (binding.window.isMinimized()) binding.window.restore();
    binding.window.show();
    binding.window.focus();
    return this.#input.publishQuitRequested(binding.identity);
  }
}
