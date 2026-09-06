import type { ChromiumViewAttachmentCoordinator } from "./chromiumViewAttachmentCoordinator";
import type { ChromiumViewInputSubmission } from "./chromiumViewInputSubmission";
import { chromiumViewInputObservationKey, sameChromiumViewInputIdentity,
  validChromiumViewInputObservation } from "./chromiumViewTrustedInputValidation";
import type { ChromiumNativeTrustedInputReceipt, ChromiumNativeTrustedInputRequest } from "./chromiumTrustedInputCoordinator";
import type { ChromiumViewTrustedInputProbeReceipt, WindowsChromiumInputDeliveryMode,
  WindowsChromiumInputSurfaceIdentity, WindowsChromiumTrustedInputHostBinding,
  WindowsChromiumTrustedInputHostPort, RawNativeWindowsChromiumTrustedInputHost } from "./windowsChromiumTrustedInputContract";

type Attachment = NonNullable<ReturnType<ChromiumViewAttachmentCoordinator["resolve"]>>;

/** Adapts exact View ownership to the existing single trusted-DOM receipt lane. */
export class ChromiumViewTrustedInputHost implements WindowsChromiumTrustedInputHostPort {
  readonly #attachments: Pick<ChromiumViewAttachmentCoordinator, "resolve">;
  readonly #focus: (request: ChromiumNativeTrustedInputRequest) => Promise<ChromiumNativeTrustedInputReceipt>;
  readonly #bindings = new WeakMap<ChromiumViewInputSubmission, WindowsChromiumTrustedInputHostBinding>();

  constructor(input: { attachments: Pick<ChromiumViewAttachmentCoordinator, "resolve">;
    focus: (request: ChromiumNativeTrustedInputRequest) => Promise<ChromiumNativeTrustedInputReceipt> }) {
    this.#attachments = input.attachments;
    this.#focus = input.focus;
  }

  resolve(roleId: string, generation: number): WindowsChromiumTrustedInputHostBinding | null {
    const attachment = this.#attachments.resolve(roleId, generation);
    if (!attachment || attachment.identity.roleId !== roleId || attachment.identity.surfaceGeneration !== generation) return null;
    const prior = this.#bindings.get(attachment.input);
    if (prior) return prior;
    const binding = this.#create(attachment);
    this.#bindings.set(attachment.input, binding);
    return binding;
  }

  #create(attachment: Attachment): WindowsChromiumTrustedInputHostBinding {
    const identity = Object.freeze({ ...attachment.identity, ownerKind: "view" as const });
    let lastObservation = "";
    let revision = 0n;
    const requireCurrent = (expected: WindowsChromiumInputSurfaceIdentity): void => {
      const current = this.#attachments.resolve(identity.roleId, identity.surfaceGeneration);
      if (expected.ownerKind !== "view" || !sameChromiumViewInputIdentity(expected, identity) ||
          !current || current.input !== attachment.input || !sameChromiumViewInputIdentity(current.identity, identity)) {
        throw new Error("The exact View input binding was superseded.");
      }
    };
    const probe = (expected: WindowsChromiumInputSurfaceIdentity,
      deliveryMode: WindowsChromiumInputDeliveryMode): ChromiumViewTrustedInputProbeReceipt => {
      requireCurrent(expected);
      const raw = attachment.observe();
      if (!validChromiumViewInputObservation(raw, identity, deliveryMode)) {
        throw new Error("The exact View input observation is not ready.");
      }
      const observation = Object.freeze({ ...raw, identity: Object.freeze({ ...raw.identity }),
        bounds: Object.freeze({ ...raw.bounds }) });
      const key = chromiumViewInputObservationKey(observation);
      if (key !== lastObservation) {
        if (revision >= 18_446_744_073_709_551_615n) throw new Error("View probe revision exhausted.");
        revision += 1n;
        lastObservation = key;
      }
      return Object.freeze({ ...identity, status: "verified", deliveryMode,
        probeRevision: String(revision), observation });
    };
    return Object.freeze({ identity, native: Object.freeze<RawNativeWindowsChromiumTrustedInputHost>({
      focusForeground: (expected, request) => {
        requireCurrent(expected);
        if (request.action.type !== "focus" || request.roleId !== identity.roleId || request.surfaceGeneration !== identity.surfaceGeneration) {
          throw new Error("View focus admission belongs to another surface.");
        }
        return this.#focus(request);
      },
      currentInputDeliveryMode: expected => {
        requireCurrent(expected);
        const observation = attachment.observe();
        const mode = observation.viewVisible ? "foreground" : "background";
        return validChromiumViewInputObservation(observation, identity, mode) ? mode : null;
      },
      isInputReady: (expected, mode) => {
        try { probe(expected, mode); return true; } catch { return false; }
      },
      probeExactInputSurface: probe,
      submitNativeBackgroundKey: (expected, request) => {
        const before = probe(expected, request.deliveryMode);
        return Object.freeze({ ...attachment.input.key(request), probeRevision: before.probeRevision });
      },
      submitNativeBackgroundMouse: (expected, request) => {
        const before = probe(expected, request.deliveryMode);
        return Object.freeze({ ...attachment.input.click(request), probeRevision: before.probeRevision });
      }
    }) });
  }
}
