import type { CoreEffectRequest } from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import {
  coreEffectEventContinuation,
  type CoreEffectContinuationCancelReason,
  type CoreEffectEventContinuation
} from "./coreEffectContinuation";
import type {
  ChromiumRuntimeHostPort,
  ChromiumRuntimeWindowStateObservation
} from "./chromiumRuntimeHostPorts";

export type ChromiumRuntimeOwnershipTransitionMode =
  | "focus"
  | "hide"
  | "reveal";

export interface ChromiumRuntimeOwnershipTransitionWindow {
  readonly host: ChromiumRuntimeHostPort;
  readonly mode: ChromiumRuntimeOwnershipTransitionMode;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
}

export interface ChromiumRuntimeOwnershipTransitionReceipt {
  readonly effectId: string;
  readonly lifecycleEpoch: number;
  readonly operationId: string;
  readonly status: "applied" | "superseded";
  readonly windows: readonly ChromiumRuntimeWindowStateObservation[];
}

interface HostBinding {
  readonly host: ChromiumRuntimeHostPort;
  unsubscribe: () => void;
  last: ChromiumRuntimeWindowStateObservation;
}

interface PendingWindow {
  readonly binding: HostBinding;
  readonly initialSequence: number;
  readonly mode: ChromiumRuntimeOwnershipTransitionMode;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  applied: ChromiumRuntimeWindowStateObservation | null;
  submitted: boolean;
}

interface PendingEffect {
  readonly effectId: string;
  readonly operationId: string;
  readonly lifecycleEpoch: number;
  readonly windows: readonly PendingWindow[];
  readonly completion: Promise<ChromiumRuntimeOwnershipTransitionReceipt>;
  readonly resolve: (receipt: ChromiumRuntimeOwnershipTransitionReceipt) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

export interface ChromiumRuntimeOwnershipTransitionCoordinatorInput {
  readonly lifecycleEpoch: () => number;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

function transitionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validFence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function cancellationCode(reason: CoreEffectContinuationCancelReason): string {
  return {
    actorStop: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_ACTOR_STOPPED",
    coreCancelled: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_CORE_CANCELLED",
    deadlineElapsed: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_DEADLINE_ELAPSED",
    eventStreamFailure: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_EVENT_STREAM_FAILED",
    focusSuperseded: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_FOCUS_SUPERSEDED",
    lifecycleSuperseded: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_LIFECYCLE_SUPERSEDED"
  }[reason];
}

function validObservation(
  observation: ChromiumRuntimeWindowStateObservation
): boolean {
  return validFence(observation.sequence) &&
    validFence(observation.lifecycleEpoch) &&
    validFence(observation.nativeHostId) &&
    validFence(observation.nativeGeneration) &&
    validFence(observation.windowGeneration) &&
    validFence(observation.topologyRevision) &&
    observation.logicalWindowId.length > 0 &&
    observation.logicalWindowId === observation.logicalWindowId.trim() &&
    typeof observation.visible === "boolean" &&
    typeof observation.minimized === "boolean" &&
    typeof observation.focused === "boolean" &&
    typeof observation.foreground === "boolean";
}

function satisfies(
  mode: ChromiumRuntimeOwnershipTransitionMode,
  observation: ChromiumRuntimeWindowStateObservation
): boolean {
  switch (mode) {
    case "focus":
      return observation.visible && !observation.minimized &&
        observation.focused && observation.foreground;
    case "hide":
      return !observation.visible;
    case "reveal":
      return observation.visible && !observation.minimized;
  }
}

function deferredEffect(
  effectId: string,
  operationId: string,
  lifecycleEpoch: number,
  windows: readonly PendingWindow[]
): PendingEffect {
  let resolve!: (receipt: ChromiumRuntimeOwnershipTransitionReceipt) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<ChromiumRuntimeOwnershipTransitionReceipt>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }
  );
  return {
    effectId,
    operationId,
    lifecycleEpoch,
    windows,
    completion,
    resolve,
    reject,
    settled: false
  };
}

/**
 * Process-global EventBound owner for runtime-window reveal and focus work.
 * Native adapters publish exact observations; this class never polls or turns
 * elapsed time into success.
 */
export class ChromiumRuntimeOwnershipTransitionCoordinator {
  readonly #input: ChromiumRuntimeOwnershipTransitionCoordinatorInput;
  readonly #bindings = new Map<string, HostBinding>();
  readonly #pending = new Map<string, PendingEffect>();
  readonly #pendingByWindow = new Map<string, Set<PendingEffect>>();
  readonly #retiredFocusSubmissions = new Map<string, Readonly<{
    lifecycleEpoch: number;
    minimumSequence: number;
  }>>();
  #focusEffect: PendingEffect | null = null;
  #closed = false;

  constructor(input: ChromiumRuntimeOwnershipTransitionCoordinatorInput) {
    this.#input = input;
  }

  synchronize(hosts: readonly ChromiumRuntimeHostPort[]): void {
    if (this.#closed) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_CLOSED",
        "The runtime-window transition coordinator is closed."
      );
    }
    const current = new Set(hosts);
    for (const [windowId, binding] of this.#bindings) {
      if (!current.has(binding.host)) this.#retireBinding(windowId, binding);
    }
    for (const host of hosts) this.#bind(host);
  }

  begin(
    effect: CoreEffectRequest,
    lifecycleEpoch: number,
    windows: readonly ChromiumRuntimeOwnershipTransitionWindow[]
  ): CoreEffectEventContinuation<ChromiumRuntimeOwnershipTransitionReceipt> {
    if (this.#closed) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_CLOSED",
        "The runtime-window transition coordinator is closed."
      );
    }
    if (!validFence(lifecycleEpoch) || lifecycleEpoch !== this.#input.lifecycleEpoch()) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_LIFECYCLE_STALE",
        "The Core effect belongs to a stale application lifecycle."
      );
    }
    if (this.#pending.has(effect.effectId) || windows.length === 0) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_INVALID",
        "The Core effect has duplicate or empty native window-transition work."
      );
    }
    const focusWindows = windows.filter((window) => window.mode === "focus");
    if (focusWindows.length > 1) {
      throw transitionError(
        "ELECTRON_CHROMIUM_FOCUS_INTENT_INVALID",
        "One Core effect may own at most one process-global focus target."
      );
    }
    const seen = new Set<string>();
    const pendingWindows = windows.map((window): PendingWindow => {
      const windowId = window.host.logicalWindowId;
      if (seen.has(windowId) || !validFence(window.windowGeneration) ||
          !validFence(window.topologyRevision)) {
        throw transitionError(
          "ELECTRON_CHROMIUM_WINDOW_TRANSITION_INVALID",
          "The Core effect contains a duplicate or malformed window fence."
        );
      }
      seen.add(windowId);
      const binding = this.#bindings.get(windowId);
      if (!binding || binding.host !== window.host) {
        throw transitionError(
          "ELECTRON_CHROMIUM_WINDOW_TRANSITION_HOST_STALE",
          "The Core effect references an unbound native runtime host."
        );
      }
      const initial = this.#read(binding, "initial");
      this.#validateFence(initial, lifecycleEpoch, window);
      return {
        binding,
        initialSequence: initial.sequence,
        mode: window.mode,
        topologyRevision: window.topologyRevision,
        windowGeneration: window.windowGeneration,
        applied: satisfies(window.mode, initial) ? initial : null,
        submitted: false
      };
    });
    for (const window of pendingWindows) {
      this.#validateSubmissionCapability(window);
    }
    for (const window of pendingWindows) this.#supersedeConflicts(window);
    if (focusWindows.length === 1 && this.#focusEffect) {
      this.#supersede(this.#focusEffect);
    }

    const pending = deferredEffect(
      effect.effectId,
      effect.operationId,
      lifecycleEpoch,
      pendingWindows
    );
    this.#pending.set(effect.effectId, pending);
    for (const window of pendingWindows) {
      const owners = this.#pendingByWindow.get(window.binding.host.logicalWindowId) ??
        new Set<PendingEffect>();
      owners.add(pending);
      this.#pendingByWindow.set(window.binding.host.logicalWindowId, owners);
      if (window.mode === "focus") this.#focusEffect = pending;
    }

    try {
      for (const window of pendingWindows) {
        if (pending.settled) break;
        if (window.applied && window.mode !== "focus") continue;
        switch (window.mode) {
          case "focus":
            window.submitted = true;
            // Focus is an imperative ownership claim, not only a state query.
            // A just-attached Chromium surface or the physical launcher action
            // can still deliver a queued blur after the initial read. Re-submit
            // the exact native focus claim even when that read is satisfied.
            if (!window.applied) {
              window.binding.host.showInactive!();
              if (pending.settled) break;
            }
            window.binding.host.focus();
            break;
          case "hide":
            window.submitted = true;
            window.binding.host.hide();
            break;
          case "reveal":
            window.submitted = true;
            window.binding.host.showInactive!();
            break;
        }
      }
    } catch (error) {
      this.#failFromUnknownTerminal(pending, error);
    }
    this.#completeIfApplied(pending);
    return coreEffectEventContinuation(
      pending.completion,
      (reason) => this.#cancel(effect.effectId, effect.operationId, reason)
    );
  }

  advanceLifecycle(lifecycleEpoch: number): void {
    if (!validFence(lifecycleEpoch)) return;
    for (const [windowId, retired] of this.#retiredFocusSubmissions) {
      if (retired.lifecycleEpoch !== lifecycleEpoch) {
        this.#retiredFocusSubmissions.delete(windowId);
      }
    }
    for (const pending of [...this.#pending.values()]) {
      if (pending.lifecycleEpoch !== lifecycleEpoch) {
        this.#supersede(pending);
      }
    }
  }

  observeExternalForeground(lifecycleEpoch: number): void {
    if (this.#focusEffect?.lifecycleEpoch === lifecycleEpoch) {
      this.#supersede(this.#focusEffect);
    }
  }

  close(reason: "actorStop" | "eventStreamFailure" = "actorStop"): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#pending.values()]) {
      this.#cancel(pending.effectId, pending.operationId, reason);
    }
    for (const binding of this.#bindings.values()) binding.unsubscribe();
    this.#bindings.clear();
    this.#retiredFocusSubmissions.clear();
  }

  #bind(host: ChromiumRuntimeHostPort): HostBinding {
    const current = this.#bindings.get(host.logicalWindowId);
    if (current?.host === host) return current;
    if (current) this.#retireBinding(host.logicalWindowId, current);
    if (!host.bindRuntimeWindowState || !host.readRuntimeWindowState) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_STATE_UNAVAILABLE",
        "The native runtime host has no authoritative window-state stream."
      );
    }
    const initial = host.readRuntimeWindowState();
    const binding: HostBinding = { host, unsubscribe: () => undefined, last: initial };
    this.#validateObservation(binding, initial);
    this.#bindings.set(host.logicalWindowId, binding);
    try {
      const unsubscribe = host.bindRuntimeWindowState((observation) => {
        try {
          this.#observe(binding, observation);
        } catch (error) {
          this.#failBinding(binding, error);
        }
      });
      if (typeof unsubscribe !== "function") {
        throw transitionError(
          "ELECTRON_CHROMIUM_WINDOW_STATE_UNAVAILABLE",
          "The native runtime host did not return an exact event unsubscriber."
        );
      }
      binding.unsubscribe = unsubscribe;
      this.#observe(binding, host.readRuntimeWindowState());
    } catch (error) {
      binding.unsubscribe();
      if (this.#bindings.get(host.logicalWindowId) === binding) {
        this.#bindings.delete(host.logicalWindowId);
      }
      throw error;
    }
    return binding;
  }

  #read(binding: HostBinding, source: "initial"):
  ChromiumRuntimeWindowStateObservation {
    const read = binding.host.readRuntimeWindowState;
    if (!read) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_STATE_UNAVAILABLE",
        "The native runtime host lost its authoritative state reader."
      );
    }
    const observation = read();
    this.#validateObservation(binding, observation);
    return Object.freeze({ ...observation, source });
  }

  #observe(
    binding: HostBinding,
    observation: ChromiumRuntimeWindowStateObservation
  ): void {
    if (this.#closed || this.#bindings.get(binding.host.logicalWindowId) !== binding) {
      return;
    }
    this.#validateObservation(binding, observation);
    if (observation.sequence <= binding.last.sequence) return;
    binding.last = observation;
    if (observation.source === "closed") {
      const owners = this.#pendingByWindow.get(observation.logicalWindowId);
      for (const pending of owners ? [...owners] : []) this.#supersede(pending);
      return;
    }
    if (observation.source === "failed") {
      this.#failBinding(binding, transitionError(
        observation.failureCode ?? "ELECTRON_CHROMIUM_WINDOW_EVENT_STREAM_FAILED",
        "The exact native runtime-window event stream terminated."
      ));
      return;
    }
    const retired = this.#retiredFocusSubmissions.get(observation.logicalWindowId);
    const retiredSubmissionObservation = !!retired &&
      observation.lifecycleEpoch === retired.lifecycleEpoch &&
      observation.sequence > retired.minimumSequence &&
      observation.visible && !observation.minimized &&
      observation.focused && observation.foreground &&
      this.#focusEffect?.windows.every((window) =>
        window.binding.host !== binding.host
      );
    if (retiredSubmissionObservation) {
      this.#retiredFocusSubmissions.delete(observation.logicalWindowId);
    }
    const focusedElsewhere = !retiredSubmissionObservation &&
      observation.focused && observation.foreground &&
      this.#focusEffect?.windows.every((window) =>
        window.binding.host !== binding.host
      );
    if (focusedElsewhere && this.#focusEffect) this.#supersede(this.#focusEffect);

    const owners = this.#pendingByWindow.get(observation.logicalWindowId);
    if (!owners) return;
    for (const pending of [...owners]) {
      if (pending.settled) continue;
      const window = pending.windows.find((candidate) =>
        candidate.binding === binding
      );
      if (!window || observation.sequence <= window.initialSequence) continue;
      if (
        observation.lifecycleEpoch !== pending.lifecycleEpoch ||
        observation.windowGeneration !== window.windowGeneration ||
        observation.topologyRevision !== window.topologyRevision
      ) {
        this.#supersede(pending);
        continue;
      }
      if (satisfies(window.mode, observation)) {
        window.applied = observation;
        this.#completeIfApplied(pending);
      }
    }
  }

  #validateObservation(
    binding: Pick<HostBinding, "host">,
    observation: ChromiumRuntimeWindowStateObservation
  ): void {
    if (!validObservation(observation) ||
        observation.logicalWindowId !== binding.host.logicalWindowId ||
        observation.nativeHostId !== binding.host.id ||
        (observation.platform === "macos") !==
          (binding.host.appKitIdentity !== undefined) ||
        (binding.host.appKitIdentity && (
          observation.appKitIdentity?.logicalWindowId !==
            binding.host.appKitIdentity.logicalWindowId ||
          observation.appKitIdentity.launchGeneration !==
            binding.host.appKitIdentity.launchGeneration ||
          observation.appKitIdentity.nativeGeneration !==
            binding.host.appKitIdentity.nativeGeneration
        ))) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_OBSERVATION_INVALID",
        "The native runtime host emitted stale or malformed window-state evidence."
      );
    }
  }

  #validateFence(
    observation: ChromiumRuntimeWindowStateObservation,
    lifecycleEpoch: number,
    expected: ChromiumRuntimeOwnershipTransitionWindow
  ): void {
    if (
      observation.lifecycleEpoch !== lifecycleEpoch ||
      observation.windowGeneration !== expected.windowGeneration ||
      observation.topologyRevision !== expected.topologyRevision
    ) {
      throw transitionError(
        "ELECTRON_CHROMIUM_WINDOW_TRANSITION_FENCE_STALE",
        "The native runtime host no longer matches the Core transition fence."
      );
    }
  }

  #validateSubmissionCapability(window: PendingWindow): void {
    if (!window.applied &&
        (window.mode === "focus" || window.mode === "reveal") &&
        typeof window.binding.host.showInactive !== "function") {
      throw transitionError(
        "ELECTRON_CHROMIUM_REVEAL_INACTIVE_UNAVAILABLE",
        window.mode === "focus"
          ? "The native runtime host cannot reveal before claiming focus."
          : "The native runtime host cannot reveal without stealing focus."
      );
    }
  }

  #supersedeConflicts(window: PendingWindow): void {
    const owners = this.#pendingByWindow.get(window.binding.host.logicalWindowId);
    if (!owners) return;
    for (const owner of [...owners]) {
      const prior = owner.windows.find((candidate) =>
        candidate.binding === window.binding
      );
      if (!prior) continue;
      if (window.mode === "hide" || window.mode === "focus" ||
          (window.mode === "reveal" && prior.mode !== "focus")) {
        this.#supersede(owner);
      }
    }
  }

  #completeIfApplied(pending: PendingEffect): void {
    if (pending.settled || pending.windows.some((window) => !window.applied)) return;
    this.#settle(pending);
    pending.resolve(Object.freeze({
      effectId: pending.effectId,
      operationId: pending.operationId,
      lifecycleEpoch: pending.lifecycleEpoch,
      status: "applied" as const,
      windows: Object.freeze(pending.windows.map((window) => window.applied!))
    }));
  }

  #supersede(pending: PendingEffect): void {
    if (pending.settled) return;
    this.#rememberRetiredFocusSubmission(pending);
    this.#settle(pending);
    pending.resolve(Object.freeze({
      effectId: pending.effectId,
      operationId: pending.operationId,
      lifecycleEpoch: pending.lifecycleEpoch,
      status: "superseded" as const,
      windows: Object.freeze(pending.windows
        .map((window) => window.applied)
        .filter((value): value is ChromiumRuntimeWindowStateObservation => !!value))
    }));
  }

  #rememberRetiredFocusSubmission(pending: PendingEffect): void {
    for (const window of pending.windows) {
      if (window.mode === "focus" && window.submitted && !window.applied) {
        this.#retiredFocusSubmissions.set(
          window.binding.host.logicalWindowId,
          Object.freeze({
            lifecycleEpoch: pending.lifecycleEpoch,
            minimumSequence: window.initialSequence
          })
        );
      }
    }
  }

  #cancel(
    effectId: string,
    operationId: string,
    reason: CoreEffectContinuationCancelReason
  ): void {
    const pending = this.#pending.get(effectId);
    if (!pending || pending.operationId !== operationId || pending.settled) return;
    if (reason === "focusSuperseded" || reason === "lifecycleSuperseded") {
      this.#supersede(pending);
      return;
    }
    this.#failFromUnknownTerminal(pending, transitionError(
      cancellationCode(reason),
      "The native runtime-window transition ended before native submission."
    ));
  }

  #failFromUnknownTerminal(pending: PendingEffect, error: unknown): void {
    const submitted = pending.windows.some((window) => window.submitted);
    if (submitted) this.#rememberRetiredFocusSubmission(pending);
    this.#fail(pending, submitted
      ? transitionError(
          "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
          "The native runtime-window transition lost exact evidence after submission."
        )
      : error);
  }

  #fail(pending: PendingEffect, error: unknown): void {
    if (pending.settled) return;
    this.#settle(pending);
    pending.reject(error);
  }

  #settle(pending: PendingEffect): void {
    pending.settled = true;
    this.#pending.delete(pending.effectId);
    if (this.#focusEffect === pending) this.#focusEffect = null;
    for (const window of pending.windows) {
      const windowId = window.binding.host.logicalWindowId;
      const owners = this.#pendingByWindow.get(windowId);
      owners?.delete(pending);
      if (owners?.size === 0) this.#pendingByWindow.delete(windowId);
    }
  }

  #retireBinding(windowId: string, binding: HostBinding): void {
    const owners = this.#pendingByWindow.get(windowId);
    for (const pending of owners ? [...owners] : []) this.#supersede(pending);
    binding.unsubscribe();
    if (this.#bindings.get(windowId) === binding) this.#bindings.delete(windowId);
  }

  #failBinding(binding: HostBinding, error: unknown): void {
    const owners = this.#pendingByWindow.get(binding.host.logicalWindowId);
    for (const pending of owners ? [...owners] : []) {
      this.#failFromUnknownTerminal(pending, error);
    }
    this.#input.onError(normalizeRionBridgeError(
      error,
      "ELECTRON_CHROMIUM_WINDOW_EVENT_STREAM_FAILED"
    ));
  }
}
