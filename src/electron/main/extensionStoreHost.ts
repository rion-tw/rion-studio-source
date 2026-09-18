import {
  WebContentsView,
  session,
  type BrowserWindow,
  type HandlerDetails
} from "electron";
import { chromeStoreExtensionId, chromeStoreUrl, type ExtensionStoreRequest, type ExtensionStoreState } from "../../shared/extensions";
import { installChromiumSessionSecurityPolicy } from "./chromiumSecurityPolicy";

// The store imposes a 1280px minimum on its document and header. Let the
// embedded page follow its native viewport without changing the page zoom.
const STORE_VIEWPORT_CSS = `
  html, body, body > header, main {
    box-sizing: border-box !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }
  html, body { overflow-x: clip !important; }
  /* Upstream Chrome-promotion controller; never hide generic store dialogs. */
  header[role="banner"] > [role="dialog"][jscontroller="h4ilFc"] {
    display: none !important;
  }
`;

type StoreNavigationSource = "document" | "initial" | "language" | "popup";
type StoreNavigationClassification = "category" | "detail" | "search" | "other";
type StoreNavigationPhase = "blocked" | "cancelled" | "completed" | "failed" | "queued";

export interface ExtensionStoreNavigationDiagnostic {
  readonly classification: StoreNavigationClassification;
  readonly code: string;
  readonly phase: StoreNavigationPhase;
  readonly source: StoreNavigationSource;
  readonly webContentsId: number | null;
}

interface ExtensionStoreLoggerPort {
  extensionDiagnostic: (
    level: "debug" | "error" | "warn",
    event: string,
    message: string,
    context: Readonly<Record<string, unknown>>,
    error?: unknown,
    fallbackCode?: string
  ) => void;
}

function acceptedStoreUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === "https://chromewebstore.google.com" &&
      !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function classifyStoreUrl(url: URL | null): StoreNavigationClassification {
  if (!url) return "other";
  if (chromeStoreExtensionId(url.href)) return "detail";
  if (url.pathname === "/category/extensions") return "category";
  if (url.pathname === "/search" || url.pathname.startsWith("/search/")) return "search";
  return "other";
}

/** Unprivileged remote store surface, kept separate from role and application sessions. */
export class ExtensionStoreHost {
  #view: WebContentsView | null = null;
  #window: BrowserWindow | null = null;
  #ownerClosed: { window: BrowserWindow; listener: () => void } | null = null;
  #failed = false;
  #generation = 0;
  #language: NonNullable<ExtensionStoreRequest["language"]> = "en";
  #navigationLane: Promise<void> = Promise.resolve();
  constructor(
    private readonly owner: () => BrowserWindow,
    private readonly publish: (state: ExtensionStoreState) => void,
    private readonly logger?: ExtensionStoreLoggerPort
  ) {}

  snapshot(): ExtensionStoreState {
    const contents = this.#view?.webContents;
    const alive = contents && !contents.isDestroyed() ? contents : null;
    const url = alive?.getURL() ?? "";
    return {
      url, extensionId: chromeStoreExtensionId(url),
      canGoBack: alive?.navigationHistory.canGoBack() ?? false,
      canGoForward: alive?.navigationHistory.canGoForward() ?? false,
      loading: alive?.isLoadingMainFrame() ?? false,
      failed: this.#failed
    };
  }

  request(request: ExtensionStoreRequest): ExtensionStoreState {
    if (request.action === "hide") { this.#view?.setVisible(false); return this.snapshot(); }
    const language = request.language ?? this.#language;
    if (!["en", "zh-TW", "zh-CN", "ja"].includes(language)) throw new Error("EXTENSIONS_STORE_LANGUAGE_INVALID");
    const languageChanged = language !== this.#language;
    this.#language = language;
    const window = this.owner();
    let created = false;
    if (!this.#view || this.#view.webContents.isDestroyed() || this.#window !== window) {
      this.#retireCurrentView();
      const storeSession = session.fromPartition("rion-extension-store", { cache: false });
      installChromiumSessionSecurityPolicy(storeSession);
      const view = new WebContentsView({ webPreferences: {
        session: storeSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
        devTools: false, safeDialogs: true
      } });
      this.#view = view;
      const generation = ++this.#generation;
      created = true;
      this.#window = window;
      view.setVisible(false);
      window.contentView.addChildView(view);
      const notify = () => { if (this.#owns(view, generation)) this.publish(this.snapshot()); };
      const updateFailed = (failed: boolean) => {
        if (!this.#owns(view, generation)) return;
        this.#failed = failed;
        notify();
      };
      storeSession.webRequest.onBeforeRequest(
        { urls: ["*://*/*"] },
        (details, callback) => {
          if (
            details.resourceType !== "mainFrame" ||
            (details.method === "GET" && acceptedStoreUrl(details.url))
          ) {
            callback({});
            return;
          }
          this.#recordNavigation(
            view,
            classifyStoreUrl(acceptedStoreUrl(details.url)),
            "document",
            "blocked",
            "ELECTRON_EXTENSION_STORE_REQUEST_BLOCKED"
          );
          callback({ cancel: true });
        }
      );
      view.webContents.setWindowOpenHandler((details: HandlerDetails) => {
        const url = acceptedStoreUrl(details.url);
        if (
          url && chromeStoreExtensionId(url.href) && !details.postBody &&
          details.disposition !== "other"
        ) {
          this.#queueNavigation(view, generation, url, "popup");
        } else {
          this.#recordNavigation(view, classifyStoreUrl(url), "popup", "blocked",
            "ELECTRON_EXTENSION_STORE_POPUP_BLOCKED");
        }
        return { action: "deny" };
      });
      view.webContents.on("will-navigate", (event, legacyUrl, _inPlace, legacyMain) => {
        const details = event as typeof event & {
          readonly isMainFrame?: boolean;
          readonly url?: string;
        };
        if ((details.isMainFrame ?? legacyMain ?? true) !== true) return;
        event.preventDefault();
        const url = acceptedStoreUrl(details.url ?? legacyUrl);
        if (url) {
          this.#queueNavigation(view, generation, url, "document");
        } else {
          this.#recordNavigation(view, "other", "document", "blocked",
            "ELECTRON_EXTENSION_STORE_NAVIGATION_BLOCKED");
        }
      });
      view.webContents.on("will-redirect", (event, legacyUrl, _inPlace, legacyMain) => {
        const details = event as typeof event & {
          readonly isMainFrame?: boolean;
          readonly url?: string;
        };
        if (
          (details.isMainFrame ?? legacyMain ?? true) === true &&
          !acceptedStoreUrl(details.url ?? legacyUrl)
        ) {
          event.preventDefault();
          this.#recordNavigation(view, "other", "document", "blocked",
            "ELECTRON_EXTENSION_STORE_REDIRECT_BLOCKED");
        }
      });
      // EventBound: each new document receives the presentation override.
      view.webContents.on("dom-ready", () => {
        if (!this.#owns(view, generation)) return;
        void view.webContents.insertCSS(STORE_VIEWPORT_CSS, { cssOrigin: "user" })
          .catch(() => updateFailed(true));
      });
      view.webContents.on("did-navigate", notify);
      view.webContents.on("did-navigate-in-page", notify);
      view.webContents.on("did-stop-loading", notify);
      view.webContents.on("did-start-loading", () => updateFailed(false));
      view.webContents.on("did-fail-load", (_event, code, _description, _url, main) => {
        if (main && code !== -3) updateFailed(true);
      });
      view.webContents.on("render-process-gone", () => updateFailed(true));
      const onWindowClosed = () => { if (this.#window === window) this.dispose(); };
      this.#ownerClosed = { window, listener: onWindowClosed };
      window.once("closed", onWindowClosed);
      // EventBound: navigation lifecycle events establish the store state.
      this.#queueNavigation(
        view,
        generation,
        new URL(chromeStoreUrl(this.#language)),
        "initial"
      );
    }
    const view = this.#view;
    if (!created && languageChanged) {
      // EventBound: an app-language change navigates the existing store document once.
      const url = new URL(chromeStoreUrl(this.#language, view.webContents.getURL()));
      this.#queueNavigation(view, this.#generation, url, "language");
    }
    if (request.action === "show") {
      const bounds = request.bounds;
      const [width, height] = window.getContentSize();
      if (!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 ||
        bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1) {
        throw new Error("EXTENSIONS_STORE_BOUNDS_INVALID");
      }
      view.setBounds({
        x: Math.round(bounds.x), y: Math.round(bounds.y),
        width: Math.floor(bounds.width), height: Math.floor(bounds.height)
      });
      view.setVisible(true);
    } else if (request.action === "back" && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
    else if (request.action === "forward" && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
    else if (request.action === "reload") view.webContents.reload();
    return this.snapshot();
  }

  dispose(): void {
    this.#retireCurrentView();
  }

  #retireCurrentView(): void {
    this.#generation += 1;
    this.#navigationLane = Promise.resolve();
    const view = this.#view;
    this.#view = null;
    if (view) {
      if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    // The store partition outlives every view it hosts, so the request filter
    // must be uninstalled with the view that installed it. Leaving it attached
    // keeps a dead view's closure filtering requests on a persistent session.
    try {
      session.fromPartition("rion-extension-store", { cache: false })
        .webRequest.onBeforeRequest(null);
    } catch {
      // Filter removal is cleanup only and cannot fail view retirement.
    }
    // The owner window also outlives the view, so its close listener is
    // removed rather than accumulating one entry per view recreation.
    const ownerClosed = this.#ownerClosed;
    this.#ownerClosed = null;
    if (ownerClosed && !ownerClosed.window.isDestroyed()) {
      ownerClosed.window.removeListener("closed", ownerClosed.listener);
    }
    this.#window = null;
  }

  #queueNavigation(
    view: WebContentsView,
    generation: number,
    url: URL,
    source: StoreNavigationSource
  ): void {
    const classification = classifyStoreUrl(url);
    this.#recordNavigation(view, classification, source, "queued",
      "ELECTRON_EXTENSION_STORE_NAVIGATION_QUEUED");
    // EventBound: the accepted native navigation event enters its serialized
    // lane only after Electron has unwound the native will-navigate callback.
    setImmediate(() => {
      if (!this.#owns(view, generation)) {
        this.#recordNavigation(view, classification, source, "cancelled",
          "ELECTRON_EXTENSION_STORE_NAVIGATION_CANCELLED");
        return;
      }
      const prior = this.#navigationLane;
      this.#navigationLane = prior.catch(() => undefined).then(async () => {
        if (!this.#owns(view, generation)) {
          this.#recordNavigation(view, classification, source, "cancelled",
            "ELECTRON_EXTENSION_STORE_NAVIGATION_CANCELLED");
          return;
        }
        try {
          await view.webContents.loadURL(url.href);
          if (!this.#owns(view, generation)) return;
          this.#recordNavigation(view, classification, source, "completed",
            "ELECTRON_EXTENSION_STORE_NAVIGATION_COMPLETED");
        } catch {
          if (!this.#owns(view, generation)) return;
          this.#failed = true;
          this.publish(this.snapshot());
          this.#recordNavigation(view, classification, source, "failed",
            "ELECTRON_EXTENSION_STORE_NAVIGATION_FAILED");
        }
      });
    });
  }

  #owns(view: WebContentsView, generation: number): boolean {
    return this.#view === view && this.#generation === generation &&
      !view.webContents.isDestroyed();
  }

  #recordNavigation(
    view: WebContentsView,
    classification: StoreNavigationClassification,
    source: StoreNavigationSource,
    phase: StoreNavigationPhase,
    code: string
  ): void {
    const webContentsId = (() => {
      try {
        return Number.isSafeInteger(view.webContents.id)
          ? view.webContents.id
          : null;
      } catch {
        return null;
      }
    })();
    const diagnostic: ExtensionStoreNavigationDiagnostic = Object.freeze({
      classification,
      code,
      phase,
      source,
      webContentsId
    });
    const failed = phase === "failed";
    this.logger?.extensionDiagnostic(
      failed ? "error" : phase === "blocked" ? "warn" : "debug",
      "extension_store_navigation",
      "The embedded Chrome Web Store navigation lane reached a lifecycle phase.",
      { ...diagnostic },
      failed ? new Error(code) : undefined,
      code
    );
  }
}
