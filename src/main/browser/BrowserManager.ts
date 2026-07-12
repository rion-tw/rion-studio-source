import { EventEmitter } from "node:events";
import { join } from "node:path";

import type { BrowserContext, CDPSession, Page } from "playwright";

import {
  classifyAuthSession,
  NO_PERSISTED_LOGIN_SESSION_MESSAGE
} from "../auth/authSessionClassification";
import {
  isPersistedLoginStorageReady,
  readPlaywrightLoginStorageSnapshot
} from "../auth/loginEvidence";
import type { RoleStore } from "../roles/RoleStore";
import type { PixelBounds, Role, RoleStatus } from "../../shared/types";
import { withPlaywrightUserDataLockRetry } from "./playwrightUserDataRetry";

export interface BrowserManagerEvents {
  change: [RoleStatus[]];
}

export type LaunchPersistentContext = (
  userDataDir: string,
  options: LaunchPersistentContextOptions
) => Promise<BrowserContext>;
export type BrowserExecutablePathResolver = () => Promise<string | undefined>;

export const HIDDEN_BROWSER_HELPER_UNAVAILABLE_MESSAGE = "Unable to start the hidden Rion Studio browser helper.";

export interface BrowserManagerOptions {
  launchPersistentContext?: LaunchPersistentContext;
  executablePathResolver?: BrowserExecutablePathResolver;
  allowVisibleFallback?: boolean;
}

export interface BrowserLaunchOptions {
  bounds?: PixelBounds;
  zoomFactor?: number;
}

export interface BrowserAutomationSession {
  context: BrowserContext;
  page: Page;
  role: Role;
}

export type BrowserMacroOverlayInstaller = (role: Role, page: Page) => Promise<void>;

export class BrowserLaunchAuthError extends Error {
  readonly code = "LOGIN_REQUIRED_AFTER_LAUNCH";

  constructor(message = NO_PERSISTED_LOGIN_SESSION_MESSAGE) {
    super(message);
    this.name = "BrowserLaunchAuthError";
  }
}

export class BrowserHiddenHelperError extends Error {
  readonly code = "HIDDEN_BROWSER_HELPER_UNAVAILABLE";

  constructor() {
    super(HIDDEN_BROWSER_HELPER_UNAVAILABLE_MESSAGE);
    this.name = "BrowserHiddenHelperError";
  }
}

type PlaywrightChromium = typeof import("playwright")["chromium"];
type LaunchPersistentContextOptions = NonNullable<Parameters<PlaywrightChromium["launchPersistentContext"]>[1]>;

interface BrowserSession {
  role: Role;
  state: RoleStatus["state"];
  launchedAt?: string;
  context?: BrowserContext;
  page?: Page;
  zoomCdpSession?: CDPSession;
  zoomFactor?: number;
  zoomScriptIdentifier?: string;
}

const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
const WORKSPACE_ZOOM_STATE_KEY = "__rionStudioWorkspaceZoomState";

export class BrowserManager extends EventEmitter<BrowserManagerEvents> {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly launchPersistentContext: LaunchPersistentContext;
  private readonly executablePathResolver?: BrowserExecutablePathResolver;
  private readonly allowVisibleFallback: boolean;
  private macroOverlayInstaller?: BrowserMacroOverlayInstaller;

  constructor(
    private readonly roleStore: Pick<RoleStore, "ensureBrowserUserDataDir" | "updateAuthState">,
    options: BrowserManagerOptions | LaunchPersistentContext = {}
  ) {
    super();
    const normalizedOptions = typeof options === "function" ? { launchPersistentContext: options } : options;
    this.launchPersistentContext = normalizedOptions.launchPersistentContext ?? launchBundledChromium;
    this.executablePathResolver = normalizedOptions.executablePathResolver;
    this.allowVisibleFallback = normalizedOptions.allowVisibleFallback ?? true;
  }

  setMacroOverlayInstaller(installer: BrowserMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  listStatuses(): RoleStatus[] {
    return [...this.sessions.entries()].map(([roleId, session]) => ({
      roleId,
      state: session.state,
      launchedAt: session.launchedAt
    }));
  }

  getAutomationSession(roleId: string): BrowserAutomationSession | undefined {
    const session = this.sessions.get(roleId);

    if (session?.state !== "running" || !session.context || !session.page) {
      return undefined;
    }

    return {
      context: session.context,
      page: session.page,
      role: session.role
    };
  }

  async launch(role: Role, options: BrowserLaunchOptions = {}): Promise<RoleStatus> {
    const existing = this.sessions.get(role.id);

    if (existing) {
      await this.ensureSessionAuthenticated(role, existing);
      if (options.bounds) {
        await this.applyWindowBounds(existing, options.bounds);
      }
      await this.applyPageZoom(existing, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      if (existing.page) {
        await this.installMacroOverlay(role, existing.page);
      }
      await this.focusSession(existing);
      return this.toStatus(role.id, existing);
    }

    const session: BrowserSession = {
      role,
      state: "launching"
    };
    this.sessions.set(role.id, session);
    this.emitChange();

    try {
      const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
      const context = await this.launchBrowserContext(browserUserDataDir, role, options);
      const page = await getOrCreatePage(context);

      session.context = context;
      session.page = page;

      context.once("close", () => {
        this.deleteSession(role.id);
      });

      await this.applyPageZoom(session, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      await page.goto(role.launchUrl, { waitUntil: "domcontentloaded" });
      if (options.bounds) {
        await this.applyWindowBounds(session, options.bounds);
      }
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await this.ensureSessionAuthenticated(role, session);

      session.role = role;
      session.state = "running";
      session.launchedAt = new Date().toISOString();
      await this.installMacroOverlay(role, page);
      await this.focusSession(session);
      this.emitChange();

      return this.toStatus(role.id, session);
    } catch (error) {
      await session.context?.close().catch(() => undefined);
      this.deleteSession(role.id);
      throw error;
    }
  }

  async stop(roleId: string): Promise<void> {
    const session = this.sessions.get(roleId);

    if (!session) {
      return;
    }

    session.state = "stopping";
    this.emitChange();

    try {
      await session.context?.close();
    } finally {
      this.deleteSession(roleId);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((roleId) => this.stop(roleId)));
  }

  private async focusSession(session: BrowserSession): Promise<void> {
    try {
      await session.page?.bringToFront();
    } catch {
      // A closed page will be cleaned up by the context close handler.
    }
  }

  private async applyWindowBounds(session: BrowserSession, bounds: PixelBounds): Promise<void> {
    if (!session.page) {
      return;
    }

    await applyWindowBoundsToPage(session.page, bounds);
  }

  private async applyPageZoom(session: BrowserSession, zoomFactor: number): Promise<void> {
    if (!session.page || session.zoomFactor === zoomFactor) {
      return;
    }

    if (zoomFactor === DEFAULT_BROWSER_ZOOM_FACTOR && !session.zoomCdpSession) {
      session.zoomFactor = zoomFactor;
      return;
    }

    const cdpSession = session.zoomCdpSession ?? (await session.page.context().newCDPSession(session.page));
    const isNewCdpSession = !session.zoomCdpSession;

    try {
      if (isNewCdpSession) {
        await cdpSession.send("Page.enable");
        session.zoomCdpSession = cdpSession;
      }

      if (session.zoomScriptIdentifier) {
        await cdpSession.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: session.zoomScriptIdentifier
        });
        session.zoomScriptIdentifier = undefined;
      }

      const source = createPageZoomSource(zoomFactor);

      if (zoomFactor !== DEFAULT_BROWSER_ZOOM_FACTOR) {
        const result = (await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
          source
        })) as { identifier: string };
        session.zoomScriptIdentifier = result.identifier;
      }

      await cdpSession.send("Runtime.evaluate", { expression: source });
      session.zoomFactor = zoomFactor;

      if (zoomFactor === DEFAULT_BROWSER_ZOOM_FACTOR) {
        await detachCdpSession(cdpSession);
        session.zoomCdpSession = undefined;
      }
    } catch (error) {
      await detachCdpSession(cdpSession);
      session.zoomCdpSession = undefined;
      session.zoomFactor = undefined;
      session.zoomScriptIdentifier = undefined;
      throw error;
    }
  }

  private async installMacroOverlay(role: Role, page: Page): Promise<void> {
    if (!this.macroOverlayInstaller) {
      return;
    }

    try {
      await this.macroOverlayInstaller(role, page);
    } catch (error) {
      console.warn("Failed to install Rion Studio macro overlay.", error);
    }
  }

  private async ensureSessionAuthenticated(role: Role, session: BrowserSession): Promise<void> {
    if (!session.context || !session.page) {
      throw new BrowserLaunchAuthError("Unable to verify login session after launch.");
    }

    const snapshot = await readPlaywrightLoginStorageSnapshot(session.page, role.launchUrl);
    const result = classifyAuthSession(session.page.url(), snapshot.bodyText, isPersistedLoginStorageReady(snapshot));

    if (result.authState === "authenticated") {
      return;
    }

    const message = result.message ?? NO_PERSISTED_LOGIN_SESSION_MESSAGE;
    let updateError: unknown;

    try {
      await this.roleStore.updateAuthState(role.id, "login_required");
    } catch (error) {
      updateError = error;
    }

    await this.closeInvalidSession(role.id, session);

    if (updateError) {
      throw updateError;
    }

    throw new BrowserLaunchAuthError(message);
  }

  private async closeInvalidSession(roleId: string, session: BrowserSession): Promise<void> {
    await session.context?.close().catch(() => undefined);
    this.deleteSession(roleId);
  }

  private async launchBrowserContext(
    browserUserDataDir: string,
    role: Role,
    options: BrowserLaunchOptions
  ): Promise<BrowserContext> {
    const executablePath = await this.resolveExecutablePath();

    if (!executablePath && !this.allowVisibleFallback) {
      throw new BrowserHiddenHelperError();
    }

    const launchOptions = buildLaunchOptions(role, executablePath, options);

    try {
      return await withPlaywrightUserDataLockRetry(() => this.launchPersistentContext(browserUserDataDir, launchOptions));
    } catch (error) {
      if (!executablePath) {
        throw error;
      }

      if (!this.allowVisibleFallback) {
        console.warn("Failed to launch hidden Rion Studio browser helper.", error);
        throw new BrowserHiddenHelperError();
      }

      console.warn("Failed to launch hidden Rion Studio browser helper. Falling back to visible Chromium.", error);
      return withPlaywrightUserDataLockRetry(() =>
        this.launchPersistentContext(browserUserDataDir, buildLaunchOptions(role, undefined, options))
      );
    }
  }

  private async resolveExecutablePath(): Promise<string | undefined> {
    if (!this.executablePathResolver) {
      return undefined;
    }

    try {
      return await this.executablePathResolver();
    } catch (error) {
      console.warn(this.getExecutableResolutionWarning(), error);
      return undefined;
    }
  }

  private getExecutableResolutionWarning(): string {
    if (this.allowVisibleFallback) {
      return "Unable to resolve Rion Studio browser executable. Falling back to visible Chromium.";
    }

    return "Unable to resolve Rion Studio browser executable.";
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private deleteSession(roleId: string): void {
    if (this.sessions.delete(roleId)) {
      this.emitChange();
    }
  }

  private toStatus(roleId: string, session: BrowserSession): RoleStatus {
    return {
      roleId,
      state: session.state,
      launchedAt: session.launchedAt
    };
  }
}

async function launchBundledChromium(
  userDataDir: string,
  options: LaunchPersistentContextOptions
): Promise<BrowserContext> {
  configurePlaywrightBrowsersPath();
  const { chromium } = await import("playwright");
  return chromium.launchPersistentContext(userDataDir, options);
}

export function configurePlaywrightBrowsersPath(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return;
  }

  if (process.versions.electron && !process.defaultApp) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "playwright-core",
      ".local-browsers"
    );
    return;
  }

  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}

export function buildLaunchOptions(
  role: Role,
  executablePath?: string,
  launchOptions: BrowserLaunchOptions = {}
): LaunchPersistentContextOptions {
  const options: LaunchPersistentContextOptions = {
    headless: false,
    viewport: null,
    args: buildChromiumArgs(role, launchOptions.bounds)
  };

  if (executablePath) {
    options.executablePath = executablePath;
  }

  return options;
}

export function buildChromiumArgs(role: Role, bounds?: PixelBounds): string[] {
  const windowWidth = bounds?.width ?? role.windowWidth;
  const windowHeight = bounds?.height ?? role.windowHeight;
  const args = [
    `--app=${role.launchUrl}`,
    `--window-size=${windowWidth},${windowHeight}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required"
  ];

  if (bounds) {
    args.splice(2, 0, `--window-position=${bounds.x},${bounds.y}`);
  }

  if (role.launchPreset === "performance") {
    args.push(
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion"
    );
  }

  return args;
}

async function applyWindowBoundsToPage(page: Page, bounds: PixelBounds): Promise<void> {
  const session = await page.context().newCDPSession(page);

  try {
    const { windowId } = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        windowState: "normal"
      }
    });
  } finally {
    await detachCdpSession(session);
  }
}

function createPageZoomSource(zoomFactor: number): string {
  const serializedZoomFactor = JSON.stringify(zoomFactor);
  const serializedStateKey = JSON.stringify(WORKSPACE_ZOOM_STATE_KEY);

  return `(() => {
    const apply = () => {
      const root = document.documentElement;
      if (!root) return false;
      const stateKey = ${serializedStateKey};
      const existingState = root[stateKey];
      if (${serializedZoomFactor} === 1) {
        if (existingState) {
          if (existingState.value) {
            root.style.setProperty("zoom", existingState.value, existingState.priority);
          } else {
            root.style.removeProperty("zoom");
          }
          delete root[stateKey];
        }
        return true;
      }
      if (!existingState) {
        Object.defineProperty(root, stateKey, {
          configurable: true,
          value: {
            value: root.style.getPropertyValue("zoom"),
            priority: root.style.getPropertyPriority("zoom")
          }
        });
      }
      root.style.setProperty("zoom", String(${serializedZoomFactor}), "important");
      return true;
    };
    if (!apply()) {
      const observer = new MutationObserver(() => {
        if (apply()) observer.disconnect();
      });
      observer.observe(document, { childList: true });
    }
  })()`;
}

async function detachCdpSession(session: CDPSession): Promise<void> {
  await session.detach().catch(() => undefined);
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const [page] = context.pages();
  return page ?? context.newPage();
}
