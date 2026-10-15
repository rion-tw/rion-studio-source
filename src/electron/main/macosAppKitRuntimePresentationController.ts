import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeWindowPresentationRequest
} from "./chromiumRuntimeFullscreenToolbar";
import type { ChromiumRuntimeHostProjection } from "./chromiumRuntimeHostPorts";
import type { MacosAppKitBaseWindowPort } from "./macosAppKitRuntimePorts";
import { deferred, type Deferred } from "./macosAppKitRuntimeHostSupport";

interface MacosAppKitRuntimePresentationFence {
  readonly current: boolean;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

interface PendingPresentation {
  readonly completion: Deferred<ChromiumRuntimeHostProjection>;
  readonly request: ChromiumRuntimeWindowPresentationRequest;
  readonly initial?: {
    readonly readProjection: () => ChromiumRuntimeHostProjection;
    readonly requireCurrent: () => void;
    submitted: boolean;
    acknowledged: boolean;
  };
}

export interface MacosAppKitRuntimePresentationControllerInput {
  readonly native: Pick<
    MacosAppKitBaseWindowPort,
    "isDestroyed" | "isFullScreen" | "isMaximized" | "isMinimized" |
    "isVisible" | "setFullScreen" | "maximize"
  >;
  readonly prepareFullscreen: (fullscreen: boolean) => void;
  readonly readFence: () => MacosAppKitRuntimePresentationFence;
  readonly readProjection: () => ChromiumRuntimeHostProjection;
}

function presentationError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function nativePresentation(
  native: MacosAppKitRuntimePresentationControllerInput["native"]
): ChromiumRuntimeWindowPresentationRequest["presentation"] {
  return native.isFullScreen()
    ? "fullscreen"
    : native.isMaximized() ? "maximized" : "normal";
}

/**
 * Event-bound normal/fullscreen lane for the retained AppKit host.
 *
 * A programmatic transition consumes its exact native placement callback as
 * the acknowledgement for the requesting Rust effect. Native traffic-light
 * and menu transitions have no pending request and remain ordinary AppKit
 * events, so AppKit stays the presentation source for those user actions.
 */
export class MacosAppKitRuntimePresentationController {
  readonly #input: MacosAppKitRuntimePresentationControllerInput;
  #pending: PendingPresentation | null = null;
  #awaitingCoreProjection: ChromiumRuntimeWindowPresentationRequest | null = null;

  constructor(input: MacosAppKitRuntimePresentationControllerInput) {
    this.#input = input;
  }

  /** Core already owns this staged mode; no later mode-commit revision is due. */
  setInitialPresentation(
    request: ChromiumRuntimeWindowPresentationRequest,
    readProjection = this.#input.readProjection,
    requireCurrent: () => void = () => undefined
  ): Promise<ChromiumRuntimeHostProjection> {
    if (request.presentation !== "fullscreen" && request.presentation !== "maximized") {
      return Promise.reject(presentationError("ELECTRON_MACOS_APPKIT_PRESENTATION_INVALID",
        "Initial AppKit presentation requires a staged fullscreen or maximized mode."));
    }
    try {
      requireCurrent();
      this.#requireInitialFence(request);
      if (this.#pending || this.#awaitingCoreProjection) {
        throw presentationError("ELECTRON_MACOS_APPKIT_PRESENTATION_BUSY",
          "Another event-bound AppKit presentation request is still active.");
      }
      if (nativePresentation(this.#input.native) !== "normal") {
        throw presentationError("ELECTRON_MACOS_APPKIT_PRESENTATION_READBACK_MISMATCH",
          "The staged AppKit host changed mode before its owned native submission.");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const pending: PendingPresentation = {
      completion: deferred<ChromiumRuntimeHostProjection>(),
      request: Object.freeze({ ...request }),
      initial: { readProjection, requireCurrent, submitted: false, acknowledged: false }
    };
    this.#pending = pending;
    try {
      if (request.presentation === "fullscreen") this.#input.prepareFullscreen(true);
      this.#requireInitialPending(pending);
      if (request.presentation === "fullscreen") this.#input.native.setFullScreen(true);
      else this.#input.native.maximize();
      pending.initial!.submitted = true;
      if (pending.initial!.acknowledged) this.#completePlacement(pending);
    } catch (error) {
      // Unknown native delivery never authorizes a compensating fullscreen exit.
      this.#rejectPending(pending, error);
    }
    return pending.completion.promise;
  }

  setPresentation(
    request: ChromiumRuntimeWindowPresentationRequest
  ): Promise<ChromiumRuntimeHostProjection> {
    const fence = this.#input.readFence();
    const supersedesAwaiting = this.#supersedesAwaitingProjection(request);
    if (
      request.presentation === "maximized" ||
      !(["normal", "fullscreen"] as const).includes(request.presentation)
    ) {
      return Promise.reject(presentationError(
        "ELECTRON_MACOS_APPKIT_PRESENTATION_INVALID",
        "The retained AppKit host supports normal and fullscreen presentation only."
      ));
    }
    if (!this.#matchesAdmissionFence(request, fence, supersedesAwaiting)) {
      return Promise.reject(presentationError(
        "ELECTRON_MACOS_APPKIT_PRESENTATION_FENCE_STALE",
        "The AppKit presentation request lost its exact Core and native host fence."
      ));
    }
    if (this.#pending) {
      return Promise.reject(presentationError(
        "ELECTRON_MACOS_APPKIT_PRESENTATION_BUSY",
        "Another event-bound AppKit presentation request is still active."
      ));
    }
    const admittedRequest = Object.freeze({ ...request });
    if (nativePresentation(this.#input.native) === admittedRequest.presentation) {
      try {
        const projection = this.#verifiedProjection(admittedRequest);
        if (supersedesAwaiting) {
          this.#awaitingCoreProjection = admittedRequest;
        }
        return Promise.resolve(projection);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.#awaitingCoreProjection = null;

    const pending: PendingPresentation = {
      completion: deferred<ChromiumRuntimeHostProjection>(),
      request: admittedRequest
    };
    this.#pending = pending;
    try {
      if (request.presentation === "fullscreen") {
        this.#input.prepareFullscreen(true);
      }
      this.#input.native.setFullScreen(request.presentation === "fullscreen");
    } catch (error) {
      this.#pending = null;
      if (request.presentation === "fullscreen") {
        try {
          this.#input.prepareFullscreen(false);
        } catch {
          const compensation = presentationError(
            "ELECTRON_MACOS_APPKIT_PRESENTATION_COMPENSATION_FAILED",
            "The AppKit fullscreen submission could not restore its native chrome."
          );
          pending.completion.reject(compensation);
          return pending.completion.promise;
        }
      }
      pending.completion.reject(error);
    }
    return pending.completion.promise;
  }

  /** Claims programmatic placement callbacks for the requesting Core effect. */
  observeWindowPlacement(): boolean {
    if (this.#awaitingCoreProjection) return true;
    const pending = this.#pending;
    if (!pending) return false;
    if (pending.initial) {
      try { this.#requireInitialPending(pending); }
      catch (error) { this.#rejectPending(pending, error); return true; }
    }
    if (nativePresentation(this.#input.native) !== pending.request.presentation) {
      return true;
    }
    if (pending.initial && !pending.initial.submitted) {
      pending.initial.acknowledged = true;
      return true;
    }
    this.#completePlacement(pending);
    return true;
  }

  #completePlacement(pending: PendingPresentation): void {
    if (this.#pending !== pending) return;
    try {
      if (pending.initial) this.#requireInitialPending(pending);
      const projection = this.#verifiedProjection(
        pending.request, pending.initial?.readProjection
      );
      if (pending.initial) this.#requireInitialPending(pending);
      this.#pending = null;
      this.#awaitingCoreProjection = pending.initial ? null : pending.request;
      pending.completion.resolve(projection);
    } catch (error) {
      this.#rejectPending(pending, error);
    }
  }

  suppressWindowStateEvent(): boolean {
    return this.#pending !== null || this.#awaitingCoreProjection !== null;
  }

  coreProjectionApplied(input: Readonly<{
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
  }>): void {
    const pending = this.#pending;
    if (pending?.initial && input.windowId === pending.request.windowId && (
      input.windowGeneration !== pending.request.windowGeneration ||
      input.topologyRevision !== pending.request.topologyRevision
    )) {
      this.#rejectPending(pending, presentationError(
        "ELECTRON_MACOS_APPKIT_PRESENTATION_FENCE_STALE",
        "A newer Core projection superseded initial AppKit presentation."
      ));
    }
    const awaiting = this.#awaitingCoreProjection;
    if (
      !awaiting || input.windowId !== awaiting.windowId ||
      input.windowGeneration !== awaiting.windowGeneration ||
      !Number.isSafeInteger(input.topologyRevision) ||
      input.topologyRevision <= awaiting.topologyRevision ||
      nativePresentation(this.#input.native) !== awaiting.presentation
    ) {
      return;
    }
    this.#awaitingCoreProjection = null;
  }

  close(error: unknown = presentationError(
    "ELECTRON_MACOS_APPKIT_PRESENTATION_CLOSED",
    "The AppKit runtime host closed before presentation terminalized."
  )): void {
    const pending = this.#pending;
    this.#awaitingCoreProjection = null;
    if (!pending) return;
    this.#pending = null;
    pending.completion.reject(error);
  }

  #matchesAdmissionFence(
    request: ChromiumRuntimeWindowPresentationRequest,
    fence: MacosAppKitRuntimePresentationFence,
    supersedesAwaiting: boolean
  ): boolean {
    const exactCurrentFence = request.topologyRevision === fence.topologyRevision;
    const compensationFence = supersedesAwaiting &&
      request.topologyRevision >= fence.topologyRevision;
    return fence.current && !this.#input.native.isDestroyed() &&
      request.windowId === fence.windowId &&
      request.windowGeneration === fence.windowGeneration &&
      (exactCurrentFence || compensationFence) &&
      Number.isSafeInteger(request.windowGeneration) &&
      request.windowGeneration > 0 &&
      Number.isSafeInteger(request.topologyRevision) &&
      request.topologyRevision > 0;
  }

  #requireInitialFence(request: ChromiumRuntimeWindowPresentationRequest): void {
    if (!this.#matchesAdmissionFence(request, this.#input.readFence(), false) ||
        !this.#input.native.isVisible() || this.#input.native.isMinimized()) {
      throw presentationError("ELECTRON_MACOS_APPKIT_PRESENTATION_FENCE_STALE",
        "Initial AppKit presentation lost its exact visible Core-owned host.");
    }
  }

  #requireInitialPending(pending: PendingPresentation): void {
    if (this.#pending !== pending) {
      throw presentationError("ELECTRON_MACOS_APPKIT_PRESENTATION_FENCE_STALE",
        "The initial AppKit presentation request no longer owns its native lane.");
    }
    pending.initial!.requireCurrent();
    this.#requireInitialFence(pending.request);
  }

  #supersedesAwaitingProjection(
    request: ChromiumRuntimeWindowPresentationRequest
  ): boolean {
    const awaiting = this.#awaitingCoreProjection;
    return awaiting !== null &&
      request.windowId === awaiting.windowId &&
      request.windowGeneration === awaiting.windowGeneration &&
      request.topologyRevision > awaiting.topologyRevision;
  }

  #verifiedProjection(
    request: ChromiumRuntimeWindowPresentationRequest,
    readProjection = this.#input.readProjection
  ): ChromiumRuntimeHostProjection {
    const projection = readProjection();
    if (projection.presentation !== request.presentation) {
      throw presentationError(
        "ELECTRON_MACOS_APPKIT_PRESENTATION_READBACK_MISMATCH",
        "The AppKit presentation event completed without its exact native readback."
      );
    }
    return projection;
  }

  #rejectPending(pending: PendingPresentation, error: unknown): void {
    if (this.#pending !== pending) return;
    this.#pending = null;
    pending.completion.reject(error);
  }
}
