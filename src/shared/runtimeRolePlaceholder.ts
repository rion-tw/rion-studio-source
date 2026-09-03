export const RUNTIME_ROLE_PLACEHOLDER_CHANNEL =
  "rion:runtime-role-placeholder:action";
export const RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL =
  "rion:runtime-role-placeholder:state";
export const RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION =
  "rion-web-chrome-shell:memory";

export interface RuntimeRolePlaceholderIdentity {
  readonly generation: number;
  readonly ownerGeneration: number;
  readonly placeholderId: string;
  readonly roleId: string;
  readonly slotId: string;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export type RuntimeRolePlaceholderAction =
  | Readonly<{ type: "ready" }>
  | Readonly<RuntimeRolePlaceholderIdentity & { type: "claim" }>;

export interface RuntimeRolePlaceholderState
extends RuntimeRolePlaceholderIdentity {
  readonly blocked: boolean;
  readonly ownerTabName: string | null;
  readonly roleName: string;
}

export interface RuntimeRolePlaceholderClaimReceipt
extends RuntimeRolePlaceholderIdentity {
  readonly status: "applied";
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function displayText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

const IDENTITY_KEYS = [
  "generation",
  "ownerGeneration",
  "placeholderId",
  "roleId",
  "slotId",
  "tabId",
  "topologyRevision",
  "windowGeneration",
  "windowId"
] as const;

function identity(
  value: Readonly<Record<string, unknown>>
): value is Readonly<Record<keyof RuntimeRolePlaceholderIdentity, unknown>> {
  return positiveInteger(value.generation) &&
    positiveInteger(value.ownerGeneration) && identifier(value.placeholderId) &&
    identifier(value.roleId) && identifier(value.slotId) && identifier(value.tabId) &&
    positiveInteger(value.topologyRevision) &&
    positiveInteger(value.windowGeneration) && identifier(value.windowId);
}

export function parseRuntimeRolePlaceholderAction(
  value: unknown
): RuntimeRolePlaceholderAction | null {
  if (!record(value)) return null;
  if (value.type === "ready") {
    return exactKeys(value, ["type"]) ? Object.freeze({ type: "ready" }) : null;
  }
  if (
    value.type !== "claim" ||
    !exactKeys(value, [...IDENTITY_KEYS, "type"]) ||
    !identity(value)
  ) return null;
  return Object.freeze(value) as unknown as RuntimeRolePlaceholderAction;
}

export function parseRuntimeRolePlaceholderState(
  value: unknown
): RuntimeRolePlaceholderState | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      ...IDENTITY_KEYS,
      "blocked",
      "ownerTabName",
      "roleName"
    ]) ||
    !identity(value) || typeof value.blocked !== "boolean" ||
    (value.ownerTabName !== null && !displayText(value.ownerTabName)) ||
    !displayText(value.roleName)
  ) return null;
  return Object.freeze(value) as unknown as RuntimeRolePlaceholderState;
}

export function parseRuntimeRolePlaceholderClaimReceipt(
  value: unknown
): RuntimeRolePlaceholderClaimReceipt | null {
  if (
    !record(value) ||
    !exactKeys(value, [...IDENTITY_KEYS, "status"]) ||
    !identity(value) || value.status !== "applied"
  ) return null;
  return Object.freeze(value) as unknown as RuntimeRolePlaceholderClaimReceipt;
}
