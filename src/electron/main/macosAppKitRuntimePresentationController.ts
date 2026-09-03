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
}

export interface MacosAppKitRuntimePresentationControllerInput {
  readonly native: Pick<
    MacosAppKitBaseWindowPort,
    "isDestroyed" | "isFullScreen" | "isMaximized" | "setFullScreen"
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
    if (nativePresentation(this.#input.native) !== pending.request.presentation) {
      return true;
    }
    try {
      const projection = this.#verifiedProjection(pending.request);
      this.#pending = null;
      this.#awaitingCoreProjection = pending.request;
      pending.completion.resolve(projection);
    } catch (error) {
      this.#rejectPending(pending, error);
    }
    return true;
  }

  suppressWindowStateEvent(): boolean {
    return this.#pending !== null || this.#awaitingCoreProjection !== null;
  }

  coreProjectionApplied(input: Readonly<{
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
  }>): void {
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
    request: ChromiumRuntimeWindowPresentationRequest
  ): ChromiumRuntimeHostProjection {
    const projection = this.#input.readProjection();
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
