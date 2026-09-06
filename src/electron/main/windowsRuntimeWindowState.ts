import type { Buffer } from "node:buffer";

import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeWindowStateObservation,
  ChromiumRuntimeWindowStateObserver,
  ChromiumRuntimeWindowStateSource
} from "./chromiumRuntimeHostPorts";
import type { WindowsRuntimeHostWindowPort } from
  "./windowsRuntimeHostNativePorts";

const STREAM_FAILURE_CODE =
  "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_STREAM_FAILED";
const PARENT_IDENTITY_PATTERN = /^[0-9a-f]{64}$/u;

export interface WindowsRuntimeForegroundReadback {
  readonly parentIdentity: string;
  readonly focusIdentity: string;
  readonly parentWasForeground: boolean;
  readonly parentVisible: boolean;
  readonly parentMinimized: boolean;
}

export interface WindowsRuntimeForegroundProbePort {
  readWindowsRuntimeForeground: (
    parentHandle: Buffer
  ) => WindowsRuntimeForegroundReadback;
}

interface WindowsRuntimeWindowStateStreamInput {
  readonly lifecycleEpoch: () => number;
  readonly logicalWindowId: string;
  readonly native: Pick<
    WindowsRuntimeHostWindowPort,
    | "getNativeWindowHandle"
    | "isFocused"
    | "isMinimized"
    | "isVisible"
  >;
  readonly nativeGeneration: number;
  readonly nativeHostId: number;
  readonly probe: WindowsRuntimeForegroundProbePort | null;
  readonly readCoreFence: () => Readonly<{
    windowGeneration: number;
    topologyRevision: number;
  }>;
  readonly isCurrent: () => boolean;
  readonly onError: (error: unknown) => void;
}

function stateError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requirePositive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw stateError(
      "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_FENCE_INVALID",
      `The exact Windows runtime-window ${field} fence is invalid.`
    );
  }
  return value as number;
}

function validateReadback(
  value: WindowsRuntimeForegroundReadback
): WindowsRuntimeForegroundReadback {
  if (!value || typeof value !== "object" ||
      typeof value.parentIdentity !== "string" ||
      !PARENT_IDENTITY_PATTERN.test(value.parentIdentity) ||
      typeof value.focusIdentity !== "string" ||
      !PARENT_IDENTITY_PATTERN.test(value.focusIdentity) ||
      typeof value.parentWasForeground !== "boolean" ||
      typeof value.parentVisible !== "boolean" ||
      typeof value.parentMinimized !== "boolean") {
    throw stateError(
      "ELECTRON_WINDOWS_RUNTIME_FOREGROUND_READBACK_INVALID",
      "The Win32 runtime-parent foreground readback was malformed."
    );
  }
  return value;
}

/**
 * EventBound Windows runtime-window state stream.
 *
 * Electron focus is accepted only when the exact process-owned parent HWND is
 * also the foreground window. Sequence advances only for authoritative native
 * events or a terminal stream event; synchronous reads never invent progress.
 */
export class WindowsRuntimeWindowStateStream {
  readonly #input: WindowsRuntimeWindowStateStreamInput;
  readonly #observers = new Set<ChromiumRuntimeWindowStateObserver>();
  #sequence = 1;
  #parentIdentity: string | null = null;
  #last: ChromiumRuntimeWindowStateObservation | null = null;
  #terminal: "closed" | "failed" | null = null;

  constructor(input: WindowsRuntimeWindowStateStreamInput) {
    this.#input = input;
  }

  bind(observer: ChromiumRuntimeWindowStateObserver): () => void {
    if (typeof observer !== "function") {
      throw stateError(
        "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_OBSERVER_INVALID",
        "The Windows runtime-window state observer is invalid."
      );
    }
    if (this.#terminal) {
      throw stateError(
        "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_STREAM_CLOSED",
        "The exact Windows runtime-window state stream has terminated."
      );
    }
    this.#last = this.#readExact("initial", this.#sequence);
    this.#observers.add(observer);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#observers.delete(observer);
    };
  }

  read(): ChromiumRuntimeWindowStateObservation {
    if (this.#terminal) {
      if (this.#last?.source === this.#terminal) return this.#last;
      throw stateError(
        "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_STREAM_CLOSED",
        "The exact Windows runtime-window state stream has terminated."
      );
    }
    if (!this.#input.isCurrent()) {
      throw stateError(
        "ELECTRON_RUNTIME_HOST_STALE_GENERATION",
        "The Windows runtime-host generation no longer owns this state stream."
      );
    }
    const observation = this.#readExact("initial", this.#sequence);
    this.#last = observation;
    return observation;
  }

  publish(source: Exclude<
    ChromiumRuntimeWindowStateSource,
    "closed" | "failed" | "initial"
  >): void {
    if (this.#terminal || !this.#input.isCurrent()) return;
    try {
      const observation = this.#readExact(source, this.#sequence + 1);
      this.#sequence = observation.sequence;
      this.#last = observation;
      this.#notify(observation);
    } catch (error) {
      this.fail(STREAM_FAILURE_CODE);
      this.#report(stateError(
        STREAM_FAILURE_CODE,
        error instanceof Error
          ? error.message
          : "The exact Windows runtime-window state stream failed."
      ));
    }
  }

  fail(failureCode = STREAM_FAILURE_CODE): void {
    this.#terminate("failed", failureCode);
  }

  close(): void {
    this.#terminate("closed");
  }

  #readExact(
    source: ChromiumRuntimeWindowStateSource,
    sequence: number
  ): ChromiumRuntimeWindowStateObservation {
    const probe = this.#input.probe;
    if (!probe) {
      throw stateError(
        "ELECTRON_WINDOWS_RUNTIME_FOREGROUND_PROBE_UNAVAILABLE",
        "The read-only Win32 runtime-parent foreground probe is unavailable."
      );
    }
    const lifecycleEpoch = requirePositive(
      this.#input.lifecycleEpoch(),
      "lifecycle epoch"
    );
    const fence = this.#input.readCoreFence();
    const windowGeneration = requirePositive(
      fence.windowGeneration,
      "window generation"
    );
    const topologyRevision = requirePositive(
      fence.topologyRevision,
      "topology revision"
    );
    const readback = validateReadback(probe.readWindowsRuntimeForeground(
      this.#input.native.getNativeWindowHandle()
    ));
    if (this.#parentIdentity && this.#parentIdentity !== readback.parentIdentity) {
      throw stateError(
        "ELECTRON_WINDOWS_RUNTIME_FOREGROUND_IDENTITY_CHANGED",
        "The Win32 runtime-parent identity changed within one native generation."
      );
    }
    this.#parentIdentity = readback.parentIdentity;
    const visible = this.#input.native.isVisible() && readback.parentVisible;
    const minimized = this.#input.native.isMinimized() ||
      readback.parentMinimized;
    const foreground = readback.parentWasForeground;
    const focused = this.#input.native.isFocused() && foreground &&
      visible && !minimized;
    return Object.freeze({
      platform: "windows" as const,
      source,
      sequence: requirePositive(sequence, "sequence"),
      lifecycleEpoch,
      logicalWindowId: this.#input.logicalWindowId,
      nativeHostId: requirePositive(this.#input.nativeHostId, "native host ID"),
      nativeGeneration: requirePositive(
        this.#input.nativeGeneration,
        "native generation"
      ),
      windowGeneration,
      topologyRevision,
      visible,
      minimized,
      focused,
      foreground
    });
  }

  #terminate(source: "closed" | "failed", failureCode?: string): void {
    if (this.#terminal) return;
    this.#terminal = source;
    if (this.#observers.size === 0) return;
    try {
      const lifecycleEpoch = requirePositive(
        this.#input.lifecycleEpoch(),
        "lifecycle epoch"
      );
      const fence = this.#input.readCoreFence();
      this.#sequence += 1;
      const observation = Object.freeze({
        platform: "windows" as const,
        source,
        sequence: this.#sequence,
        lifecycleEpoch,
        logicalWindowId: this.#input.logicalWindowId,
        nativeHostId: requirePositive(this.#input.nativeHostId, "native host ID"),
        nativeGeneration: requirePositive(
          this.#input.nativeGeneration,
          "native generation"
        ),
        windowGeneration: requirePositive(
          fence.windowGeneration,
          "window generation"
        ),
        topologyRevision: requirePositive(
          fence.topologyRevision,
          "topology revision"
        ),
        visible: false,
        minimized: false,
        focused: false,
        foreground: false,
        ...(failureCode ? { failureCode } : {})
      });
      this.#last = observation;
      this.#notify(observation);
    } catch (error) {
      if (this.#last) {
        this.#terminal = "failed";
        this.#sequence = Math.max(this.#sequence, this.#last.sequence + 1);
        const fallback = Object.freeze({
          ...this.#last,
          source: "failed" as const,
          sequence: this.#sequence,
          visible: false,
          minimized: false,
          focused: false,
          foreground: false,
          failureCode: STREAM_FAILURE_CODE
        });
        this.#last = fallback;
        this.#notify(fallback);
      }
      this.#report(error);
    } finally {
      this.#observers.clear();
    }
  }

  #notify(observation: ChromiumRuntimeWindowStateObservation): void {
    for (const observer of [...this.#observers]) {
      if (!this.#observers.has(observer)) continue;
      if (this.#terminal && observation.source !== "closed" &&
          observation.source !== "failed") return;
      try {
        observer(observation);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#input.onError(error);
    } catch {
      // A diagnostics consumer cannot corrupt the authoritative native stream.
    }
  }
}
