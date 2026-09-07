import { WebContentsView, session, type BrowserWindow } from "electron";
import { chromeStoreExtensionId, type ExtensionStoreRequest, type ExtensionStoreState } from "../../shared/extensions";
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

/** Unprivileged remote store surface, kept separate from role and application sessions. */
export class ExtensionStoreHost {
  #view: WebContentsView | null = null;
  #window: BrowserWindow | null = null;
  #failed = false;
  constructor(private readonly owner: () => BrowserWindow, private readonly publish: (state: ExtensionStoreState) => void) {}

  snapshot(): ExtensionStoreState {
    const contents = this.#view?.webContents;
    const alive = contents && !contents.isDestroyed() ? contents : null;
    const url = alive?.getURL() ?? "";
    return {
      url, extensionId: chromeStoreExtensionId(url),
      canGoBack: alive?.navigationHistory.canGoBack() ?? false,
      canGoForward: alive?.navigationHistory.canGoForward() ?? false,
      loading: alive?.isLoadingMainFrame() ?? false, failed: this.#failed
    };
  }

  request(request: ExtensionStoreRequest): ExtensionStoreState {
    if (request.action === "hide") { this.#view?.setVisible(false); return this.snapshot(); }
    const window = this.owner();
    if (!this.#view || this.#view.webContents.isDestroyed() || this.#window !== window) {
      this.dispose();
      const storeSession = session.fromPartition("rion-extension-store", { cache: false });
      installChromiumSessionSecurityPolicy(storeSession);
      const view = new WebContentsView({ webPreferences: {
        session: storeSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
        devTools: false, safeDialogs: true
      } });
      this.#view = view;
      this.#window = window;
      view.setVisible(false);
      window.contentView.addChildView(view);
      const notify = () => { if (this.#view === view) this.publish(this.snapshot()); };
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== "https://chromewebstore.google.com") event.preventDefault();
      });
      view.webContents.on("will-redirect", (event, url) => {
        if (new URL(url).origin !== "https://chromewebstore.google.com") event.preventDefault();
      });
      // EventBound: each new document receives the presentation override.
      view.webContents.on("dom-ready", () => {
        void view.webContents.insertCSS(STORE_VIEWPORT_CSS, { cssOrigin: "user" })
          .catch(() => { if (this.#view === view) { this.#failed = true; notify(); } });
      });
      view.webContents.on("did-navigate", notify);
      view.webContents.on("did-navigate-in-page", notify);
      view.webContents.on("did-stop-loading", notify);
      view.webContents.on("did-start-loading", () => { this.#failed = false; notify(); });
      view.webContents.on("did-fail-load", (_event, code, _description, _url, main) => {
        if (main && code !== -3) { this.#failed = true; notify(); }
      });
      view.webContents.on("render-process-gone", () => { this.#failed = true; notify(); });
      window.once("closed", () => { if (this.#window === window) this.dispose(); });
      // EventBound: navigation lifecycle events establish the store state.
      void view.webContents.loadURL("https://chromewebstore.google.com/").catch(() => undefined);
    }
    const view = this.#view;
    if (request.action === "show") {
      const bounds = request.bounds;
      const [width, height] = window.getContentSize();
      if (!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 ||
        bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1) {
        throw new Error("EXTENSIONS_STORE_BOUNDS_INVALID");
      }
      view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) });
      view.setVisible(true);
    } else if (request.action === "back" && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
    else if (request.action === "forward" && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
    else if (request.action === "reload") view.webContents.reload();
    return this.snapshot();
  }

  dispose(): void {
    const view = this.#view;
    this.#view = null;
    if (view) {
      if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.#window = null;
  }
}
