import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type {
  ChromiumSessionMigrationLocalStorageEntry
} from "./chromiumSessionMigrationCodec";
import { RionBridgeError } from "../ipc/errors";

export interface ChromiumMigrationWebContentsPort {
  readonly session: ChromiumRoleSessionPort;
  close: (options?: { waitForBeforeUnload?: boolean }) => void;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  getURL: () => string;
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  once: (event: "destroyed", listener: () => void) => unknown;
  setWindowOpenHandler: (
    handler: () => { action: "deny" }
  ) => void;
}

export interface ChromiumMigrationWebContentsViewPort {
  readonly webContents: ChromiumMigrationWebContentsPort;
}

export interface ChromiumMigrationWebContentsViewFactoryPort {
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
  }) => ChromiumMigrationWebContentsViewPort;
}

const CONTROLLED_DOCUMENT_PATH = "/.__rion_session_migration__";
const CONTROLLED_DOCUMENT = "<!doctype html><meta charset=utf-8>";

function localStorageError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function canonicalOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw localStorageError(
      "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_ORIGIN_INVALID",
      "A canonical HTTP(S) origin is required for LocalStorage migration."
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== origin
  ) {
    throw localStorageError(
      "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_ORIGIN_INVALID",
      "A canonical HTTP(S) origin is required for LocalStorage migration."
    );
  }
  return parsed;
}

function controlledUrl(origin: URL): string {
  return `${origin.origin}${CONTROLLED_DOCUMENT_PATH}`;
}

function validateReadback(value: unknown): ChromiumSessionMigrationLocalStorageEntry[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) =>
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    )
  ) {
    throw localStorageError(
      "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_READBACK_FAILED",
      "Chromium did not return an exact LocalStorage inventory."
    );
  }
  return value.map(([key, itemValue]) => Object.freeze({
    key: key as string,
    value: itemValue as string
  }));
}

function canonicalEntries(
  entries: readonly ChromiumSessionMigrationLocalStorageEntry[]
): ChromiumSessionMigrationLocalStorageEntry[] {
  return [...entries].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  );
}

function readbackExpression(expectedOrigin: string): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(expectedOrigin)}) {
      throw new Error("origin-mismatch");
    }
    return Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      if (key === null) throw new Error("key-missing");
      const value = localStorage.getItem(key);
      if (value === null) throw new Error("value-missing");
      return [key, value];
    }).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  })()`;
}

function replacementExpression(
  expectedOrigin: string,
  entries: readonly ChromiumSessionMigrationLocalStorageEntry[]
): string {
  const payload = entries.map((entry) => [entry.key, entry.value]);
  return `(() => {
    if (location.origin !== ${JSON.stringify(expectedOrigin)}) {
      throw new Error("origin-mismatch");
    }
    const entries = ${JSON.stringify(payload)};
    localStorage.clear();
    for (const [key, value] of entries) localStorage.setItem(key, value);
    return Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      if (key === null) throw new Error("key-missing");
      const value = localStorage.getItem(key);
      if (value === null) throw new Error("value-missing");
      return [key, value];
    }).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  })()`;
}

async function closeContents(contents: ChromiumMigrationWebContentsPort): Promise<void> {
  if (contents.isDestroyed()) return;
  const destroyed = new Promise<void>((resolve) => {
    contents.once("destroyed", resolve);
  });
  contents.close({ waitForBeforeUnload: false });
  // EventBound: the exact hidden WebContents destroyed event owns completion.
  await destroyed;
}

/**
 * Origin codec/readback only. Electron 43 exposes no completion event for
 * `Session.flushStorageData()`, so this class deliberately makes no durability
 * claim and must not produce a migration flush receipt.
 */
export class ChromiumSessionMigrationLocalStorageCodec {
  readonly #views: ChromiumMigrationWebContentsViewFactoryPort;
  #active = false;

  constructor(views: ChromiumMigrationWebContentsViewFactoryPort) {
    this.#views = views;
  }

  readback(
    session: ChromiumRoleSessionPort,
    origin: string
  ): Promise<readonly ChromiumSessionMigrationLocalStorageEntry[]> {
    return this.#run(session, origin, readbackExpression(origin));
  }

  async replaceAndReadback(
    session: ChromiumRoleSessionPort,
    origin: string,
    entries: readonly ChromiumSessionMigrationLocalStorageEntry[]
  ): Promise<readonly ChromiumSessionMigrationLocalStorageEntry[]> {
    const readback = await this.#run(
      session,
      origin,
      replacementExpression(origin, entries)
    );
    if (JSON.stringify(readback) !== JSON.stringify(canonicalEntries(entries))) {
      throw localStorageError(
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_READBACK_FAILED",
        "Chromium did not return an exact LocalStorage inventory."
      );
    }
    return readback;
  }

  async #run(
    session: ChromiumRoleSessionPort,
    originValue: string,
    expression: string
  ): Promise<readonly ChromiumSessionMigrationLocalStorageEntry[]> {
    if (this.#active) {
      throw localStorageError(
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_BUSY",
        "The controlled LocalStorage codec already owns a migration document."
      );
    }
    const origin = canonicalOrigin(originValue);
    this.#active = true;
    let handlerInstalled = false;
    let contents: ChromiumMigrationWebContentsPort | null = null;
    let result: readonly ChromiumSessionMigrationLocalStorageEntry[] | null = null;
    let operationError: RionBridgeError | null = null;
    try {
      session.protocol.handle(origin.protocol.slice(0, -1), (request) => {
        const matches = request.method === "GET" &&
          request.url === controlledUrl(origin);
        return new Response(matches ? CONTROLLED_DOCUMENT : "", {
          status: matches ? 200 : 403,
          headers: {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'",
            "content-type": "text/html; charset=utf-8"
          }
        });
      });
      handlerInstalled = true;
      const view = this.#views.create({
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
      });
      contents = view.webContents;
      if (contents.session !== session || contents.isDestroyed()) {
        throw localStorageError(
          "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_SESSION_MISMATCH",
          "The controlled migration document is not bound to the leased role session."
        );
      }
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      await contents.loadURL(controlledUrl(origin));
      if (new URL(contents.getURL()).origin !== origin.origin) {
        throw localStorageError(
          "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_ORIGIN_MISMATCH",
          "The controlled migration document loaded an unexpected origin."
        );
      }
      const readback = await contents.executeJavaScript(expression, false);
      result = Object.freeze(validateReadback(readback));
    } catch (error) {
      operationError = error instanceof RionBridgeError
        ? error
        : localStorageError(
          "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_READBACK_FAILED",
          "Chromium could not apply or read the controlled LocalStorage inventory."
        );
    }
    let cleanupFailed = false;
    try {
      if (contents) await closeContents(contents);
    } catch {
      cleanupFailed = true;
    }
    try {
      if (handlerInstalled) session.protocol.unhandle(origin.protocol.slice(0, -1));
    } catch {
      cleanupFailed = true;
    }
    this.#active = false;
    if (cleanupFailed) {
      throw localStorageError(
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_CLEANUP_FAILED",
        "The controlled LocalStorage migration document did not close exactly."
      );
    }
    if (operationError) throw operationError;
    if (!result) {
      throw localStorageError(
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_READBACK_FAILED",
        "Chromium did not return an exact LocalStorage inventory."
      );
    }
    return result;
  }
}
