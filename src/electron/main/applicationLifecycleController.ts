import type { ApplicationLifecycleStatusRecord } from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";

export type ElectronApplicationPowerEvent = "resume" | "suspend";
type PowerListener = () => void;

export interface ElectronPowerMonitorPort {
  on: (event: ElectronApplicationPowerEvent, listener: PowerListener) => unknown;
  removeListener: (event: ElectronApplicationPowerEvent, listener: PowerListener) => unknown;
}

export interface ElectronApplicationLifecycleControllerInput {
  powerMonitor: ElectronPowerMonitorPort;
  platform: "darwin" | "win32";
  applyRuntimeSuspended: (suspended: boolean) => Promise<unknown>;
  publish: (status: ApplicationLifecycleStatusRecord) => void;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  now?: () => string;
}

export class ElectronApplicationLifecycleController {
  readonly #input: ElectronApplicationLifecycleControllerInput;
  #status: ApplicationLifecycleStatusRecord;
  #started = false;
  #disposed = false;
  #lane: Promise<void> = Promise.resolve();

  constructor(input: ElectronApplicationLifecycleControllerInput) {
    this.#input = input;
    this.#status = this.#record("active", "startup", 1, 1);
  }

  get lifecycleEpoch(): number {
    return this.#status.lifecycleEpoch;
  }

  start(): ApplicationLifecycleStatusRecord {
    if (this.#disposed) {
      throw new Error("The Electron application lifecycle controller has been disposed.");
    }
    if (!this.#started) {
      this.#started = true;
      this.#input.powerMonitor.on("suspend", this.#onSuspend);
      this.#input.powerMonitor.on("resume", this.#onResume);
    }
    return this.#status;
  }

  snapshot(): ApplicationLifecycleStatusRecord {
    return this.#status;
  }

  /** Joins the OS lifecycle lane and resolves only with this signal's exact terminal projection. */
  signal(event: ElectronApplicationPowerEvent): Promise<ApplicationLifecycleStatusRecord> {
    if (this.#disposed) {
      return Promise.reject(new RionBridgeError({
        code: "ELECTRON_APPLICATION_LIFECYCLE_DISPOSED",
        message: "The Electron application lifecycle controller has been disposed."
      }));
    }
    return this.#requestTransition(event === "suspend");
  }

  dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      if (this.#started) {
        this.#input.powerMonitor.removeListener("suspend", this.#onSuspend);
        this.#input.powerMonitor.removeListener("resume", this.#onResume);
      }
      this.#started = false;
    }
    return this.#lane;
  }

  readonly #onSuspend = (): void => this.#observePowerSignal("suspend");
  readonly #onResume = (): void => this.#observePowerSignal("resume");

  #observePowerSignal(event: ElectronApplicationPowerEvent): void {
    void this.signal(event).catch((error: unknown) => {
      const normalized = normalizeRionBridgeError(
        error,
        "ELECTRON_APPLICATION_LIFECYCLE_FAILED"
      );
      if (normalized.code !== "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED" &&
        normalized.code !== "ELECTRON_APPLICATION_LIFECYCLE_DISPOSED") {
        this.#input.onError(normalized);
      }
    });
  }

  #requestTransition(suspended: boolean): Promise<ApplicationLifecycleStatusRecord> {
    const lifecycleEpoch = this.#status.lifecycleEpoch + 1;
    this.#commit(
      suspended ? "suspending" : "resuming",
      suspended ? "power-suspend" : "power-resume",
      lifecycleEpoch
    );
    const transition = this.#lane
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.#input.applyRuntimeSuspended(suspended);
          if (this.#disposed) {
            throw new RionBridgeError({
              code: "ELECTRON_APPLICATION_LIFECYCLE_DISPOSED",
              message: "The Electron application lifecycle controller was disposed during transition."
            });
          }
          if (this.#status.lifecycleEpoch !== lifecycleEpoch) {
            throw new RionBridgeError({
              code: "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED",
              message: "A newer application lifecycle signal superseded this transition."
            });
          }
          this.#commit(
            suspended ? "suspended" : "active",
            suspended ? "power-suspended" : "power-resumed",
            lifecycleEpoch
          );
          return this.#status;
        } catch (error) {
          const normalized = normalizeRionBridgeError(
            error,
            "ELECTRON_APPLICATION_LIFECYCLE_FAILED"
          );
          if (normalized.code === "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED" ||
            normalized.code === "ELECTRON_APPLICATION_LIFECYCLE_DISPOSED") {
            throw error;
          }
          this.#input.onError(normalized);
          if (!this.#disposed && this.#status.lifecycleEpoch === lifecycleEpoch) {
            this.#commit("degraded", normalized.code, lifecycleEpoch);
          }
          return this.#status;
        }
      });
    this.#lane = transition.then(() => undefined, () => undefined);
    return transition;
  }

  #commit(
    state: ApplicationLifecycleStatusRecord["state"],
    reason: string,
    lifecycleEpoch: number
  ): void {
    this.#status = this.#record(
      state,
      reason,
      this.#status.revision + 1,
      lifecycleEpoch
    );
    this.#input.publish(this.#status);
  }

  #record(
    state: ApplicationLifecycleStatusRecord["state"],
    reason: string,
    revision: number,
    lifecycleEpoch: number
  ): ApplicationLifecycleStatusRecord {
    return {
      revision,
      capturedAt: (this.#input.now ?? (() => new Date().toISOString()))(),
      lifecycleEpoch,
      state,
      reason,
      platform: this.#input.platform === "darwin" ? "macos" : "windows"
    };
  }
}
