import type { Session } from "electron";

import type {
  CoreJsonValue,
  EmbeddedBrowserEngine,
  RolePathsRecord
} from "../../shared/generated";
import type { ProfileCoreEffectAction } from "../core/ElectronEffectExecutor";

const ROLE_STORAGE_DATA_TYPES: NonNullable<Parameters<Session["clearData"]>[0]>["dataTypes"] = [
  "cache",
  "cookies",
  "fileSystems",
  "indexedDB",
  "localStorage",
  "serviceWorkers",
  "webSQL"
];

type ProfileSession = Pick<
  Session,
  "clearData" | "clearStorageData" | "closeAllConnections" | "cookies" | "flushStorageData"
>;

export interface ElectronProfileEffectAdapterOptions {
  getEmbeddedSession: (roleId: string) => ProfileSession;
  getImportedSession: (browserUserDataDir: string) => ProfileSession;
  getSystemSessionStore?: (
    roleId: string,
    paths: RolePathsRecord
  ) => Promise<SystemSessionStorePort> | SystemSessionStorePort;
  verifyEngineSession?: (
    roleId: string,
    engine: EmbeddedBrowserEngine,
    launchUrl: string,
    paths: RolePathsRecord
  ) => Promise<boolean>;
}

export interface BrowserCookieTransferRecord {
  domain?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  name: string;
  path?: string;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  secure?: boolean;
  url: string;
  value: string;
}

export interface SystemSessionStorePort {
  clearCookies(): Promise<void>;
  getCookies(): Promise<BrowserCookieTransferRecord[]>;
  setCookies(cookies: readonly BrowserCookieTransferRecord[]): Promise<number>;
}

/**
 * Executes only Electron session and cookie effects. Rust owns the operation
 * phases, rollback journal, profile filesystem, runtime stops, and SQLite.
 */
export class ElectronProfileEffectAdapter {
  constructor(private readonly options: ElectronProfileEffectAdapterOptions) {}

  async execute(action: ProfileCoreEffectAction): Promise<CoreJsonValue | undefined> {
    switch (action.type) {
      case "chromeProfileApplySession": {
        const target = this.options.getImportedSession(action.browserUserDataDir);
        const cookies = parseCookies(action.cookiesJson);
        for (const cookie of cookies) {
          await setCookieUnlessRejected(target, cookie);
        }
        target.flushStorageData();
        return undefined;
      }
      case "chromeProfileClearSession":
        await clearSession(this.options.getImportedSession(action.browserUserDataDir));
        return undefined;
      case "roleBrowserDataClearSession": {
        const target = action.sessionSource === "chrome-profile"
          ? this.options.getImportedSession(action.browserUserDataDir)
          : this.options.getEmbeddedSession(action.roleId);
        await clearSession(target);
        return undefined;
      }
      case "roleSessionMigrationInspect": {
        const [source, target] = await Promise.all([
          this.getMigrationStore(
            action.roleId,
            action.sourceEngine,
            action.sessionSource,
            action.paths,
            true
          ),
          this.getMigrationStore(
            action.roleId,
            action.targetEngine,
            action.sessionSource,
            action.paths,
            false
          )
        ]);
        const [sourceCookies, targetCookies] = await Promise.all([
          source.getCookies(),
          target.getCookies()
        ]);
        return {
          sourceCookieCount: sourceCookies.length,
          targetCookieCount: targetCookies.length
        };
      }
      case "roleSessionMigrationApply": {
        const source = await this.getMigrationStore(
          action.roleId,
          action.sourceEngine,
          action.sessionSource,
          action.paths,
          true
        );
        const target = await this.getMigrationStore(
          action.roleId,
          action.targetEngine,
          action.sessionSource,
          action.paths,
          false
        );
        const [sourceCookies, targetCookies] = await Promise.all([
          source.getCookies(),
          target.getCookies()
        ]);
        if (targetCookies.length > 0) {
          throw effectError(
            "ROLE_SESSION_MIGRATION_TARGET_NOT_EMPTY",
            "The target browser cookie store is not empty."
          );
        }
        try {
          const cookiesMigrated = await target.setCookies(sourceCookies);
          const authVerified = await this.options.verifyEngineSession?.(
            action.roleId,
            action.targetEngine,
            action.launchUrl,
            action.paths
          ) ?? false;
          if (!authVerified) await target.clearCookies();
          return { authVerified, cookiesMigrated };
        } catch (error) {
          await target.clearCookies().catch(() => undefined);
          throw error;
        }
      }
      case "roleSessionMigrationRollback": {
        const target = await this.getMigrationStore(
          action.roleId,
          action.targetEngine,
          action.sessionSource,
          action.paths,
          false
        );
        await target.clearCookies();
        return { targetStoreCleared: true };
      }
    }
  }

  private async getMigrationStore(
    roleId: string,
    engine: EmbeddedBrowserEngine,
    sessionSource: "managed" | "chrome-profile",
    paths: RolePathsRecord,
    source: boolean
  ): Promise<SystemSessionStorePort> {
    if (engine === "system") {
      const store = await this.options.getSystemSessionStore?.(roleId, paths);
      if (!store) {
        throw effectError(
          "SYSTEM_SESSION_STORE_UNAVAILABLE",
          "The System browser cookie store adapter is unavailable."
        );
      }
      return store;
    }
    const session = source && sessionSource === "chrome-profile"
      ? this.options.getImportedSession(paths.electronBrowserUserDataDir)
      : this.options.getEmbeddedSession(roleId);
    return createElectronSessionStore(session);
  }
}

export function createElectronSessionStore(
  session: ProfileSession
): SystemSessionStorePort {
  return {
    clearCookies: async () => {
      await session.clearStorageData({ storages: ["cookies"] });
      session.flushStorageData();
    },
    getCookies: async () => {
      const cookies = await session.cookies.get({});
      return cookies.map((cookie) => {
        const domain = cookie.domain?.replace(/^\./u, "");
        if (!domain) {
          throw effectError(
            "ROLE_SESSION_MIGRATION_COOKIE_INVALID",
            `Cookie ${cookie.name} does not have a transferable domain.`
          );
        }
        return {
          domain: cookie.domain,
          ...(cookie.expirationDate === undefined
            ? {}
            : { expirationDate: cookie.expirationDate }),
          httpOnly: cookie.httpOnly,
          name: cookie.name,
          path: cookie.path,
          sameSite: cookie.sameSite,
          secure: cookie.secure,
          url: `${cookie.secure ? "https" : "http"}://${domain}${cookie.path || "/"}`,
          value: cookie.value
        };
      });
    },
    setCookies: async (cookies) => {
      let migrated = 0;
      for (const cookie of cookies) {
        if (await setCookieUnlessRejected(session, cookie)) migrated += 1;
      }
      session.flushStorageData();
      return migrated;
    }
  };
}

function parseCookies(value: string): Electron.CookiesSetDetails[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw effectError("CHROME_COOKIE_PAYLOAD_INVALID", "Imported Chrome cookies are invalid.");
  }
  return parsed as Electron.CookiesSetDetails[];
}

async function setCookieUnlessRejected(
  session: ProfileSession,
  cookie: Electron.CookiesSetDetails
): Promise<boolean> {
  try {
    await session.cookies.set(cookie);
    return true;
  } catch (error) {
    if (!isDisallowedCookieCharacterError(error)) throw error;
    return false;
  }
}

async function clearSession(session: ProfileSession): Promise<void> {
  const results = await Promise.allSettled([
    session.closeAllConnections(),
    session.clearData({ dataTypes: ROLE_STORAGE_DATA_TYPES }),
    session.clearStorageData({ storages: ["cachestorage"] })
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw Object.assign(
      new AggregateError(failures, "Some saved browser data could not be cleared."),
      { code: "ROLE_BROWSER_DATA_CLEAR_FAILED" }
    );
  }
}

function isDisallowedCookieCharacterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("EXCLUDE_DISALLOWED_CHARACTER")
    || error.message.includes("The cookie contains ASCII control characters");
}

function effectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
