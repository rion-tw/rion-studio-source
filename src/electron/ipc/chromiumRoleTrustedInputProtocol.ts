export const CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL =
  "rion:chromium-role-trusted-input:arm:v1";
export const CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL =
  "rion:chromium-role-trusted-input:receipt:v1";

export type ChromiumRoleTrustedInputEventType =
  | "keydown"
  | "keyup"
  | "mousedown"
  | "mouseup"
  | "click"
  | "auxclick"
  | "contextmenu";

export interface ChromiumRoleTrustedInputExpectedEvent {
  readonly type: ChromiumRoleTrustedInputEventType;
  readonly code: string | null;
  readonly button: number | null;
  /** Null in an arm means main will correlate the native-canonical coordinate. */
  readonly clientX: number | null;
  readonly clientY: number | null;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
}

export interface ChromiumRoleTrustedInputIdentity {
  readonly roleId: string;
  readonly generation: number;
  readonly frameToken: string;
  readonly inputSequence: string;
}

export interface ChromiumRoleTrustedInputShortcutSuppression {
  readonly code: string;
  readonly phases: readonly ("keydown" | "keyup")[];
  readonly repeat: boolean;
}

export interface ChromiumRoleTrustedInputModifierTransition {
  readonly code: string;
  readonly phase: "rawKeyDown" | "keyUp";
}

export type ChromiumRoleTrustedInputModifierDisposition =
  | "dispatch"
  | "adoptPhysical"
  | "releaseOwnership";

export interface ChromiumRoleTrustedInputArmEnvelope
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "arm";
  readonly expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  /** Exact isolated-world guard acknowledged before native input submission. */
  readonly shortcutSuppression: ChromiumRoleTrustedInputShortcutSuppression | null;
  /** Exact-side macro ownership transition resolved inside the isolated world. */
  readonly modifierTransition: ChromiumRoleTrustedInputModifierTransition | null;
}

export interface ChromiumRoleTrustedInputCancelEnvelope
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "cancel";
  /** True only after main reached the exact authoritative applied terminal. */
  readonly committed: boolean;
}

export type ChromiumRoleTrustedInputControlEnvelope =
  | ChromiumRoleTrustedInputArmEnvelope
  | ChromiumRoleTrustedInputCancelEnvelope;

export interface ChromiumRoleTrustedInputArmedReceipt
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "armed";
  readonly expectedEventCount: number;
  readonly physicalModifierCodes: readonly string[];
  readonly modifierDisposition: ChromiumRoleTrustedInputModifierDisposition;
}

export interface ChromiumRoleTrustedInputRejectedReceipt
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "rejected";
  readonly reason: "busy" | "invalid-control" | "stale-frame";
}

export interface ChromiumRoleTrustedInputCancelledReceipt
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "cancelled";
}

export interface ChromiumRoleTrustedInputDomReceipt
  extends ChromiumRoleTrustedInputIdentity,
    ChromiumRoleTrustedInputExpectedEvent {
  readonly kind: "input";
  /** Monotonic for every trusted/untrusted DOM observation in this arm. */
  readonly observationSequence: number;
  readonly isTrusted: boolean;
}

export type ChromiumRoleTrustedInputReceipt =
  | ChromiumRoleTrustedInputArmedReceipt
  | ChromiumRoleTrustedInputRejectedReceipt
  | ChromiumRoleTrustedInputCancelledReceipt
  | ChromiumRoleTrustedInputDomReceipt;
