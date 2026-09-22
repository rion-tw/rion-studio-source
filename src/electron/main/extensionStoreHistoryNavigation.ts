import type { WebContents } from "electron";

export type StoreHistoryAction = "back" | "forward" | "reload";
type Outcome = { phase: "completed" | "cancelled" | "failed"; code: string };

/** EventBound: Chromium owns the entries; this operation only restores their document. */
export function navigateStoreHistory(
  contents: WebContents,
  action: StoreHistoryAction,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<Outcome> {
  return new Promise(resolve => {
    const history = contents.navigationHistory;
    const current = () => !signal.aborted && isCurrent() && !contents.isDestroyed();
    if (!current()) { resolve({ phase: "cancelled", code: "HISTORY_RETIRED" }); return; }
    if ((action === "back" && !history.canGoBack()) || (action === "forward" && !history.canGoForward())) {
      resolve({ phase: "cancelled", code: "HISTORY_UNAVAILABLE" }); return;
    }
    const index = history.getActiveIndex() + (action === "back" ? -1 : action === "forward" ? 1 : 0);
    const entry = history.getEntryAtIndex(index);
    if (!entry) { resolve({ phase: "cancelled", code: "HISTORY_UNAVAILABLE" }); return; }
    const url = entry.url;
    let phase: "history" | "deferred" | "document" = action === "reload" ? "deferred" : "history";
    let committed = false;
    let settled = false;
    const ownsTarget = () => current() && history.getActiveIndex() === index && contents.getURL() === url;
    const finish = (phase: Outcome["phase"], code: string) => {
      if (settled) return;
      settled = true;
      contents.removeListener("did-start-navigation", start);
      contents.removeListener("did-navigate-in-page", inPage);
      contents.removeListener("did-navigate", navigated);
      contents.removeListener("did-finish-load", loaded);
      contents.removeListener("did-fail-load", failed);
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("render-process-gone", gone);
      signal.removeEventListener("abort", cancelled);
      resolve({ phase, code });
    };
    const cancelled = () => finish("cancelled", "HISTORY_SUPERSEDED");
    const destroyed = () => finish("cancelled", "HISTORY_DESTROYED");
    const gone = () => finish("failed", "HISTORY_RENDERER_GONE");
    const start = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      legacyUrl: string, legacySame: boolean, legacyMain: boolean
    ) => {
      if (!(event.isMainFrame ?? legacyMain)) return;
      if (!current() || (event.url ?? legacyUrl) !== url) { cancelled(); return; }
      if (!(event.isSameDocument ?? legacySame)) {
        phase = "document";
        committed = false;
      }
    };
    const inPage = (_event: Electron.Event, next: string, main: boolean) => {
      if (!main) return;
      if (next !== url || !ownsTarget()) { cancelled(); return; }
      if (phase !== "history") return;
      phase = "deferred";
      // EventBound: unwind the exact same-document callback before reloading its
      // current entry. This is one continuation, never a retry or liveness probe.
      setImmediate(() => {
        if (settled || phase !== "deferred") return;
        if (!ownsTarget()) { cancelled(); return; }
        try { contents.reload(); } catch { finish("failed", "HISTORY_RELOAD_FAILED"); }
      });
    };
    const navigated = (_event: Electron.Event, next: string) => {
      if (next !== url || !ownsTarget()) { cancelled(); return; }
      if (phase === "document") committed = true;
    };
    const loaded = () => {
      if (phase !== "document" || !committed) return;
      if (!ownsTarget()) { cancelled(); return; }
      finish("completed", "HISTORY_DOCUMENT_COMPLETED");
    };
    const failed = (_event: Electron.Event, code: number, _description: string, next: string, main: boolean) => {
      if (!main || next !== url) return;
      finish(code === -3 ? "cancelled" : "failed", `HISTORY_LOAD_${code}`);
    };
    contents.on("did-start-navigation", start);
    contents.on("did-navigate-in-page", inPage);
    contents.on("did-navigate", navigated);
    contents.on("did-finish-load", loaded);
    contents.on("did-fail-load", failed);
    contents.on("destroyed", destroyed);
    contents.on("render-process-gone", gone);
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      if (action === "back") history.goBack();
      else if (action === "forward") history.goForward();
      else contents.reload();
    } catch { finish("failed", "HISTORY_DISPATCH_FAILED"); }
  });
}
