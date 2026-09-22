/** ECS owns component installation. Electron main owns this one-shot observation;
 * Role creation never waits for it. No credentials or vendor error text escape.
 */
export interface DrmComponentsPort {
  readonly WIDEVINE_CDM_ID: string;
  readonly updatesEnabled: boolean;
  whenReady(required: string[]): Promise<{ id: string; version: string | null }[]>;
}

export interface ChromiumDrmSnapshot {
  readonly revision: number;
  readonly source: "castlabs-ecs";
  readonly state: "idle" | "installing" | "ready" | "failed" | "unsupported" | "stopped";
  readonly componentVersion: string | null;
  readonly updatesEnabled: boolean | null;
  readonly failure: "component-api-unavailable" | "component-install-failed" | "invalid-component-result" | null;
}

export class ChromiumDrmRuntime {
  private current: ChromiumDrmSnapshot = Object.freeze({
    revision: 0, source: "castlabs-ecs", state: "idle", componentVersion: null,
    updatesEnabled: null, failure: null
  });
  private complete!: (snapshot: ChromiumDrmSnapshot) => void;
  private readonly settled = new Promise<ChromiumDrmSnapshot>(resolve => { this.complete = resolve; });

  snapshot(): ChromiumDrmSnapshot { return this.current; }

  whenSettled(): Promise<ChromiumDrmSnapshot> {
    return this.current.state === "idle" || this.current.state === "installing"
      ? this.settled : Promise.resolve(this.current);
  }

  /** Call only after app.whenReady(). The vendor Promise is the authoritative
   * EventBound result; an elapsed duration cannot decide component readiness.
   */
  start(components: DrmComponentsPort | undefined): void {
    if (this.current.state !== "idle") return;
    if (!components || typeof components.whenReady !== "function" || !components.WIDEVINE_CDM_ID) {
      this.publish({ state: "unsupported", failure: "component-api-unavailable" });
      return;
    }
    try {
      this.publish({ state: "installing", updatesEnabled: components.updatesEnabled });
      const revision = this.current.revision;
      const id = components.WIDEVINE_CDM_ID;
      void components.whenReady([id]).then(results => {
        if (this.current.revision !== revision) return;
        const result = results.find(entry => entry.id === id);
        const version = result?.version;
        if (typeof version !== "string" || !/^\d+(?:\.\d+){3}$/u.test(version)) {
          this.publish({ state: "failed", failure: "invalid-component-result" });
          return;
        }
        this.publish({ state: "ready", componentVersion: version });
      }).catch(() => {
        if (this.current.revision === revision) {
          this.publish({ state: "failed", failure: "component-install-failed" });
        }
      });
    } catch {
      this.publish({ state: "failed", failure: "component-install-failed" });
    }
  }

  /** ECS exposes no install abort. Quit stops observation and fences late
   * completion; process shutdown owns the underlying component updater.
   */
  stop(): void {
    if (this.current.state !== "stopped") this.publish({ state: "stopped" });
  }

  private publish(update: Partial<ChromiumDrmSnapshot>): void {
    this.current = Object.freeze({ ...this.current, ...update, revision: this.current.revision + 1 });
    if (this.current.state !== "installing") this.complete(this.current);
  }
}

export const workspaceWebDrmRuntime = new ChromiumDrmRuntime();
