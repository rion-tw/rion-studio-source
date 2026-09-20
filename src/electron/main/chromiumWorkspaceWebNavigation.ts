import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceWebContentsPort } from "./chromiumRoleSurfacePorts";

export type WorkspaceWebFailureSource = "did-fail-load" | "did-fail-provisional-load" |
  "load-url" | "network" | "render-process-gone";

interface Navigation {
  readonly resolve: () => void;
  readonly reject: (error: RionBridgeError) => void;
  url: string | undefined;
  started: boolean;
}

const error = (code: string) => new RionBridgeError({
  code: `ELECTRON_GLOBAL_WEB_NAVIGATION_${code}`,
  message: "The Workspace Web navigation did not complete."
});

/** EventBound, one current main-frame operation per exact WebContents. Loading
 * is presentation state; a document/in-page commit completes navigation. A new
 * intent supersedes the old observer synchronously, before calling Chromium.
 */
export class ChromiumWorkspaceWebNavigation {
  #pending: Navigation | null = null;
  #url: string | undefined;
  #failed = false;
  loading = false;
  errorCode: number | undefined;

  constructor(
    readonly contents: ChromiumRoleSurfaceWebContentsPort,
    readonly changed: () => void,
    readonly failed: (code: number, url: string, source: WorkspaceWebFailureSource, networkError?: string) => void
  ) {}

  get url(): string | undefined { return this.#url; }

  run(begin: () => void | Promise<void>, url?: string): Promise<void> {
    this.cancel("SUPERSEDED");
    // Intent is held on #pending; the displayed URL follows Chromium events.
    this.#url = undefined;
    this.#failed = false;
    this.loading = true;
    this.errorCode = undefined;
    const completion = new Promise<void>((resolve, reject) => {
      this.#pending = { resolve, reject, url, started: false };
    });
    const pending = this.#pending!;
    this.changed();
    try {
      const promise = begin();
      void promise?.catch((cause: unknown) => {
        if (this.#pending !== pending) return;
        const nativeCode = (cause as { errorCode?: unknown } | null)?.errorCode;
        this.fail(Number.isSafeInteger(nativeCode) ? nativeCode as number : 0,
          pending.url ?? this.contents.getURL(), "load-url");
      });
    } catch {
      if (this.#pending === pending) this.fail(0, url ?? this.contents.getURL(), "load-url");
    }
    return completion;
  }

  started(url?: string): void {
    // A delayed start from the superseded request cannot capture an intent that
    // has not yet received its own start event. Redirects have their own event.
    if (this.#pending && !this.#pending.started && this.#pending.url !== undefined &&
        url !== undefined && this.#pending.url !== url) return;
    if (this.#pending?.started) this.cancel("SUPERSEDED");
    if (this.#pending) {
      this.#pending.started = true;
      this.#pending.url = url ?? this.#pending.url;
    }
    this.#url = url ?? this.#pending?.url;
    this.#failed = false;
    this.loading = true;
    this.errorCode = undefined;
    this.changed();
  }

  redirected(url: string): void {
    this.#url = url;
    if (this.#pending) this.#pending.url = url;
  }

  committed(url: string): boolean {
    if (this.#failed || (this.#pending && !this.#pending.started) || url !== this.contents.getURL() ||
        (this.#pending?.url !== undefined && this.#pending.url !== url)) return false;
    this.#url = url;
    const pending = this.#pending;
    this.#pending = null;
    pending?.resolve();
    return true;
  }

  finished(): void {
    if (!this.#failed && this.#url !== undefined && this.#url !== this.contents.getURL()) return;
    this.loading = false;
    this.changed();
  }

  fail(code: number, url: string, source: WorkspaceWebFailureSource, networkError?: string): void {
    if (source === "render-process-gone") url = this.#pending?.url ?? this.#url ?? url;
    // Before this intent's start, native events still belong to the previous
    // document. loadURL rejection is separately fenced by its captured promise.
    if (this.#pending && !this.#pending.started && source !== "load-url" &&
        source !== "render-process-gone") return;
    if (url !== (this.#pending?.url ?? this.#url ?? this.contents.getURL())) return;
    if (this.#failed) return;
    this.loading = false;
    if (code === -3) {
      this.cancel("CANCELLED");
      this.changed();
      return;
    }
    this.#failed = true;
    this.#url = url;
    this.errorCode = code;
    this.cancel("FAILED");
    this.failed(code, url, source, networkError);
    this.changed();
  }

  cancel(reason: "SUPERSEDED" | "CANCELLED" | "FAILED" | "DESTROYED"): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(error(reason));
  }
}
