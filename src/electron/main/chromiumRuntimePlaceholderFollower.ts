import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectPorts";
import type { ChromiumRuntimeTabRecord, ChromiumRuntimeWindowRecord } from "./chromiumRuntimeAppKitProjection";
import { reconcileChromiumRuntimeRolePlaceholders } from "./chromiumRuntimeRolePlaceholderProjection";

/** Event-driven presentation follower. Readiness never occupies a topology lane. */
export class ChromiumRuntimePlaceholderFollower {
  #revision = 0;
  constructor(private readonly ports: ChromiumRuntimeEffectExecutorInput,
    private readonly tabs: Map<string, ChromiumRuntimeTabRecord>,
    private readonly windows: Map<string, ChromiumRuntimeWindowRecord>,
    private readonly isOpen: () => boolean) {}
  schedule(): void {
    const revision = ++this.#revision;
    if (!this.isOpen()) return;
    void reconcileChromiumRuntimeRolePlaceholders({
      ports: this.ports, tabs: this.tabs, windows: this.windows,
      isCurrent: () => this.isOpen() && revision === this.#revision
    }).catch((error: unknown) => {
      this.ports.onError({ code: "ELECTRON_ROLE_PLACEHOLDER_PROJECTION_FAILED",
        message: error instanceof Error ? error.message : "The local placeholder could not be presented." });
    });
  }
}
