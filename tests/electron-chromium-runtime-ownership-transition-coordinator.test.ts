import type { CoreEffectRequest } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import { ChromiumRuntimeOwnershipTransitionCoordinator } from
  "../src/electron/main/chromiumRuntimeOwnershipTransitionCoordinator";
import type {
  ChromiumRuntimeHostPort,
  ChromiumRuntimeWindowStateObservation,
  ChromiumRuntimeWindowStateObserver,
  ChromiumRuntimeWindowStateSource
} from "../src/electron/main/chromiumRuntimeHostPorts";

function effect(effectId: string): CoreEffectRequest {
  return {
    effectId,
    operationId: `operation-${effectId}`,
    target: { kind: "app", handleId: "embedded-runtime" },
    completionPolicy: "eventBound",
    action: {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [],
      revealWindowIds: [],
      focusWindowIds: []
    }
  };
}

class FakeHost {
  readonly listeners = new Set<ChromiumRuntimeWindowStateObserver>();
  readonly focus = vi.fn(() => this.onFocus?.());
  readonly hide = vi.fn(() => this.onHide?.());
  readonly showInactive = vi.fn(() => this.onShowInactive?.());
  readonly host: ChromiumRuntimeHostPort;
  onFocus: (() => void) | null = null;
  onHide: (() => void) | null = null;
  onShowInactive: (() => void) | null = null;
  observation: ChromiumRuntimeWindowStateObservation;

  constructor(
    readonly logicalWindowId: string,
    readonly id: number,
    platform: "macos" | "windows" = "windows",
    showInactiveAvailable = true
  ) {
    this.observation = Object.freeze({
      platform,
      source: "initial",
      sequence: 1,
      lifecycleEpoch: 1,
      logicalWindowId,
      nativeHostId: id,
      nativeGeneration: 1,
      windowGeneration: 1,
      topologyRevision: 1,
      visible: false,
      minimized: false,
      focused: false,
      foreground: false,
      ...(platform === "macos"
        ? {
            appKitIdentity: {
              logicalWindowId,
              launchGeneration: `launch-${logicalWindowId}`,
              nativeGeneration: 1
            }
          }
        : {})
    });
    this.host = {
      id,
      logicalWindowId,
      contentView: {} as ChromiumRuntimeHostPort["contentView"],
      close: () => Promise.resolve(),
      focus: this.focus,
      hide: this.hide,
      getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      readProjection: () => ({
        displayId: 1,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: this.observation.visible,
        focused: this.observation.focused,
        presentation: "normal"
      }),
      isDestroyed: () => false,
      isVisible: () => this.observation.visible,
      show: () => undefined,
      bindRuntimeWindowState: (observer) => {
        this.listeners.add(observer);
        return () => this.listeners.delete(observer);
      },
      readRuntimeWindowState: () => this.observation,
      ...(showInactiveAvailable ? { showInactive: this.showInactive } : {}),
      ...(platform === "macos"
        ? { appKitIdentity: this.observation.appKitIdentity }
        : {})
    };
  }

  emit(
    source: ChromiumRuntimeWindowStateSource,
    state: Partial<ChromiumRuntimeWindowStateObservation>
  ): void {
    this.observation = Object.freeze({
      ...this.observation,
      ...state,
      source,
      sequence: this.observation.sequence + 1
    });
    for (const listener of this.listeners) listener(this.observation);
  }
}

function harness() {
  let lifecycleEpoch = 1;
  const onError = vi.fn();
  const coordinator = new ChromiumRuntimeOwnershipTransitionCoordinator({
    lifecycleEpoch: () => lifecycleEpoch,
    onError
  });
  return {
    coordinator,
    onError,
    setLifecycleEpoch: (value: number) => { lifecycleEpoch = value; }
  };
}

describe("Chromium runtime ownership transition coordinator", () => {
  it("reveals without focus and resolves only from a later exact native observation", async () => {
    const test = harness();
    const window = new FakeHost("window-1", 1);
    test.coordinator.synchronize([window.host]);
    const continuation = test.coordinator.begin(effect("effect-1"), 1, [{
      host: window.host,
      mode: "reveal",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    let settled = false;
    void continuation.completion.then(() => { settled = true; });

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.focus).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(settled).toBe(false);

    window.emit("show", { visible: true });
    await expect(continuation.completion).resolves.toMatchObject({
      effectId: "effect-1",
      status: "applied",
      windows: [expect.objectContaining({ visible: true, focused: false })]
    });
  });

  it("requires exact Windows foreground evidence in addition to Electron focus", async () => {
    const test = harness();
    const window = new FakeHost("window-1", 1);
    test.coordinator.synchronize([window.host]);
    const continuation = test.coordinator.begin(effect("effect-1"), 1, [{
      host: window.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    let settled = false;
    void continuation.completion.then(() => { settled = true; });

    window.emit("focus", { visible: true, focused: true, foreground: false });
    await Promise.resolve();
    expect(settled).toBe(false);
    window.emit("focus", { visible: true, focused: true, foreground: true });
    await expect(continuation.completion).resolves.toMatchObject({ status: "applied" });
  });

  it("registers the waiter before native submission so a synchronous focus event is retained", async () => {
    const test = harness();
    const window = new FakeHost("window-1", 1, "macos");
    window.onFocus = () => window.emit("focus", {
      visible: true,
      focused: true,
      foreground: true
    });
    test.coordinator.synchronize([window.host]);
    const continuation = test.coordinator.begin(effect("effect-1"), 1, [{
      host: window.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);

    await expect(continuation.completion).resolves.toMatchObject({ status: "applied" });
  });

  it("supersedes the older process-global focus lease and ignores its late event", async () => {
    const test = harness();
    const first = new FakeHost("window-1", 1);
    const second = new FakeHost("window-2", 2);
    test.coordinator.synchronize([first.host, second.host]);
    const old = test.coordinator.begin(effect("old"), 1, [{
      host: first.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    const current = test.coordinator.begin(effect("current"), 1, [{
      host: second.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);

    await expect(old.completion).resolves.toMatchObject({ status: "superseded" });
    first.emit("focus", { visible: true, focused: true, foreground: true });
    second.emit("focus", { visible: true, focused: true, foreground: true });
    await expect(current.completion).resolves.toMatchObject({
      effectId: "current",
      status: "applied"
    });
  });

  it("terminalizes lifecycle change and host close without polling", async () => {
    const test = harness();
    const first = new FakeHost("window-1", 1);
    test.coordinator.synchronize([first.host]);
    const lifecycle = test.coordinator.begin(effect("lifecycle"), 1, [{
      host: first.host,
      mode: "reveal",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    test.setLifecycleEpoch(2);
    test.coordinator.advanceLifecycle(2);
    await expect(lifecycle.completion).resolves.toMatchObject({
      effectId: "lifecycle",
      lifecycleEpoch: 1,
      status: "superseded"
    });

    const second = new FakeHost("window-2", 2);
    second.observation = Object.freeze({
      ...second.observation,
      lifecycleEpoch: 2
    });
    test.coordinator.synchronize([first.host, second.host]);
    const closed = test.coordinator.begin(effect("closed"), 2, [{
      host: second.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    second.emit("closed", {
      lifecycleEpoch: 2,
      visible: false,
      focused: false,
      foreground: false
    });
    await expect(closed.completion).resolves.toMatchObject({
      status: "superseded"
    });
    expect(test.onError).not.toHaveBeenCalled();

    const third = new FakeHost("window-3", 3);
    third.observation = Object.freeze({
      ...third.observation,
      lifecycleEpoch: 2
    });
    third.onShowInactive = () => third.emit("failed", {
      lifecycleEpoch: 2,
      visible: false,
      focused: false,
      foreground: false,
      failureCode: "WINDOW_STATE_PROBE_FAILED"
    });
    test.coordinator.synchronize([first.host, second.host, third.host]);
    const failed = test.coordinator.begin(effect("failed"), 2, [{
      host: third.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    await expect(failed.completion).rejects.toMatchObject({
      code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
    });
    expect(third.focus).not.toHaveBeenCalled();
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "WINDOW_STATE_PROBE_FAILED"
    }));
  });

  it("fails a missing reveal capability before submission or supersede", async () => {
    const test = harness();
    const window = new FakeHost("window-1", 1, "windows", false);
    window.observation = Object.freeze({ ...window.observation, visible: true });
    test.coordinator.synchronize([window.host]);
    const pendingHide = test.coordinator.begin(effect("hide"), 1, [{
      host: window.host,
      mode: "hide",
      windowGeneration: 1,
      topologyRevision: 1
    }]);

    expect(() => test.coordinator.begin(effect("focus"), 1, [{
      host: window.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }])).toThrow(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_REVEAL_INACTIVE_UNAVAILABLE"
    }));
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();

    window.emit("hide", { visible: false });
    await expect(pendingHide.completion).resolves.toMatchObject({
      effectId: "hide",
      status: "applied"
    });
  });

  it("classifies a native throw after submission as indeterminate without compensation", async () => {
    const test = harness();
    const window = new FakeHost("window-1", 1);
    window.onShowInactive = () => {
      throw new Error("native reveal result is unknown");
    };
    test.coordinator.synchronize([window.host]);
    const continuation = test.coordinator.begin(effect("reveal"), 1, [{
      host: window.host,
      mode: "reveal",
      windowGeneration: 1,
      topologyRevision: 1
    }]);

    await expect(continuation.completion).rejects.toMatchObject({
      code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
    });
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("fences a late focus event after an indeterminate submission", async () => {
    const test = harness();
    const oldWindow = new FakeHost("window-old", 1);
    const currentWindow = new FakeHost("window-current", 2);
    oldWindow.onFocus = () => {
      throw new Error("native focus result is unknown");
    };
    test.coordinator.synchronize([oldWindow.host, currentWindow.host]);
    const old = test.coordinator.begin(effect("old"), 1, [{
      host: oldWindow.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    await expect(old.completion).rejects.toMatchObject({
      code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
    });

    const current = test.coordinator.begin(effect("current"), 1, [{
      host: currentWindow.host,
      mode: "focus",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    oldWindow.emit("focus", {
      visible: true,
      focused: true,
      foreground: true
    });
    currentWindow.emit("focus", {
      visible: true,
      focused: true,
      foreground: true
    });
    await expect(current.completion).resolves.toMatchObject({
      effectId: "current",
      status: "applied"
    });
    expect(oldWindow.hide).not.toHaveBeenCalled();
  });

  it("classifies post-submission cancellation and actor stop as indeterminate", async () => {
    const cancelled = harness();
    const cancelledWindow = new FakeHost("window-cancelled", 1);
    cancelled.coordinator.synchronize([cancelledWindow.host]);
    const cancelledContinuation = cancelled.coordinator.begin(
      effect("cancelled"),
      1,
      [{
        host: cancelledWindow.host,
        mode: "reveal",
        windowGeneration: 1,
        topologyRevision: 1
      }]
    );
    const cancelledResult = expect(cancelledContinuation.completion).rejects
      .toMatchObject({
        code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
      });
    cancelledContinuation.cancel("coreCancelled");
    await cancelledResult;

    const stopped = harness();
    const stoppedWindow = new FakeHost("window-stopped", 2);
    stopped.coordinator.synchronize([stoppedWindow.host]);
    const stoppedContinuation = stopped.coordinator.begin(effect("stopped"), 1, [{
      host: stoppedWindow.host,
      mode: "reveal",
      windowGeneration: 1,
      topologyRevision: 1
    }]);
    const stoppedResult = expect(stoppedContinuation.completion).rejects
      .toMatchObject({
        code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
      });
    stopped.coordinator.close("actorStop");
    await stoppedResult;
    expect(cancelledWindow.hide).not.toHaveBeenCalled();
    expect(stoppedWindow.hide).not.toHaveBeenCalled();
  });

  it("fails admission against a stale Core generation or topology fence", () => {
    const test = harness();
    const window = new FakeHost("window-1", 1);
    test.coordinator.synchronize([window.host]);
    expect(() => test.coordinator.begin(effect("effect-1"), 1, [{
      host: window.host,
      mode: "reveal",
      windowGeneration: 2,
      topologyRevision: 1
    }])).toThrow(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_FENCE_STALE"
    }));
  });
});
