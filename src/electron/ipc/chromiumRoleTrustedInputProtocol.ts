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
  | "auxclick";

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
}

export interface ChromiumRoleTrustedInputArmEnvelope
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "arm";
  readonly expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  /** Exact isolated-world guard acknowledged before native input submission. */
  readonly shortcutSuppression: ChromiumRoleTrustedInputShortcutSuppression | null;
}

export interface ChromiumRoleTrustedInputCancelEnvelope
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "cancel";
}

export type ChromiumRoleTrustedInputControlEnvelope =
  | ChromiumRoleTrustedInputArmEnvelope
  | ChromiumRoleTrustedInputCancelEnvelope;

export interface ChromiumRoleTrustedInputArmedReceipt
  extends ChromiumRoleTrustedInputIdentity {
  readonly kind: "armed";
  readonly expectedEventCount: number;
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
  readonly observedIndex: number;
  readonly isTrusted: boolean;
  readonly matches: boolean;
}

export type ChromiumRoleTrustedInputReceipt =
  | ChromiumRoleTrustedInputArmedReceipt
  | ChromiumRoleTrustedInputRejectedReceipt
  | ChromiumRoleTrustedInputCancelledReceipt
  | ChromiumRoleTrustedInputDomReceipt;
