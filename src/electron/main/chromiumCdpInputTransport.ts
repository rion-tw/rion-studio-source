import type { EmbeddedKeyEffectRecord } from "../../shared/generated";
import {
  ChromiumCdpInputSession,
  type ChromiumCdpInputIdentity,
  type ChromiumCdpSubmissionReceipt,
  type ChromiumCdpTerminalReason,
  type ChromiumCdpDebuggerPort
} from "./chromiumCdpInputSession";
import type { ChromiumCdpInputPlatform } from "./chromiumCdpInputDescriptors";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "./chromiumRoleSurfaceRegistry";

export interface ChromiumCdpInputBinding {
  readonly identity: ChromiumCdpInputIdentity;
  readonly debugger: ChromiumCdpDebuggerPort;
}

export interface ChromiumCdpInputSurfacePort {
  currentCdpInputBinding: (
    roleId: string,
    generation: number
  ) => ChromiumCdpInputBinding;
  subscribeTrustedInputLifecycle: (
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ) => () => void;
}

export interface ChromiumCdpInputTerminalEvent {
  readonly identity: ChromiumCdpInputIdentity;
  readonly reason: ChromiumCdpTerminalReason;
}

export interface ChromiumCdpInputTransportPort {
  dispatchKey: (
    frame: ChromiumRoleOverlayFrameIdentity,
    effect: EmbeddedKeyEffectRecord
  ) => Promise<ChromiumCdpSubmissionReceipt>;
  dispatchMouse: (
    frame: ChromiumRoleOverlayFrameIdentity,
    input: Readonly<{
      x: number;
      y: number;
      button: "left" | "middle" | "right";
      modifierCodes: readonly string[];
    }>
  ) => Promise<ChromiumCdpSubmissionReceipt>;
  subscribeTerminal: (
    listener: (event: ChromiumCdpInputTerminalEvent) => void
  ) => () => void;
}

interface SessionRecord {
  readonly identity: ChromiumCdpInputIdentity;
  readonly session: ChromiumCdpInputSession;
}

function sameIdentity(
  left: ChromiumCdpInputIdentity,
  right: ChromiumCdpInputIdentity
): boolean {
  return left.roleId === right.roleId &&
    left.surfaceGeneration === right.surfaceGeneration &&
    left.documentInstanceId === right.documentInstanceId &&
    left.frameToken === right.frameToken &&
    left.webContentsId === right.webContentsId;
}

function sameFrame(
  frame: ChromiumRoleOverlayFrameIdentity,
  identity: ChromiumCdpInputIdentity
): boolean {
  return frame.roleId === identity.roleId &&
    frame.generation === identity.surfaceGeneration &&
    frame.documentInstanceId === identity.documentInstanceId &&
    frame.frameToken === identity.frameToken;
}

function identityKey(identity: ChromiumCdpInputIdentity): string {
  return [
    identity.roleId,
    identity.surfaceGeneration,
    identity.documentInstanceId,
    identity.frameToken,
    identity.webContentsId
  ].join("\n");
}

/**
 * The sole production Chromium input submission owner. Sessions are admitted
 * lazily only after the private preload arm receipt, then remain fenced to one
 * exact Role document. An abnormal debugger detach quarantines that document;
 * only a new document identity can create another session.
 */
export class ChromiumCdpInputTransport implements ChromiumCdpInputTransportPort {
  readonly #platform: ChromiumCdpInputPlatform;
  readonly #surfaces: ChromiumCdpInputSurfacePort;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #terminalDocumentByRole = new Map<string, string>();
  readonly #terminalListeners = new Set<
    (event: ChromiumCdpInputTerminalEvent) => void
  >();
  readonly #unsubscribeLifecycle: () => void;
  #disposed = false;

  constructor(input: Readonly<{
    platform: ChromiumCdpInputPlatform;
    surfaces: ChromiumCdpInputSurfacePort;
  }>) {
    this.#platform = input.platform;
    this.#surfaces = input.surfaces;
    this.#unsubscribeLifecycle = this.#surfaces.subscribeTrustedInputLifecycle(
      (event) => this.#onSurfaceLifecycle(event)
    );
  }

  dispatchKey(
    frame: ChromiumRoleOverlayFrameIdentity,
    effect: EmbeddedKeyEffectRecord
  ): Promise<ChromiumCdpSubmissionReceipt> {
    try {
      const current = this.#requireSession(frame);
      return current.session.dispatchKey(current.identity, effect);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispatchMouse(
    frame: ChromiumRoleOverlayFrameIdentity,
    input: Readonly<{
      x: number;
      y: number;
      button: "left" | "middle" | "right";
      modifierCodes: readonly string[];
    }>
  ): Promise<ChromiumCdpSubmissionReceipt> {
    try {
      const current = this.#requireSession(frame);
      return current.session.dispatchMouse(current.identity, input);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  subscribeTerminal(
    listener: (event: ChromiumCdpInputTerminalEvent) => void
  ): () => void {
    if (this.#disposed) throw new Error("The CDP Input transport is disposed.");
    this.#terminalListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#terminalListeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeLifecycle();
    for (const record of [...this.#sessions.values()]) {
      record.session.close(record.identity);
    }
    this.#sessions.clear();
    this.#terminalDocumentByRole.clear();
    this.#terminalListeners.clear();
  }

  #requireSession(frame: ChromiumRoleOverlayFrameIdentity): SessionRecord {
    if (this.#disposed) throw new Error("The CDP Input transport is disposed.");
    const binding = this.#surfaces.currentCdpInputBinding(
      frame.roleId,
      frame.generation
    );
    if (!sameFrame(frame, binding.identity)) {
      throw new Error("The CDP Input binding no longer owns the armed Role document.");
    }
    if (this.#terminalDocumentByRole.get(binding.identity.roleId) ===
      identityKey(binding.identity)) {
      throw new Error("The exact Role document has a terminal CDP Input session.");
    }
    const existing = this.#sessions.get(frame.roleId);
    if (existing && sameIdentity(existing.identity, binding.identity)) return existing;
    if (existing) {
      existing.session.close(existing.identity);
      this.#sessions.delete(frame.roleId);
    }
    let session: ChromiumCdpInputSession;
    try {
      session = ChromiumCdpInputSession.attach({
        identity: binding.identity,
        debugger: binding.debugger,
        domReady: true,
        roleOwnershipVerified: true,
        preloadFrameToken: frame.frameToken,
        platform: this.#platform,
        onTerminal: (identity, reason) => this.#onTerminal(identity, reason)
      });
    } catch (error) {
      this.#terminalDocumentByRole.set(
        binding.identity.roleId,
        identityKey(binding.identity)
      );
      throw error;
    }
    const record = Object.freeze({ identity: binding.identity, session });
    if (this.#terminalDocumentByRole.get(binding.identity.roleId) !==
      identityKey(binding.identity)) {
      this.#terminalDocumentByRole.delete(binding.identity.roleId);
    }
    this.#sessions.set(frame.roleId, record);
    return record;
  }

  #onSurfaceLifecycle(event: ChromiumRoleOverlayLifecycleEvent): void {
    const record = this.#sessions.get(event.roleId);
    if (!record || record.identity.surfaceGeneration !== event.generation) return;
    if (event.reason === "document-superseded") {
      record.session.beginMainFrameNavigation(record.identity);
    } else {
      record.session.close(record.identity);
    }
  }

  #onTerminal(
    identity: ChromiumCdpInputIdentity,
    reason: ChromiumCdpTerminalReason
  ): void {
    const current = this.#sessions.get(identity.roleId);
    if (current && sameIdentity(current.identity, identity)) {
      this.#sessions.delete(identity.roleId);
    }
    this.#terminalDocumentByRole.set(identity.roleId, identityKey(identity));
    const event = Object.freeze({ identity, reason });
    for (const listener of [...this.#terminalListeners]) {
      try {
        listener(event);
      } catch {
        // One observer cannot suppress terminal delivery to the remaining
        // exact Role consumers.
      }
    }
  }
}
