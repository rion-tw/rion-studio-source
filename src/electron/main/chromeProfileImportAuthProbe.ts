import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type {
  ChromeProfileImportAuthProbePort,
  ChromeProfileImportFreshHelperAuthProbe
} from "./chromeProfileImportFreshHelper";
import { RionBridgeError } from "../ipc/errors";

type AuthState = "authenticated" | "notAuthenticated" | "indeterminate";

interface AuthProbeWebContentsPort {
  readonly session: ChromiumRoleSessionPort;
  close: (options?: { waitForBeforeUnload?: boolean }) => void;
  getURL: () => string;
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  on: (event: string, listener: (...arguments_: never[]) => void) => unknown;
  once: (event: string, listener: (...arguments_: never[]) => void) => unknown;
  removeListener: (event: string, listener: (...arguments_: never[]) => void) => unknown;
  setWindowOpenHandler: (handler: () => { action: "deny" }) => void;
}

export interface ChromeProfileImportAuthProbeViewFactoryPort {
  create: (options: {
    webPreferences: {
      backgroundThrottling: boolean;
      contextIsolation: boolean;
      devTools: boolean;
      images: boolean;
      javascript: boolean;
      nodeIntegration: boolean;
      nodeIntegrationInSubFrames: boolean;
      nodeIntegrationInWorker: boolean;
      plugins: boolean;
      sandbox: boolean;
      session: ChromiumRoleSessionPort;
      spellcheck: boolean;
      webSecurity: boolean;
    };
  }) => { readonly webContents: AuthProbeWebContentsPort };
}

function authError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validateProbe(probe: ChromeProfileImportFreshHelperAuthProbe): URL {
  let url: URL;
  try {
    url = new URL(probe.verificationUrl);
  } catch {
    throw authError(
      "CHROMIUM_PROFILE_IMPORT_AUTH_PROBE_INVALID",
      "The fresh helper authentication probe is invalid."
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !probe.authenticatedPath.startsWith("/") ||
    !probe.loginPath.startsWith("/") ||
    probe.authenticatedPath === probe.loginPath
  ) {
    throw authError(
      "CHROMIUM_PROFILE_IMPORT_AUTH_PROBE_INVALID",
      "The fresh helper authentication probe is invalid."
    );
  }
  return url;
}

async function closeContents(contents: AuthProbeWebContentsPort): Promise<void> {
  if (contents.isDestroyed()) return;
  const destroyed = new Promise<void>((resolve) => contents.once("destroyed", resolve));
  contents.close({ waitForBeforeUnload: false });
  await destroyed;
}

/** Event-bound remote auth path probe used only inside the fresh verifier. */
export class ChromeProfileImportAuthProbe implements ChromeProfileImportAuthProbePort {
  readonly #views: ChromeProfileImportAuthProbeViewFactoryPort;

  constructor(views: ChromeProfileImportAuthProbeViewFactoryPort) {
    this.#views = views;
  }

  async verify(
    session: ChromiumRoleSessionPort,
    probe: ChromeProfileImportFreshHelperAuthProbe
  ): Promise<AuthState> {
    const expected = validateProbe(probe);
    const contents = this.#views.create({
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        devTools: false,
        images: false,
        javascript: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        plugins: false,
        sandbox: true,
        session,
        spellcheck: false,
        webSecurity: true
      }
    }).webContents;
    if (contents.session !== session || contents.isDestroyed()) {
      if (!contents.isDestroyed()) await closeContents(contents);
      throw authError(
        "CHROMIUM_PROFILE_IMPORT_AUTH_SESSION_MISMATCH",
        "The authentication probe is not bound to the exact leased Session."
      );
    }
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    let terminal = false;
    let settle!: (state: AuthState) => void;
    const receipt = new Promise<AuthState>((resolve) => {
      settle = (state) => {
        if (terminal) return;
        terminal = true;
        resolve(state);
      };
    });
    const finish = () => {
      try {
        const actual = new URL(contents.getURL());
        if (actual.origin !== expected.origin) return settle("indeterminate");
        if (actual.pathname === probe.authenticatedPath) return settle("authenticated");
        if (actual.pathname === probe.loginPath) return settle("notAuthenticated");
      } catch {
        // The exact navigation URL could not be read.
      }
      settle("indeterminate");
    };
    const fail = () => settle("indeterminate");
    contents.once("did-finish-load", finish);
    contents.on("did-fail-load", fail);
    contents.once("render-process-gone", fail);
    contents.loadURL(probe.verificationUrl).catch(fail);
    // EventBound: success comes only from did-finish-load + exact URL readback.
    const result = await receipt;
    contents.removeListener("did-fail-load", fail);
    await closeContents(contents);
    return result;
  }
}
