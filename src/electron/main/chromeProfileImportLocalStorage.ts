import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import { RionBridgeError } from "../ipc/errors";

export const CHROME_PROFILE_IMPORT_ISOLATED_WORLD_ID = 1004;

export interface ChromeProfileImportLocalStorageEntry {
  readonly key: string;
  readonly value: string;
}

export interface ChromeProfileImportHelperWebContentsPort {
  readonly session: ChromiumRoleSessionPort;
  close: (options?: { waitForBeforeUnload?: boolean }) => void;
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean
  ) => Promise<unknown>;
  getURL: () => string;
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  once: (event: "destroyed", listener: () => void) => unknown;
  setWindowOpenHandler: (handler: () => { action: "deny" }) => void;
}

export interface ChromeProfileImportHelperViewFactoryPort {
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
  }) => ChromeProfileImportHelperViewPort;
}

export interface ChromeProfileImportHelperViewPort {
  readonly webContents: ChromeProfileImportHelperWebContentsPort;
}

const CONTROLLED_PATH = "/.__rion_chrome_profile_import__";
const CONTROLLED_DOCUMENT = "<!doctype html><meta charset=utf-8>";

function localStorageError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function parseOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw localStorageError(
      "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_ORIGIN_INVALID",
      "The fresh helper requires an exact canonical HTTP(S) launch origin."
    );
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value) {
    throw localStorageError(
      "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_ORIGIN_INVALID",
      "The fresh helper requires an exact canonical HTTP(S) launch origin."
    );
  }
  return origin;
}

function validateReadback(value: unknown): ChromeProfileImportLocalStorageEntry[] {
  if (!Array.isArray(value) || value.some((entry) =>
    !Array.isArray(entry) || entry.length !== 2 ||
    typeof entry[0] !== "string" || typeof entry[1] !== "string"
  )) {
    throw localStorageError(
      "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_READBACK_FAILED",
      "The isolated controlled document returned an invalid LocalStorage receipt."
    );
  }
  return value.map(([key, itemValue]) => Object.freeze({
    key: key as string,
    value: itemValue as string
  }));
}

function sortedEntries(
  entries: readonly ChromeProfileImportLocalStorageEntry[]
): ChromeProfileImportLocalStorageEntry[] {
  return [...entries].sort((left, right) => left.key.localeCompare(right.key));
}

function exactEntries(
  left: readonly ChromeProfileImportLocalStorageEntry[],
  right: readonly ChromeProfileImportLocalStorageEntry[]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.key === right[index]?.key && entry.value === right[index]?.value
  );
}

function expression(
  origin: string,
  replacement?: readonly ChromeProfileImportLocalStorageEntry[]
): string {
  const replacementCode = replacement === undefined
    ? ""
    : `localStorage.clear();
      const replacement = ${JSON.stringify(replacement.map(({ key, value }) => [key, value]))};
      for (const [key, value] of replacement) localStorage.setItem(key, value);`;
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) throw new Error("origin-mismatch");
    ${replacementCode}
    return Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      if (key === null) throw new Error("missing-key");
      const value = localStorage.getItem(key);
      if (value === null) throw new Error("missing-value");
      return [key, value];
    }).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  })()`;
}

async function closeView(view: ChromeProfileImportHelperViewPort): Promise<void> {
  const { webContents: contents } = view;
  if (contents.isDestroyed()) return;
  const destroyed = new Promise<void>((resolve) => contents.once("destroyed", resolve));
  contents.close({ waitForBeforeUnload: false });
  // EventBound: the exact helper WebContents destroyed event owns cleanup.
  await destroyed;
}

/**
 * Ephemeral helper-only origin codec. Plaintext is evaluated only in isolated
 * world 1004 of a CSP-locked controlled document in the fresh helper process;
 * it never crosses the product renderer/preload bridge. The returned inventory,
 * not the JavaScript Promise itself, is the mutation/readback receipt.
 */
export class ChromeProfileImportLocalStorageCodec {
  readonly #views: ChromeProfileImportHelperViewFactoryPort;
  #active = false;

  constructor(views: ChromeProfileImportHelperViewFactoryPort) {
    this.#views = views;
  }

  readback(
    session: ChromiumRoleSessionPort,
    origin: string
  ): Promise<readonly ChromeProfileImportLocalStorageEntry[]> {
    return this.#run(session, origin);
  }

  async replaceAndReadback(
    session: ChromiumRoleSessionPort,
    origin: string,
    entries: readonly ChromeProfileImportLocalStorageEntry[]
  ): Promise<readonly ChromeProfileImportLocalStorageEntry[]> {
    const expected = sortedEntries(entries);
    const readback = await this.#run(session, origin, expected);
    if (!exactEntries(readback, expected)) {
      throw localStorageError(
        "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_READBACK_FAILED",
        "The isolated helper did not return the exact replaced LocalStorage inventory."
      );
    }
    return readback;
  }

  async #run(
    session: ChromiumRoleSessionPort,
    originValue: string,
    replacement?: readonly ChromeProfileImportLocalStorageEntry[]
  ): Promise<readonly ChromeProfileImportLocalStorageEntry[]> {
    if (this.#active) {
      throw localStorageError(
        "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_BUSY",
        "The helper already owns a controlled LocalStorage document."
      );
    }
    const origin = parseOrigin(originValue);
    const url = `${origin.origin}${CONTROLLED_PATH}`;
    this.#active = true;
    let handlerInstalled = false;
    let view: ChromeProfileImportHelperViewPort | null = null;
    let served = false;
    let readback: readonly ChromeProfileImportLocalStorageEntry[] | null = null;
    let operationError: RionBridgeError | null = null;
    try {
      try {
        session.protocol.handle(origin.protocol.slice(0, -1), (request) => {
          const exact = request.method === "GET" && request.url === url;
          served ||= exact;
          return new Response(exact ? CONTROLLED_DOCUMENT : "", {
            status: exact ? 200 : 403,
            headers: {
              "cache-control": "no-store",
              "content-security-policy": "default-src 'none'",
              "content-type": "text/html; charset=utf-8"
            }
          });
        });
      } catch {
        throw localStorageError(
          "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_PROTOCOL_FAILED",
          "The helper could not install its exact controlled-document handler."
        );
      }
      handlerInstalled = true;
      view = this.#views.create({
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
      const contents = view.webContents;
      if (contents.session !== session || contents.isDestroyed()) {
        throw localStorageError(
          "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_SESSION_MISMATCH",
          "The controlled document is not bound to the exact leased Session."
        );
      }
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      try {
        await contents.loadURL(url);
      } catch {
        throw localStorageError(
          "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_NAVIGATION_FAILED",
          "The exact controlled LocalStorage document did not finish loading."
        );
      }
      if (!served || contents.getURL() !== url) {
        throw localStorageError(
          "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_ORIGIN_MISMATCH",
          "The controlled LocalStorage document did not load from the exact origin."
        );
      }
      let value: unknown;
      try {
        value = await contents.executeJavaScriptInIsolatedWorld(
          CHROME_PROFILE_IMPORT_ISOLATED_WORLD_ID,
          [{ code: expression(origin.origin, replacement), url: "rion://chrome-import-codec" }],
          false
        );
      } catch {
        throw localStorageError(
          "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_EXECUTION_FAILED",
          "The isolated controlled document did not acknowledge LocalStorage access."
        );
      }
      readback = Object.freeze(validateReadback(value));
    } catch (error) {
      operationError = error instanceof RionBridgeError
        ? error
        : localStorageError(
            "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_READBACK_FAILED",
            "The isolated controlled document did not produce an exact LocalStorage receipt."
          );
    }
    let cleanupFailed = false;
    try {
      if (view) await closeView(view);
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
        "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_CLEANUP_FAILED",
        "The helper could not prove controlled-document retirement."
      );
    }
    if (operationError) throw operationError;
    if (!readback) {
      throw localStorageError(
        "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_READBACK_FAILED",
        "The isolated controlled document did not produce an exact LocalStorage receipt."
      );
    }
    return readback;
  }
}
