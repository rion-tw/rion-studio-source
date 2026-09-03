import type { App, Session } from "electron";

export type ChromiumSecuritySessionPort = Pick<
  Session,
  | "on"
  | "storagePath"
  | "setBluetoothPairingHandler"
  | "setDevicePermissionHandler"
  | "setDisplayMediaRequestHandler"
  | "setPermissionCheckHandler"
  | "setPermissionRequestHandler"
>;

export type ChromiumSessionSecurityPolicyObservation =
  | Readonly<{
      callback: false;
      kind: "permission-request";
      origin: string;
      permission: string;
      sequence: number;
    }>
  | Readonly<{
      defaultPrevented: boolean;
      kind: "will-download";
      origin: string;
      sequence: number;
      url: string;
    }>;

export interface ChromiumSessionSecurityPolicyJournal {
  readonly observations: readonly ChromiumSessionSecurityPolicyObservation[];
  readonly policyVersion: 1;
  readonly sessionStoragePath: string | null;
}

export interface ChromiumSessionSecurityPolicyOptions {
  /**
   * Global-Web content may use a user-activated main-frame Fullscreen API
   * request. Its WebContents preference keeps the transition inside the
   * existing native viewport; every other permission remains denied.
   */
  readonly allowMainFrameHtmlFullscreen?: boolean;
}

export type ChromiumCertificatePolicyAppPort = Pick<App, "on">;

const securedSessions = new WeakMap<object, boolean>();
const securedApplications = new WeakSet<object>();
const sessionJournals = new WeakMap<object, {
  readonly observations: ChromiumSessionSecurityPolicyObservation[];
  nextSequence: number;
  readonly sessionStoragePath: string | null;
}>();

const SECURITY_POLICY_OBSERVATION_CAPACITY = 256;

type UnsequencedSecurityPolicyObservation =
  ChromiumSessionSecurityPolicyObservation extends infer Observation
    ? Observation extends ChromiumSessionSecurityPolicyObservation
      ? Omit<Observation, "sequence">
      : never
    : never;

function canonicalOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function webContentsUrl(contents: unknown): string {
  if (
    typeof contents === "object" && contents !== null &&
    typeof (contents as { getURL?: unknown }).getURL === "function"
  ) {
    try {
      return (contents as { getURL: () => string }).getURL();
    } catch {
      return "";
    }
  }
  return "";
}

function permissionRequestUrl(contents: unknown, details: unknown): string {
  if (
    typeof details === "object" && details !== null &&
    typeof (details as { requestingUrl?: unknown }).requestingUrl === "string"
  ) {
    return (details as { requestingUrl: string }).requestingUrl;
  }
  return webContentsUrl(contents);
}

function isMainFramePermission(details: unknown): boolean {
  return typeof details === "object" && details !== null &&
    (details as { isMainFrame?: unknown }).isMainFrame === true;
}

function installPermissionPolicy(
  session: ChromiumSecuritySessionPort,
  allowMainFrameHtmlFullscreen: boolean
): void {
  const allowed = (permission: string, details: unknown): boolean =>
    allowMainFrameHtmlFullscreen && permission === "fullscreen" &&
      isMainFramePermission(details);
  session.setPermissionCheckHandler(
    (_contents, permission, _requestingOrigin, details) =>
      allowed(permission, details)
  );
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (allowed(permission, details)) {
      callback(true);
      return;
    }
    callback(false);
    recordSessionObservation(session, {
      callback: false,
      kind: "permission-request",
      origin: canonicalOrigin(permissionRequestUrl(contents, details)),
      permission
    });
  });
}

function recordSessionObservation(
  session: ChromiumSecuritySessionPort,
  observation: UnsequencedSecurityPolicyObservation
): void {
  const journal = sessionJournals.get(session);
  if (!journal) return;
  const record = Object.freeze({
    ...observation,
    sequence: journal.nextSequence++
  }) as ChromiumSessionSecurityPolicyObservation;
  journal.observations.push(record);
  if (journal.observations.length > SECURITY_POLICY_OBSERVATION_CAPACITY) {
    journal.observations.shift();
  }
}

/**
 * Returns a detached, read-only snapshot for one exact native Session object.
 * The journal observes deny decisions only and cannot mutate the policy.
 */
export function readChromiumSessionSecurityPolicyJournal(
  session: ChromiumSecuritySessionPort
): ChromiumSessionSecurityPolicyJournal | null {
  const journal = sessionJournals.get(session);
  if (!journal) return null;
  return Object.freeze({
    observations: Object.freeze([...journal.observations]),
    policyVersion: 1,
    sessionStoragePath: journal.sessionStoragePath
  });
}

/**
 * Installs the process-lifetime policy shared by renderer, managed-role, and
 * global Web sessions. Electron reuses Session objects by partition/path, so a
 * WeakSet prevents duplicate will-download listeners without weakening later
 * ownership leases.
 */
export function installChromiumSessionSecurityPolicy(
  session: ChromiumSecuritySessionPort,
  options: ChromiumSessionSecurityPolicyOptions = {}
): void {
  const allowMainFrameHtmlFullscreen =
    options.allowMainFrameHtmlFullscreen === true;
  if (securedSessions.has(session)) {
    if (allowMainFrameHtmlFullscreen && securedSessions.get(session) === false) {
      installPermissionPolicy(session, true);
      securedSessions.set(session, true);
    }
    return;
  }
  sessionJournals.set(session, {
    observations: [],
    nextSequence: 1,
    sessionStoragePath: session.storagePath
  });
  installPermissionPolicy(session, allowMainFrameHtmlFullscreen);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false });
  });
  session.on("will-download", (event, item, contents) => {
    event.preventDefault();
    recordSessionObservation(session, {
      defaultPrevented: event.defaultPrevented,
      kind: "will-download",
      origin: canonicalOrigin(webContentsUrl(contents)),
      url: webContentsUrl(item)
    });
  });
  securedSessions.set(session, allowMainFrameHtmlFullscreen);
}

/** Rejects invalid server certificates and implicit client-certificate use. */
export function installChromiumCertificatePolicy(
  application: ChromiumCertificatePolicyAppPort
): void {
  if (securedApplications.has(application)) return;
  application.on(
    "certificate-error",
    (event, _contents, _url, _error, _certificate, callback) => {
      event.preventDefault();
      callback(false);
    }
  );
  application.on(
    "select-client-certificate",
    (event, _contents, _url, _certificates, callback) => {
      event.preventDefault();
      callback();
    }
  );
  securedApplications.add(application);
}
