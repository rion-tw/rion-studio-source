import type { EmbeddedKeyEffectRecord } from "../../shared/generated";
import {
  chromiumCdpKeyDescriptor,
  chromiumCdpMouseDescriptors,
  type ChromiumCdpInputPlatform,
  type ChromiumCdpKeyDescriptor,
  type ChromiumCdpMouseDescriptor
} from "./chromiumCdpInputDescriptors";

export type ChromiumCdpTerminalReason =
  | "closed"
  | "crashed"
  | "command-rejected"
  | "debugger-detached"
  | "document-replacing";

export interface ChromiumCdpDebuggerPort {
  isAttached: () => boolean;
  attach: (protocolVersion: "1.3") => void;
  detach: () => void;
  sendCommand: (
    method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent",
    commandParams: ChromiumCdpKeyDescriptor | ChromiumCdpMouseDescriptor
  ) => Promise<unknown>;
  on: (event: "detach", listener: (_event: unknown, reason: string) => void) => void;
  removeListener: (
    event: "detach",
    listener: (_event: unknown, reason: string) => void
  ) => void;
}

export interface ChromiumCdpInputIdentity {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly frameToken: string;
  readonly webContentsId: number;
}

export interface ChromiumCdpInputAdmission {
  readonly identity: ChromiumCdpInputIdentity;
  readonly domReady: true;
  readonly roleOwnershipVerified: true;
  readonly preloadFrameToken: string;
  readonly debugger: ChromiumCdpDebuggerPort;
}

export interface ChromiumCdpSubmissionReceipt {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly acceptedCommandCount: number;
  /** CDP acceptance is never the terminal browser-action success receipt. */
  readonly requiresTrustedDomReceipt: true;
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

/**
 * One in-process debugger session for one exact Role document. The API keeps
 * the CDP method union closed to Input dispatch and deliberately exposes no
 * reconnect or arbitrary-command path.
 */
export class ChromiumCdpInputSession {
  readonly #identity: ChromiumCdpInputIdentity;
  readonly #debugger: ChromiumCdpDebuggerPort;
  readonly #platform: ChromiumCdpInputPlatform;
  readonly #onTerminal: (
    identity: ChromiumCdpInputIdentity,
    reason: ChromiumCdpTerminalReason
  ) => void;
  readonly #detachListener: (_event: unknown, reason: string) => void;
  readonly #pendingCommandRejections = new Set<(error: Error) => void>();
  #state: "attached" | "replacing" | "closed" = "attached";
  #commandTail: Promise<void> = Promise.resolve();

  private constructor(input: ChromiumCdpInputAdmission & Readonly<{
    platform: ChromiumCdpInputPlatform;
    onTerminal: (
      identity: ChromiumCdpInputIdentity,
      reason: ChromiumCdpTerminalReason
    ) => void;
  }>) {
    this.#identity = Object.freeze({ ...input.identity });
    this.#debugger = input.debugger;
    this.#platform = input.platform;
    this.#onTerminal = input.onTerminal;
    this.#detachListener = () => this.#terminalize("debugger-detached", false);
    this.#debugger.on("detach", this.#detachListener);
  }

  static attach(input: ChromiumCdpInputAdmission & Readonly<{
    platform: ChromiumCdpInputPlatform;
    onTerminal: (
      identity: ChromiumCdpInputIdentity,
      reason: ChromiumCdpTerminalReason
    ) => void;
  }>): ChromiumCdpInputSession {
    if (input.domReady !== true || input.roleOwnershipVerified !== true ||
      input.preloadFrameToken !== input.identity.frameToken ||
      input.identity.surfaceGeneration < 1 || input.identity.webContentsId < 1) {
      throw new Error("CDP Input admission has a stale Role or preload identity.");
    }
    if (input.debugger.isAttached()) {
      throw new Error("The Role WebContents already has a debugger owner.");
    }
    input.debugger.attach("1.3");
    if (!input.debugger.isAttached()) {
      throw new Error("The in-process CDP Input session did not attach.");
    }
    return new ChromiumCdpInputSession(input);
  }

  identity(): ChromiumCdpInputIdentity {
    return this.#identity;
  }

  dispatchKey(
    identity: ChromiumCdpInputIdentity,
    effect: EmbeddedKeyEffectRecord
  ): Promise<ChromiumCdpSubmissionReceipt> {
    const descriptor = chromiumCdpKeyDescriptor(effect, this.#platform);
    return this.#enqueue(identity, [() => this.#debugger.sendCommand(
      "Input.dispatchKeyEvent",
      descriptor
    )]);
  }

  dispatchMouse(identity: ChromiumCdpInputIdentity, input: Readonly<{
    x: number;
    y: number;
    button: "left" | "middle" | "right";
    modifierCodes: readonly string[];
  }>): Promise<ChromiumCdpSubmissionReceipt> {
    const descriptors = chromiumCdpMouseDescriptors(input);
    return this.#enqueue(identity, descriptors.map((descriptor) =>
      () => this.#debugger.sendCommand("Input.dispatchMouseEvent", descriptor)));
  }

  beginMainFrameNavigation(identity: ChromiumCdpInputIdentity): void {
    this.#requireCurrent(identity);
    this.#state = "replacing";
    this.#terminalize("document-replacing", true);
  }

  crash(identity: ChromiumCdpInputIdentity): void {
    this.#requireCurrent(identity);
    this.#terminalize("crashed", true);
  }

  close(identity: ChromiumCdpInputIdentity): void {
    this.#requireCurrent(identity);
    this.#terminalize("closed", true);
  }

  async #enqueue(
    identity: ChromiumCdpInputIdentity,
    commands: readonly (() => Promise<unknown>)[]
  ): Promise<ChromiumCdpSubmissionReceipt> {
    this.#requireCurrent(identity);
    let acceptedCommandCount = 0;
    const run = async (): Promise<void> => {
      for (const command of commands) {
        this.#requireCurrent(identity);
        await this.#submitUntilTerminal(command);
        acceptedCommandCount += 1;
      }
    };
    const current = this.#commandTail.then(run);
    this.#commandTail = current.catch(() => undefined);
    try {
      await current;
    } catch (error) {
      if (this.#state === "attached") {
        this.#terminalize("command-rejected", true);
      }
      throw error;
    }
    this.#requireCurrent(identity);
    return Object.freeze({
      roleId: identity.roleId,
      surfaceGeneration: identity.surfaceGeneration,
      documentInstanceId: identity.documentInstanceId,
      acceptedCommandCount,
      requiresTrustedDomReceipt: true
    });
  }

  #submitUntilTerminal(command: () => Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: "resolve" | "reject", error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.#pendingCommandRejections.delete(rejectPending);
        if (outcome === "resolve") resolve();
        else reject(error);
      };
      const rejectPending = (error: Error): void => finish("reject", error);
      this.#pendingCommandRejections.add(rejectPending);
      try {
        void command().then(
          () => finish("resolve"),
          (error) => finish("reject", error)
        );
      } catch (error) {
        finish("reject", error);
      }
    });
  }

  #requireCurrent(identity: ChromiumCdpInputIdentity): void {
    if (this.#state !== "attached" || !this.#debugger.isAttached() ||
      !sameIdentity(identity, this.#identity)) {
      throw new Error("The CDP Input session is detached or generation-stale.");
    }
  }

  #terminalize(reason: ChromiumCdpTerminalReason, detach: boolean): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    const terminalError = new Error(`The CDP Input session terminalized: ${reason}.`);
    for (const reject of [...this.#pendingCommandRejections]) reject(terminalError);
    this.#debugger.removeListener("detach", this.#detachListener);
    if (detach && this.#debugger.isAttached()) {
      try {
        this.#debugger.detach();
      } catch {
        // The closed state and terminal event remain authoritative even if
        // Chromium has already torn down its debugger endpoint.
      }
    }
    this.#onTerminal(this.#identity, reason);
  }
}
