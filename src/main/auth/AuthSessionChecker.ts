import type { BrowserContext, Page } from "playwright-core";

import {
  BROWSER_USER_DATA_LOCK_TIMEOUT_MESSAGE,
  BrowserUserDataLockTimeoutError
} from "../browser/BrowserUserDataLockWatcher";
import { withPlaywrightUserDataLockRetry } from "../browser/playwrightUserDataRetry";
import { findSystemChromeExecutable } from "../system-browser/SystemChromeLauncher";
import type { RoleStore } from "../roles/RoleStore";
import type { Role } from "../../shared/types";
import {
  classifyAuthSession,
  type AuthSessionCheckResult
} from "./authSessionClassification";
import {
  isPersistedLoginStorageReady,
  readPlaywrightLoginStorageSnapshot
} from "./loginEvidence";

export { classifyAuthSession } from "./authSessionClassification";
export type { AuthSessionCheckResult } from "./authSessionClassification";

type PlaywrightChromium = typeof import("playwright-core")["chromium"];
type LaunchPersistentContextOptions = NonNullable<Parameters<PlaywrightChromium["launchPersistentContext"]>[1]>;

export type LaunchPersistentContext = (
  userDataDir: string,
  options: LaunchPersistentContextOptions
) => Promise<BrowserContext>;
export type BrowserExecutablePathResolver = () => string | Promise<string>;

export interface AuthSessionCheckerOptions {
  launchPersistentContext?: LaunchPersistentContext;
  executablePathResolver?: BrowserExecutablePathResolver;
  applyBrowserFonts?: (userDataDir: string) => Promise<void>;
}

export class AuthSessionChecker {
  private readonly launchPersistentContext: LaunchPersistentContext;
  private readonly executablePathResolver?: BrowserExecutablePathResolver;
  private readonly applyBrowserFonts?: (userDataDir: string) => Promise<void>;

  constructor(
    private readonly roleStore: Pick<RoleStore, "ensureBrowserUserDataDir">,
    options: AuthSessionCheckerOptions | LaunchPersistentContext = {}
  ) {
    const normalizedOptions = typeof options === "function" ? { launchPersistentContext: options } : options;
    this.launchPersistentContext = normalizedOptions.launchPersistentContext ?? launchCheckContext;
    this.executablePathResolver = normalizedOptions.executablePathResolver;
    this.applyBrowserFonts = normalizedOptions.applyBrowserFonts;
  }

  async check(role: Role): Promise<AuthSessionCheckResult> {
    const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
    await this.applyBrowserFonts?.(browserUserDataDir).catch((error) => {
      console.warn("Failed to apply browser font settings before session check.", error);
    });
    const executablePath = await this.resolveExecutablePath();
    const context = await withPlaywrightUserDataLockRetry(() =>
      this.launchPersistentContext(browserUserDataDir, buildCheckOptions(role, executablePath))
    ).catch((error) => {
      if (error instanceof BrowserUserDataLockTimeoutError) {
        return undefined;
      }

      throw error;
    });

    if (!context) {
      return {
        authState: "auth_failed",
        message: BROWSER_USER_DATA_LOCK_TIMEOUT_MESSAGE
      };
    }

    try {
      const page = await getOrCreatePage(context);
      await page.goto(role.launchUrl, { timeout: 15_000, waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

      const snapshot = await readPlaywrightLoginStorageSnapshot(page, role.launchUrl);
      return classifyAuthSession(page.url(), snapshot.bodyText, isPersistedLoginStorageReady(snapshot));
    } catch (error) {
      return {
        authState: "auth_failed",
        message: error instanceof Error ? error.message : "Unable to check login session."
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async resolveExecutablePath(): Promise<string | undefined> {
    if (!this.executablePathResolver) {
      return undefined;
    }

    return await this.executablePathResolver();
  }
}

function buildCheckOptions(role: Role, executablePath?: string): LaunchPersistentContextOptions {
  const options: LaunchPersistentContextOptions = {
    headless: true,
    viewport: {
      width: role.windowWidth,
      height: role.windowHeight
    },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking"
    ]
  };

  if (executablePath) {
    options.executablePath = executablePath;
  }

  return options;
}

async function launchCheckContext(
  userDataDir: string,
  options: LaunchPersistentContextOptions
): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(userDataDir, options);
}

export function createSystemChromeAuthSessionChecker(
  roleStore: Pick<RoleStore, "ensureBrowserUserDataDir">
): AuthSessionChecker {
  return new AuthSessionChecker(roleStore, {
    executablePathResolver: findSystemChromeExecutable
  });
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const [page] = context.pages();
  return page ?? context.newPage();
}
