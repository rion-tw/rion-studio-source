import type { BaseWindow } from "electron";
import { MacosAppKitChromiumRuntimeHostFactory } from
  "../main/macosAppKitRuntimeHostFactory";
import { MacosAppKitRuntimePresentationController } from
  "../main/macosAppKitRuntimePresentationController";
import { ChromiumRuntimeLaunchCoordinator } from "../main/chromiumRuntimeLaunchCoordinator";
import { ElectronDisplayTopologyController } from "../main/electronDisplayTopologyController";
import {
  appendCoreFlowObservation,
  describeCoreFlowError,
  nextCoreFlowIdentity
} from "./coreFlowDiagnosticsObserver";

/** Disposable diagnostic branch: passive native submission/ACK bookends only. */
export function installAppKitInitialPresentationProbe(): void {
  if (process.platform !== "darwin") return;
  const windows = new Map<number, BaseWindow>();
  const journal = (type: string, identity: string, details: unknown,
    status: "started" | "completed" | "rejected" = "completed", error?: unknown) => {
    appendCoreFlowObservation({ boundary: "command", type, identity, status,
      details: { capturedAt: new Date().toISOString(), evidence: details },
      ...(error === undefined ? {} : { error: describeCoreFlowError(error) }) });
  };
  const read = (native: BaseWindow | undefined): unknown => {
    if (!native) return null;
    try {
      return { nativeHostId: native.id, destroyed: native.isDestroyed(),
        visible: native.isVisible(), focused: native.isFocused(),
        minimized: native.isMinimized(), fullscreen: native.isFullScreen(),
        fullscreenable: native.isFullScreenable(), maximized: native.isMaximized(),
        bounds: native.getBounds(), normalBounds: native.getNormalBounds() };
    } catch (error) { return { readError: describeCoreFlowError(error) }; }
  };
  const displays = ElectronDisplayTopologyController.prototype;
  const refresh = displays.refresh;
  const previousTopologies = new WeakMap<ElectronDisplayTopologyController,
    ReturnType<typeof refresh>>();
  displays.refresh = function (cause) {
    const before = previousTopologies.get(this);
    const after = refresh.call(this, cause);
    previousTopologies.set(this, after);
    if (before?.revision !== after.revision) {
      journal("appKitDisplayTopologyChanged", `display:${after.revision}`,
        { before: before ?? null, after });
    }
    return after;
  };
  const launches = ChromiumRuntimeLaunchCoordinator.prototype;
  const openEmpty = launches.openEmptySavedGameWindow;
  launches.openEmptySavedGameWindow = function (window) {
    const identity = nextCoreFlowIdentity(`appkit-empty-open:${window.id}`);
    journal("appKitEmptySavedWindowOpen", identity, { window }, "started");
    let result: ReturnType<typeof openEmpty>;
    try { result = openEmpty.call(this, window); }
    catch (error) {
      journal("appKitEmptySavedWindowOpen", identity, { windowId: window.id }, "rejected", error);
      throw error;
    }
    void result.then(() => journal("appKitEmptySavedWindowOpen", identity,
      { windowId: window.id }), (error: unknown) => journal("appKitEmptySavedWindowOpen",
      identity, { windowId: window.id }, "rejected", error));
    return result;
  };
  const factory = MacosAppKitChromiumRuntimeHostFactory;
  const fromElectron = factory.fromElectronBaseWindow;
  factory.fromElectronBaseWindow = function (addon, Constructor, observers) {
    const observedConstructor = new Proxy(Constructor, {
      construct(target, args) {
        const native = Reflect.construct(target, args, target) as BaseWindow;
        const nativeId = native.id;
        windows.set(nativeId, native);
        const identity = `appkit-native:${nativeId}`;
        journal("appKitNativeCreated", identity, read(native));
        for (const event of ["enter-full-screen", "leave-full-screen", "maximize",
          "unmaximize", "show", "focus", "blur", "closed"]) {
          native.on(event as "show", () => {
            journal("appKitNativeEvent", identity, { event, native: read(native) });
            if (event === "closed") windows.delete(nativeId);
          });
        }
        for (const name of ["setFullScreen", "maximize"] as const) {
          const original = native[name].bind(native);
          Object.defineProperty(native, name, { configurable: true, value: (...values: unknown[]) => {
            journal(`appKitNative:${name}`, identity, { args: values, native: read(native) }, "started");
            try {
              Reflect.apply(original, native, values);
              journal(`appKitNative:${name}`, identity, { native: read(native) });
            } catch (error) {
              journal(`appKitNative:${name}`, identity, { native: read(native) }, "rejected", error);
              throw error;
            }
          } });
        }
        return native;
      }
    });
    return fromElectron.call(this, {
      appKitRuntimeAbiVersion: () => addon.appKitRuntimeAbiVersion(),
      attachAppKitRuntimeHost: (handle, identity, callback) => {
        const native = [...windows.values()].find((window) =>
          !window.isDestroyed() && window.getNativeWindowHandle().equals(handle));
        journal("appKitControllerAttach", identity.logicalWindowId, { identity, native: read(native) });
        const controller = addon.attachAppKitRuntimeHost(handle, identity, (eventJson) => {
          let event: unknown;
          try { event = JSON.parse(eventJson); } catch { event = { invalidJson: true }; }
          journal("appKitNativeCallback", identity.logicalWindowId, { identity, event, native: read(native) });
          callback(eventJson);
        });
        return new Proxy(controller, { get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property === "prepareFullscreen" && typeof value === "function") {
            return (...args: unknown[]) => {
              journal("appKitPrepareFullscreen", identity.logicalWindowId,
                { identity, args, native: read(native) }, "started");
              try {
                const result: unknown = Reflect.apply(value, target, args);
                journal("appKitPrepareFullscreen", identity.logicalWindowId, { identity, native: read(native) });
                return result;
              } catch (error) {
                journal("appKitPrepareFullscreen", identity.logicalWindowId,
                  { identity, native: read(native) }, "rejected", error);
                throw error;
              }
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }
    }, observedConstructor, observers);
  };
  const presentation = MacosAppKitRuntimePresentationController.prototype;
  const initial = presentation.setInitialPresentation;
  presentation.setInitialPresentation = function (request, readProjection, requireCurrent) {
    const identity = nextCoreFlowIdentity(`appkit-initial:${request.windowId}`);
    journal("appKitInitialPresentation", identity, { request }, "started");
    const result = initial.call(this, request, readProjection, requireCurrent);
    void result.then((projection) => journal("appKitInitialPresentation", identity,
      { request, projection }), (error: unknown) => journal("appKitInitialPresentation", identity,
      { request }, "rejected", error));
    return result;
  };
  const observe = presentation.observeWindowPlacement;
  presentation.observeWindowPlacement = function () {
    const identity = nextCoreFlowIdentity("appkit-placement-ack");
    journal("appKitPlacementObservation", identity, {}, "started");
    const claimed = observe.call(this);
    journal("appKitPlacementObservation", identity, { claimed });
    return claimed;
  };
}
