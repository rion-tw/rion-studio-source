import type { BrowserContext, Page } from "playwright";

import { configurePlaywrightBrowsersPath } from "../browser/BrowserManager";
import {
  BROWSER_USER_DATA_LOCK_TIMEOUT_MESSAGE,
  BrowserUserDataLockTimeoutError
} from "../browser/BrowserUserDataLockWatcher";
import { withPlaywrightUserDataLockRetry } from "../browser/playwrightUserDataRetry";
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

type PlaywrightChromium = typeof import("playwright")["chromium"];
type LaunchPersistentContextOptions = NonNullable<Parameters<PlaywrightChromium["launchPersistentContext"]>[1]>;

export type LaunchPersistentContext = (
  userDataDir: string,
  options: LaunchPersistentContextOptions
) => Promise<BrowserContext>;

export class AuthSessionChecker {
  constructor(
    private readonly roleStore: Pick<RoleStore, "ensureBrowserUserDataDir">,
    private readonly launchPersistentContext: LaunchPersistentContext = launchCheckContext
  ) {}

  async check(role: Role): Promise<AuthSessionCheckResult> {
    const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
    const context = await withPlaywrightUserDataLockRetry(() =>
      this.launchPersistentContext(browserUserDataDir, buildCheckOptions(role))
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
}

function buildCheckOptions(role: Role): LaunchPersistentContextOptions {
  return {
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
}

async function launchCheckContext(
  userDataDir: string,
  options: LaunchPersistentContextOptions
): Promise<BrowserContext> {
  configurePlaywrightBrowsersPath();
  const { chromium } = await import("playwright");
  return chromium.launchPersistentContext(userDataDir, options);
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const [page] = context.pages();
  return page ?? context.newPage();
}
