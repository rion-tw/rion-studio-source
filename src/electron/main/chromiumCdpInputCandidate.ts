import type { EmbeddedKeyEffectRecord } from "../../shared/generated";
import {
  chromiumCdpKeyDescriptor,
  chromiumCdpMouseDescriptors,
  type ChromiumCdpInputPlatform,
  type ChromiumCdpKeyDescriptor,
  type ChromiumCdpMouseDescriptor
} from "./chromiumCdpInputDescriptors";

export type ChromiumCdpCandidateTerminalReason =
  | "closed"
  | "crashed"
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

export interface ChromiumCdpCandidateIdentity {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly frameToken: string;
  readonly webContentsId: number;
}

export interface ChromiumCdpCandidateAdmission {
  readonly identity: ChromiumCdpCandidateIdentity;
  readonly domReady: true;
  readonly roleOwnershipVerified: true;
  readonly preloadFrameToken: string;
  readonly debugger: ChromiumCdpDebuggerPort;
}

export interface ChromiumCdpCandidateSubmissionReceipt {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly acceptedCommandCount: number;
  /** CDP acceptance is never the terminal browser-action success receipt. */
  readonly requiresTrustedDomReceipt: true;
}

function sameIdentity(
  left: ChromiumCdpCandidateIdentity,
  right: ChromiumCdpCandidateIdentity
): boolean {
  return left.roleId === right.roleId &&
    left.surfaceGeneration === right.surfaceGeneration &&
    left.documentInstanceId === right.documentInstanceId &&
    left.frameToken === right.frameToken &&
    left.webContentsId === right.webContentsId;
}

/**
 * Isolated product candidate. Production bootstrap does not import this class.
 * It owns one in-process debugger session for one exact Role document and has
 * no arbitrary command entry point or reconnect path.
 */
export class ChromiumCdpInputCandidateSession {
  readonly #identity: ChromiumCdpCandidateIdentity;
  readonly #debugger: ChromiumCdpDebuggerPort;
  readonly #platform: ChromiumCdpInputPlatform;
  readonly #onTerminal: (
    identity: ChromiumCdpCandidateIdentity,
    reason: ChromiumCdpCandidateTerminalReason
  ) => void;
  readonly #detachListener: (_event: unknown, reason: string) => void;
  readonly #pendingCommandRejections = new Set<(error: Error) => void>();
  #state: "attached" | "replacing" | "closed" = "attached";
  #commandTail: Promise<void> = Promise.resolve();

  private constructor(input: ChromiumCdpCandidateAdmission & Readonly<{
    platform: ChromiumCdpInputPlatform;
    onTerminal: (
      identity: ChromiumCdpCandidateIdentity,
      reason: ChromiumCdpCandidateTerminalReason
    ) => void;
  }>) {
    this.#identity = Object.freeze({ ...input.identity });
    this.#debugger = input.debugger;
    this.#platform = input.platform;
    this.#onTerminal = input.onTerminal;
    this.#detachListener = () => this.#terminalize("debugger-detached", false);
    this.#debugger.on("detach", this.#detachListener);
  }

  static attach(input: ChromiumCdpCandidateAdmission & Readonly<{
    platform: ChromiumCdpInputPlatform;
    onTerminal: (
      identity: ChromiumCdpCandidateIdentity,
      reason: ChromiumCdpCandidateTerminalReason
    ) => void;
  }>): ChromiumCdpInputCandidateSession {
    if (input.domReady !== true || input.roleOwnershipVerified !== true ||
      input.preloadFrameToken !== input.identity.frameToken ||
      input.identity.surfaceGeneration < 1 || input.identity.webContentsId < 1) {
      throw new Error("CDP candidate admission has a stale Role or preload identity.");
    }
    if (input.debugger.isAttached()) {
      throw new Error("The Role WebContents already has a debugger owner.");
    }
    input.debugger.attach("1.3");
    if (!input.debugger.isAttached()) {
      throw new Error("The in-process CDP Input session did not attach.");
    }
    return new ChromiumCdpInputCandidateSession(input);
  }

  identity(): ChromiumCdpCandidateIdentity {
    return this.#identity;
  }

  dispatchKey(
    identity: ChromiumCdpCandidateIdentity,
    effect: EmbeddedKeyEffectRecord
  ): Promise<ChromiumCdpCandidateSubmissionReceipt> {
    const descriptor = chromiumCdpKeyDescriptor(effect, this.#platform);
    return this.#enqueue(identity, [() => this.#debugger.sendCommand(
      "Input.dispatchKeyEvent",
      descriptor
    )]);
  }

  dispatchMouse(identity: ChromiumCdpCandidateIdentity, input: Readonly<{
    x: number;
    y: number;
    button: "left" | "middle" | "right";
    modifierCodes: readonly string[];
  }>): Promise<ChromiumCdpCandidateSubmissionReceipt> {
    const descriptors = chromiumCdpMouseDescriptors(input);
    return this.#enqueue(identity, descriptors.map((descriptor) =>
      () => this.#debugger.sendCommand("Input.dispatchMouseEvent", descriptor)));
  }

  beginMainFrameNavigation(identity: ChromiumCdpCandidateIdentity): void {
    this.#requireCurrent(identity);
    this.#state = "replacing";
    this.#terminalize("document-replacing", true);
  }

  crash(identity: ChromiumCdpCandidateIdentity): void {
    this.#requireCurrent(identity);
    this.#terminalize("crashed", true);
  }

  close(identity: ChromiumCdpCandidateIdentity): void {
    this.#requireCurrent(identity);
    this.#terminalize("closed", true);
  }

  async #enqueue(
    identity: ChromiumCdpCandidateIdentity,
    commands: readonly (() => Promise<unknown>)[]
  ): Promise<ChromiumCdpCandidateSubmissionReceipt> {
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
    await current;
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

  #requireCurrent(identity: ChromiumCdpCandidateIdentity): void {
    if (this.#state !== "attached" || !this.#debugger.isAttached() ||
      !sameIdentity(identity, this.#identity)) {
      throw new Error("The CDP Input session is detached or generation-stale.");
    }
  }

  #terminalize(reason: ChromiumCdpCandidateTerminalReason, detach: boolean): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    const terminalError = new Error(`The CDP Input session terminalized: ${reason}.`);
    for (const reject of [...this.#pendingCommandRejections]) reject(terminalError);
    this.#debugger.removeListener("detach", this.#detachListener);
    if (detach && this.#debugger.isAttached()) this.#debugger.detach();
    this.#onTerminal(this.#identity, reason);
  }
}
