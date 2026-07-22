import type { CoreEvent } from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";

export type ExternalChromeHealth = "healthy" | "unresponsive";

export interface ExternalChromeProbeFailure {
  errorCode: string;
  errorMessage: string;
  roleId: string;
}

export interface ExternalChromeHealthMonitor {
  heartbeat: (roleId: string, pageHidden: boolean) => void;
  onHealth: (listener: (roleId: string, health: ExternalChromeHealth) => void) => () => void;
  onProbeFailure: (listener: (failure: ExternalChromeProbeFailure) => void) => () => void;
  register: (roleId: string) => Promise<void>;
  remove: (roleId: string) => Promise<void>;
  setSuspended: (suspended: boolean) => void;
}

export class RustExternalChromeHealthMonitor implements ExternalChromeHealthMonitor {
  private readonly healthListeners = new Set<(
    roleId: string,
    health: ExternalChromeHealth
  ) => void>();
  private readonly probeFailureListeners = new Set<(
    failure: ExternalChromeProbeFailure
  ) => void>();

  constructor(private readonly core: AppCoreClient) {
    core.subscribe((events) => this.handleEvents(events));
  }

  async register(roleId: string): Promise<void> {
    await this.core.invoke({ type: "externalHealthRegister", roleId });
  }

  heartbeat(roleId: string, pageHidden: boolean): void {
    void this.core.invoke({ type: "externalHealthHeartbeat", roleId, pageHidden })
      .catch(() => undefined);
  }

  async remove(roleId: string): Promise<void> {
    await this.core.invoke({ type: "externalHealthRemove", roleId });
  }

  setSuspended(suspended: boolean): void {
    void this.core.invoke({ type: "externalHealthSuspend", suspended })
      .catch(() => undefined);
  }

  onHealth(listener: (roleId: string, health: ExternalChromeHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  onProbeFailure(listener: (failure: ExternalChromeProbeFailure) => void): () => void {
    this.probeFailureListeners.add(listener);
    return () => this.probeFailureListeners.delete(listener);
  }

  private handleEvents(events: CoreEvent[]): void {
    for (const event of events) {
      if (event.type === "externalHealthChanged" && isHealth(event.health)) {
        const health = event.health;
        this.healthListeners.forEach((listener) => listener(event.roleId, health));
      } else if (event.type === "externalHealthProbeFailed") {
        const failure = {
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          roleId: event.roleId
        };
        this.probeFailureListeners.forEach((listener) => listener(failure));
      }
    }
  }
}

function isHealth(value: string): value is ExternalChromeHealth {
  return value === "healthy" || value === "unresponsive";
}
