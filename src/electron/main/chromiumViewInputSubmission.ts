import { validChromiumViewInputIdentity, validChromiumViewInputObservation,
  chromiumViewInputObservationKey } from "./chromiumViewTrustedInputValidation";
import { sendChromiumClick, sendChromiumKey } from "./chromiumWebContentsInput";

export interface ChromiumViewInputIdentity {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly nativeGeneration: number;
  readonly bindingRevision: string;
  readonly parentIdentity: string;
  readonly webContentsId: number;
}

/** Native adapters supply read-only parent evidence; a View is never an HWND. */
export interface ChromiumViewInputObservation {
  readonly identity: ChromiumViewInputIdentity;
  readonly focusIdentity: string;
  readonly parentForeground: boolean;
  readonly parentVisible: boolean;
  readonly parentMinimized: boolean;
  readonly viewAttached: boolean;
  readonly viewVisible: boolean;
  readonly contentsDestroyed: boolean;
  readonly contentsFocused: boolean;
  readonly focusedWebContentsId: number | null;
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly zoomFactor: number;
}

interface Owner {
  readonly identity: ChromiumViewInputIdentity;
  readonly contents: Parameters<typeof sendChromiumKey>[0] & {
    readonly id: number; isDestroyed: () => boolean;
  };
  /** Must validate exact native parent and current View membership on every read. */
  readonly observe: () => ChromiumViewInputObservation;
  readonly nowMs: () => number;
}

interface Request {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly requestId: string;
  readonly inputEpoch: string;
  readonly deadlineMs: string;
  readonly deliveryMode: "foreground" | "background";
}

function positiveU64(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}

/** Submission evidence only. The trusted DOM receipt remains a separate requirement. */
export class ChromiumViewInputSubmission {
  readonly #owner: Owner;
  #sequence = 0n;
  #submitting = false;

  constructor(owner: Owner) {
    this.#owner = { ...owner, identity: Object.freeze({ ...owner.identity }) };
    const identity = this.#owner.identity;
    if (owner.contents.id !== identity.webContentsId || owner.contents.isDestroyed() ||
        !validChromiumViewInputIdentity(identity)) {
      throw new Error("Chromium View input requires an exact bound identity.");
    }
  }

  key(request: Request & Parameters<typeof sendChromiumKey>[1]) {
    return this.#submit(request, contents => sendChromiumKey(contents, request));
  }

  click(request: Request & Parameters<typeof sendChromiumClick>[1]) {
    return this.#submit(request, (contents, observation) => {
      if (request.zoomFactor !== observation.zoomFactor) {
        throw new Error("Chromium View input zoom no longer matches its owner.");
      }
      return sendChromiumClick(contents, request, observation.bounds);
    });
  }

  #submit<Value>(request: Request, deliver: (
    contents: Parameters<typeof sendChromiumKey>[0], observation: ChromiumViewInputObservation
  ) => Value) {
    if (this.#submitting) throw new Error("Chromium View input submission is already active.");
    this.#submitting = true;
    try {
      return this.#submitExact(request, deliver);
    } finally {
      this.#submitting = false;
    }
  }

  #submitExact<Value>(request: Request, deliver: (
    contents: Parameters<typeof sendChromiumKey>[0], observation: ChromiumViewInputObservation
  ) => Value) {
    const owner = this.#owner;
    const deadline = Number(request.deadlineMs);
    const before = owner.observe();
    const validClock = () => {
      const now = owner.nowMs();
      if (!Number.isSafeInteger(now) || now < 0 || now >= deadline) {
        throw new Error("Chromium View input deadline expired or its clock is invalid.");
      }
      return now;
    };
    if (!request.requestId || !(request.inputEpoch === "0" || positiveU64(request.inputEpoch)) ||
        !positiveU64(request.deadlineMs) || !Number.isSafeInteger(deadline) ||
        request.roleId !== owner.identity.roleId ||
        request.surfaceGeneration !== owner.identity.surfaceGeneration ||
        owner.contents.id !== owner.identity.webContentsId || owner.contents.isDestroyed() ||
        (request.deliveryMode !== "foreground" && request.deliveryMode !== "background") ||
        !validChromiumViewInputObservation(before, owner.identity, request.deliveryMode)) {
      throw new Error("Chromium View input lost its exact owner, focus or geometry.");
    }
    validClock();
    if (this.#sequence >= 18_446_744_073_709_551_615n) {
      throw new Error("Chromium View input sequence exhausted.");
    }
    // Snapshot bytes before delivery: an adapter must not mutate a shared object
    // to make a changed observation compare equal to its prior reference.
    const observation = Object.freeze({ ...before, identity: Object.freeze({ ...before.identity }),
      bounds: Object.freeze({ ...before.bounds }) });
    const fingerprint = chromiumViewInputObservationKey(observation);
    const verify = () => {
      validClock();
      if (owner.contents.id !== owner.identity.webContentsId || owner.contents.isDestroyed() ||
          chromiumViewInputObservationKey(owner.observe()) !== fingerprint) {
        throw new Error("Chromium View input ownership changed during submission.");
      }
    };
    const result = deliver({ sendInputEvent(event) {
      verify();
      owner.contents.sendInputEvent(event);
    } }, before);
    verify();
    return Object.freeze({
      ...owner.identity, ownerKind: "view" as const, observation, status: "submitted" as const,
      requestId: request.requestId, inputEpoch: request.inputEpoch,
      deliveryMode: request.deliveryMode, dispatchSequence: String(++this.#sequence),
      submittedAtMs: String(validClock()), focusIdentity: before.focusIdentity,
      viewAttached: true as const, foregroundPreserved: true as const,
      ...result
    });
  }
}
