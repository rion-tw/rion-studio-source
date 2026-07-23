import type { Session } from "electron";

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
}

/**
 * Executes only Electron session and cookie effects. Rust owns the operation
 * phases, rollback journal, profile filesystem, runtime stops, and SQLite.
 */
export class ElectronProfileEffectAdapter {
  constructor(private readonly options: ElectronProfileEffectAdapterOptions) {}

  async execute(action: ProfileCoreEffectAction): Promise<void> {
    switch (action.type) {
      case "chromeProfileApplySession": {
        const target = this.options.getImportedSession(action.browserUserDataDir);
        const cookies = parseCookies(action.cookiesJson);
        for (const cookie of cookies) {
          await setCookieUnlessRejected(target, cookie);
        }
        target.flushStorageData();
        return;
      }
      case "chromeProfileClearSession":
        await clearSession(this.options.getImportedSession(action.browserUserDataDir));
        return;
      case "roleBrowserDataClearSession": {
        const target = action.sessionSource === "chrome-profile"
          ? this.options.getImportedSession(action.browserUserDataDir)
          : this.options.getEmbeddedSession(action.roleId);
        await clearSession(target);
      }
    }
  }
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
): Promise<void> {
  try {
    await session.cookies.set(cookie);
  } catch (error) {
    if (!isDisallowedCookieCharacterError(error)) throw error;
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
