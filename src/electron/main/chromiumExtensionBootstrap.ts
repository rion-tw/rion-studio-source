import type { ServiceWorkers } from "electron";
import type { CompatibilityReadyRecord } from
  "../../../third_party/electron-chrome-extensions/src/browser/api/compatibility";

export type ExtensionBootstrapOutcome =
  | { status: "ready"; receipt: CompatibilityReadyRecord }
  | { status: "cancelled"; code: string }
  | { status: "failed"; code: string; relativeFile?: string; line?: number };

/** One load attempt, owned by its exact Role entry/lease. No worker restarts. */
export class ChromiumExtensionBootstrap {
  readonly result: Promise<ExtensionBootstrapOutcome>;
  #resolve!: (outcome: ExtensionBootstrapOutcome) => void;
  #outcome: ExtensionBootstrapOutcome | undefined;
  #versionId: number | undefined;
  #running = false;
  #wasRunning = false;
  #loaded = false;
  #receipt: CompatibilityReadyRecord | undefined;
  #pendingReceipt: { record: CompatibilityReadyRecord; versionId: number } | undefined;
  #startRequested = false;
  #events: string[] = [];
  readonly #origin: string;

  constructor(private readonly workers: ServiceWorkers, extensionId: string) {
    this.#origin = `chrome-extension://${extensionId}/`;
    this.result = new Promise(resolve => { this.#resolve = resolve; });
    workers.on("running-status-changed", this.#onStatus);
    workers.on("console-message", this.#onConsole);
  }

  get outcome(): ExtensionBootstrapOutcome | undefined { return this.#outcome; }

  inspect(): Readonly<{
    workerVersionId: number | null; nativeLoaded: boolean;
    workerRunning: boolean; workerWasRunning: boolean;
    compatibilityReady: boolean; events: readonly string[];
  }> {
    return { workerVersionId: this.#versionId ?? null, nativeLoaded: this.#loaded,
      workerRunning: this.#running, workerWasRunning: this.#wasRunning,
      compatibilityReady: this.#receipt !== undefined,
      events: [...this.#events] };
  }

  nativeLoaded(): void {
    this.#loaded = true;
    this.#record("native-loaded");
    if (!this.#wasRunning || !this.#receipt) this.#startNativeWorker();
    this.#maybeReady();
  }

  compatibilityReady(receipt: CompatibilityReadyRecord, versionId: number): void {
    if (this.#outcome) return;
    if (this.#versionId === undefined) {
      // Keep one sender-bound receipt until the native start result proves
      // the same version and extension scope. A different version is ignored.
      this.#pendingReceipt = { record: receipt, versionId };
      this.#record("compatibility-pending");
      return;
    }
    if (versionId !== this.#versionId) return;
    this.#receipt = receipt;
    this.#record("compatibility-ready");
    this.#maybeReady();
  }

  cancel(code = "EXTENSIONS_SESSION_RELEASED"): void {
    this.#finish({ status: "cancelled", code });
  }

  #onStatus = ({ versionId, runningStatus }: Electron.ServiceWorkersRunningStatusChangedEventParams): void => {
    if (this.#outcome) return;
    if (runningStatus === "starting" && this.#versionId === undefined) {
      const worker = this.workers.getWorkerFromVersionID(versionId);
      if (worker?.scope !== this.#origin || !worker.scriptURL.startsWith(this.#origin)) return;
      // Capture while starting: getInfoFromVersionID may already throw when an
      // evaluation error is delivered. Never infer ownership from console text.
      this.#versionId = versionId;
      if (this.#pendingReceipt?.versionId === versionId) {
        this.#receipt = this.#pendingReceipt.record;
        this.#record("compatibility-ready");
      }
      this.#pendingReceipt = undefined;
    }
    if (versionId !== this.#versionId) return;
    this.#running = runningStatus === "running";
    if (this.#running) this.#wasRunning = true;
    this.#record(runningStatus);
    this.#maybeReady();
  };

  #startNativeWorker(): void {
    if (this.#startRequested || this.#outcome) return;
    this.#startRequested = true;
    this.#record("start-requested");
    let started: ReturnType<ServiceWorkers["startWorkerForScope"]>;
    try {
      started = this.workers.startWorkerForScope(this.#origin);
    } catch {
      this.#finish({ status: "failed", code: "ELECTRON_EXTENSION_SERVICE_WORKER_START_FAILED" });
      return;
    }
    void started.then(worker => {
      if (this.#outcome) return;
      if (worker.scope !== this.#origin || !worker.scriptURL.startsWith(this.#origin) ||
          (this.#versionId !== undefined && worker.versionId !== this.#versionId)) {
        this.#finish({ status: "failed", code: "ELECTRON_EXTENSION_WORKER_IDENTITY_MISMATCH" });
        return;
      }
      this.#versionId = worker.versionId;
      this.#running = true;
      this.#wasRunning = true;
      this.#record("start-completed");
      if (this.#pendingReceipt?.versionId === worker.versionId) {
        this.#receipt = this.#pendingReceipt.record;
        this.#record("compatibility-ready");
      }
      this.#pendingReceipt = undefined;
      this.#maybeReady();
    }, () => {
      if (!this.#outcome) {
        this.#finish({ status: "failed", code: "ELECTRON_EXTENSION_SERVICE_WORKER_START_FAILED" });
      }
    });
  }

  #record(event: string): void {
    if (this.#events.length < 16) this.#events.push(event);
  }

  #onConsole = (_event: Electron.Event, details: Electron.MessageDetails): void => {
    if (this.#outcome || details.versionId !== this.#versionId ||
      details.source !== "javascript" || details.level !== 3) return;
    let relativeFile: string | undefined;
    try {
      const url = new URL(details.sourceUrl);
      if (`${url.protocol}//${url.host}/` === this.#origin) {
        relativeFile = decodeURIComponent(url.pathname.slice(1));
      }
    } catch { /* Identity comes from the captured worker, not the source URL. */ }
    this.#finish({
      status: "failed", code: "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR",
      relativeFile, line: details.lineNumber
    });
  };

  #maybeReady(): void {
    if (this.#loaded && this.#wasRunning && this.#receipt) {
      this.#finish({ status: "ready", receipt: this.#receipt });
    }
  }

  #finish(outcome: ExtensionBootstrapOutcome): void {
    if (this.#outcome) return;
    this.#outcome = outcome;
    this.workers.removeListener("running-status-changed", this.#onStatus);
    this.workers.removeListener("console-message", this.#onConsole);
    this.#resolve(outcome);
  }
}
