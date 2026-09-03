const ROLE_PLACEHOLDER_SHELL_SESSION =
  "rion-web-chrome-shell:memory" as const;

interface AppKitIdentity {
  readonly launchGeneration: string;
  readonly logicalWindowId: string;
  readonly nativeGeneration: number;
}

interface NativeRoleOwner {
  readonly appKitIdentity: AppKitIdentity | null;
  readonly attemptGeneration: string;
  readonly bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
  readonly generation: number;
  readonly hostKind: "appkit-chromium" | "bundled-chromium";
  readonly ownerGeneration: number;
  readonly parentNativeHostId: number;
  readonly roleId: string;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly visible: boolean;
  readonly windowGeneration: number;
  readonly windowId: string;
}

interface PlaceholderEvidence {
  readonly appKitIdentity: AppKitIdentity | null;
  readonly attemptGeneration: string;
  readonly blocked: true;
  readonly bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
  readonly generation: number;
  readonly hostKind: "appkit-chromium" | "bundled-chromium";
  readonly nativeHostId: number;
  readonly ownerGeneration: number;
  readonly ownerTabName: string;
  readonly placeholderId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly shellSession: typeof ROLE_PLACEHOLDER_SHELL_SESSION;
  readonly shellStoragePath: null;
  readonly shellUrl: string;
  readonly slotId: string;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly visible: boolean;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface ElectronDesktopE2eRolePlaceholderInspection {
  readonly coreOwner: Readonly<{
    generation: number;
    roleId: string;
    slotId: string;
    state: "running";
    tabId: string;
    windowId: string;
  }>;
  readonly coreStatus: Readonly<{
    automationState: "ready" | "unavailable" | null;
    hostKind: "appkit-chromium" | "bundled-chromium";
    issueReason: "macro-input-unavailable" | "runtime-crashed" |
      "runtime-creation-failed" | "session-migration-required" |
      "trusted-input-unavailable" | null;
    overlayState: "ready" | "unavailable" | null;
    pageHealth: "healthy" | "unresponsive" | null;
    resolvedEngine: "chromium";
    roleId: string;
    runtimeMode: "embedded";
    state: "running";
  }>;
  readonly nativeOwner: NativeRoleOwner;
  readonly phase: "activating" | "attaching" | "degraded" | "dormant" |
    "failed" | "loading" | "ready";
  readonly placeholders: readonly PlaceholderEvidence[];
  readonly roleId: string;
}

const IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function slotIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim();
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function bounds(value: unknown): value is PlaceholderEvidence["bounds"] {
  return record(value) && exact(value, ["height", "width", "x", "y"]) &&
    [value.height, value.width, value.x, value.y].every(Number.isSafeInteger) &&
    Number(value.height) > 0 && Number(value.width) > 0 &&
    Number(value.x) >= 0 && Number(value.y) >= 0;
}

function appKitIdentity(
  value: unknown,
  windowId: string
): value is AppKitIdentity {
  return record(value) && exact(value, [
    "launchGeneration", "logicalWindowId", "nativeGeneration"
  ]) && identifier(value.launchGeneration) &&
    value.logicalWindowId === windowId && positiveInteger(value.nativeGeneration);
}

function exactHost(
  candidate: Record<string, unknown>,
  nativeHostKey: "nativeHostId" | "parentNativeHostId"
): boolean {
  if (!identifier(candidate.attemptGeneration) ||
      !positiveInteger(candidate[nativeHostKey]) ||
      !positiveInteger(candidate.topologyRevision) ||
      !positiveInteger(candidate.windowGeneration) ||
      !identifier(candidate.windowId)) return false;
  if (candidate.hostKind === "appkit-chromium") {
    return appKitIdentity(
      candidate.appKitIdentity,
      candidate.windowId
    );
  }
  return candidate.hostKind === "bundled-chromium" &&
    candidate.appKitIdentity === null;
}

function coreOwner(
  value: unknown,
  roleId: string
): value is ElectronDesktopE2eRolePlaceholderInspection["coreOwner"] {
  return record(value) && exact(value, [
    "generation", "roleId", "slotId", "state", "tabId", "windowId"
  ]) && positiveInteger(value.generation) && value.roleId === roleId &&
    slotIdentifier(value.slotId) && value.state === "running" &&
    identifier(value.tabId) && identifier(value.windowId);
}

function coreStatus(
  value: unknown,
  roleId: string
): value is ElectronDesktopE2eRolePlaceholderInspection["coreStatus"] {
  return record(value) && exact(value, [
    "automationState", "hostKind", "issueReason", "overlayState", "pageHealth",
    "resolvedEngine", "roleId", "runtimeMode", "state"
  ]) && ["ready", "unavailable", null].includes(
    value.automationState as "ready" | "unavailable" | null
  ) && ["appkit-chromium", "bundled-chromium"].includes(String(value.hostKind)) &&
    ["macro-input-unavailable", "runtime-crashed", "runtime-creation-failed",
      "session-migration-required", "trusted-input-unavailable", null].includes(
      value.issueReason as ElectronDesktopE2eRolePlaceholderInspection[
        "coreStatus"
      ]["issueReason"]
    ) && ["ready", "unavailable", null].includes(
      value.overlayState as "ready" | "unavailable" | null
    ) && ["healthy", "unresponsive", null].includes(
      value.pageHealth as "healthy" | "unresponsive" | null
    ) && value.resolvedEngine === "chromium" && value.roleId === roleId &&
    value.runtimeMode === "embedded" && value.state === "running";
}

function nativeOwner(
  value: unknown,
  owner: ElectronDesktopE2eRolePlaceholderInspection["coreOwner"]
): value is NativeRoleOwner {
  return record(value) && exact(value, [
    "appKitIdentity", "attemptGeneration", "bounds", "generation", "hostKind",
    "ownerGeneration", "parentNativeHostId", "roleId", "tabId",
    "topologyRevision", "visible", "windowGeneration", "windowId"
  ]) && exactHost(value, "parentNativeHostId") && bounds(value.bounds) &&
    positiveInteger(value.generation) && value.ownerGeneration === owner.generation &&
    value.roleId === owner.roleId && value.tabId === owner.tabId &&
    value.windowId === owner.windowId && typeof value.visible === "boolean";
}

function placeholder(
  value: unknown,
  owner: ElectronDesktopE2eRolePlaceholderInspection["coreOwner"]
): value is PlaceholderEvidence {
  if (!record(value) || !exact(value, [
    "appKitIdentity", "attemptGeneration", "blocked", "bounds", "generation",
    "hostKind", "nativeHostId", "ownerGeneration", "ownerTabName",
    "placeholderId", "roleId", "roleName", "shellSession", "shellStoragePath",
    "shellUrl", "slotId", "tabId", "topologyRevision", "visible",
    "windowGeneration", "windowId"
  ]) || !exactHost(value, "nativeHostId") || value.blocked !== true ||
      !bounds(value.bounds) || !positiveInteger(value.generation) ||
      value.ownerGeneration !== owner.generation || value.roleId !== owner.roleId ||
      typeof value.ownerTabName !== "string" || value.ownerTabName.length === 0 ||
      typeof value.roleName !== "string" || value.roleName.length === 0 ||
      typeof value.placeholderId !== "string" ||
      value.placeholderId !== `role-placeholder:${String(value.tabId)}:${String(value.slotId)}` ||
      !slotIdentifier(value.slotId) || !identifier(value.tabId) ||
      value.tabId === owner.tabId || value.shellSession !== ROLE_PLACEHOLDER_SHELL_SESSION ||
      value.shellStoragePath !== null || typeof value.shellUrl !== "string" ||
      typeof value.visible !== "boolean") return false;
  try {
    const shellUrl = new URL(value.shellUrl);
    return shellUrl.protocol === "file:" && shellUrl.href === value.shellUrl &&
      shellUrl.pathname.endsWith("/runtime-role-placeholder-electron.html");
  } catch {
    return false;
  }
}

export function parseElectronDesktopE2eRolePlaceholderInspection(
  candidate: unknown
): ElectronDesktopE2eRolePlaceholderInspection {
  if (!record(candidate) || !exact(candidate, [
    "coreOwner", "coreStatus", "nativeOwner", "phase", "placeholders", "roleId"
  ]) || !identifier(candidate.roleId)) {
    throw new Error("Electron desktop E2E Role placeholder inspection is invalid.");
  }
  const owner = candidate.coreOwner;
  if (!coreOwner(owner, candidate.roleId)) {
    throw new Error("Electron desktop E2E Role placeholder inspection is invalid.");
  }
  if (!coreStatus(candidate.coreStatus, candidate.roleId) ||
      !nativeOwner(candidate.nativeOwner, owner) ||
      candidate.coreStatus.hostKind !== candidate.nativeOwner.hostKind ||
      !["activating", "attaching", "degraded", "dormant", "failed", "loading",
        "ready"].includes(String(candidate.phase)) ||
      !Array.isArray(candidate.placeholders) || candidate.placeholders.length > 1 ||
      !candidate.placeholders.every((value) => placeholder(value, owner))) {
    throw new Error("Electron desktop E2E Role placeholder inspection is invalid.");
  }
  return candidate as unknown as ElectronDesktopE2eRolePlaceholderInspection;
}
