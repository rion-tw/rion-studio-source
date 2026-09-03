export type ElectronDesktopE2eWorkspaceWebSecurityPolicyObservation =
  | Readonly<{
      callback: false;
      kind: "permission-request";
      origin: string;
      permission: string;
      sequence: number;
    }>
  | Readonly<{
      defaultPrevented: true;
      kind: "will-download";
      origin: string;
      sequence: number;
      url: string;
    }>;

export interface ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection {
  readonly contentProfilePath: string;
  readonly generation: number;
  readonly observations:
    readonly ElectronDesktopE2eWorkspaceWebSecurityPolicyObservation[];
  readonly policyVersion: 1;
  readonly sessionStoragePath: string;
  readonly surfaceId: string;
  readonly windowId: string;
}

const IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value;
  } catch {
    return false;
  }
}

function canonicalWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.href === value && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function observation(
  value: unknown,
  priorSequence: number
): value is ElectronDesktopE2eWorkspaceWebSecurityPolicyObservation {
  if (!record(value) || !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) <= priorSequence || !canonicalOrigin(value.origin)) {
    return false;
  }
  if (value.kind === "permission-request") {
    return exact(value, [
      "callback", "kind", "origin", "permission", "sequence"
    ]) && value.callback === false && typeof value.permission === "string" &&
      value.permission.length > 0;
  }
  return value.kind === "will-download" && exact(value, [
    "defaultPrevented", "kind", "origin", "sequence", "url"
  ]) && value.defaultPrevented === true && canonicalWebUrl(value.url);
}

export function parseElectronDesktopE2eWorkspaceWebSecurityPolicyInspection(
  value: unknown
): ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection {
  if (!record(value) || !exact(value, [
    "contentProfilePath",
    "generation",
    "observations",
    "policyVersion",
    "sessionStoragePath",
    "surfaceId",
    "windowId"
  ]) || typeof value.contentProfilePath !== "string" ||
      value.contentProfilePath.length === 0 ||
      value.sessionStoragePath !== value.contentProfilePath ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      value.policyVersion !== 1 || typeof value.surfaceId !== "string" ||
      value.surfaceId.length === 0 || typeof value.windowId !== "string" ||
      !IDENTIFIER.test(value.windowId) || !Array.isArray(value.observations)) {
    throw new Error(
      "Electron desktop E2E Workspace Web security-policy inspection is invalid."
    );
  }
  let priorSequence = 0;
  for (const entry of value.observations) {
    if (!observation(entry, priorSequence)) {
      throw new Error(
        "Electron desktop E2E Workspace Web security-policy inspection is invalid."
      );
    }
    priorSequence = entry.sequence;
  }
  return value as unknown as ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection;
}
