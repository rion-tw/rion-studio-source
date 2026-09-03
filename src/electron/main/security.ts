import type { Session } from "electron";

export interface SandboxedRemoteContentWebPreferences {
  readonly preload?: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webviewTag: false;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly navigateOnDragDrop: false;
  readonly safeDialogs: true;
  readonly devTools: boolean;
  readonly spellcheck: boolean;
  /** Keep page Fullscreen API transitions inside the owning content viewport. */
  readonly disableHtmlFullscreenWindowResize?: boolean;
}

export interface SandboxedWebPreferences
extends SandboxedRemoteContentWebPreferences {
  readonly preload: string;
}

export type UnprivilegedRemoteContentWebPreferences = Readonly<
  Omit<SandboxedRemoteContentWebPreferences, "preload"> & {
    readonly preload?: never;
  }
>;

export interface SandboxedWebPreferencesInput {
  preloadPath: string;
  devTools?: boolean;
  spellcheck?: boolean;
}

function buildSandboxedPreferences(
  input: SandboxedWebPreferencesInput
): SandboxedWebPreferences {
  if (input.preloadPath.trim().length === 0) {
    throw new Error("An absolute preload path is required.");
  }
  return Object.freeze({
    preload: input.preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: input.devTools ?? false,
    spellcheck: input.spellcheck ?? false
  });
}

export function buildMainRendererWebPreferences(
  input: SandboxedWebPreferencesInput
): SandboxedWebPreferences {
  return buildSandboxedPreferences(input);
}

export function buildRemoteContentWebPreferences(
  input: SandboxedWebPreferencesInput
): SandboxedWebPreferences {
  return buildSandboxedPreferences({ ...input, devTools: input.devTools ?? false });
}

/**
 * Remote content without a preload is the least-privileged Chromium surface.
 * Workspace Web pages intentionally receive neither the role overlay nor the
 * trusted-input observation channel.
 */
export function buildUnprivilegedRemoteContentWebPreferences(
  input: Readonly<{ devTools?: boolean; spellcheck?: boolean }> = {}
): UnprivilegedRemoteContentWebPreferences {
  return Object.freeze({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: input.devTools ?? false,
    spellcheck: input.spellcheck ?? false,
    disableHtmlFullscreenWindowResize: true
  });
}

const contentSecurityPolicySessions = new WeakSet<Session>();

function loopbackDevelopmentOrigin(developmentUrl: string | undefined): URL | null {
  if (!developmentUrl) return null;
  let url: URL;
  try {
    url = new URL(developmentUrl);
  } catch {
    throw new Error("ELECTRON_RENDERER_URL must be a valid loopback URL.");
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (
    !loopbackHosts.has(url.hostname) ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("ELECTRON_RENDERER_URL must use HTTP(S) on a loopback host.");
  }
  return url;
}

export function buildMainRendererContentSecurityPolicy(
  developmentUrl?: string
): string {
  const developmentOrigin = loopbackDevelopmentOrigin(developmentUrl);
  const connectSources = ["'self'", "ipc:", "http://ipc.localhost"];
  if (developmentOrigin) {
    connectSources.push(developmentOrigin.origin);
    const websocketOrigin = new URL(developmentOrigin.origin);
    websocketOrigin.protocol = developmentOrigin.protocol === "https:" ? "wss:" : "ws:";
    connectSources.push(websocketOrigin.origin);
  }
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${connectSources.join(" ")}`
  ].join("; ");
}

export function installMainRendererContentSecurityPolicy(
  session: Session,
  developmentUrl?: string
): void {
  if (contentSecurityPolicySessions.has(session)) return;
  const policy = buildMainRendererContentSecurityPolicy(developmentUrl);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy]
      }
    });
  });
  contentSecurityPolicySessions.add(session);
}
