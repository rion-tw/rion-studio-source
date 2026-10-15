import { app, type BaseWindow } from "electron";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  const resizeEnabled = process.env.RION_STUDIO_E2E_PHASE === "chromium-tabs-visible-seed" &&
    !!directory && isAbsolute(directory);
  const resizeSnapshots = new Map<string, unknown>();
  const resizeOwnerCapacity = 32;
  let droppedResizeOwners = 0;
  let resizeCaptureErrors = 0;
  let lastResizeCaptureError: string | null = null;
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const flushResize = (stage: string): void => {
    if (!resizeEnabled) return;
    try {
      writeFileSync(join(directory!, "electron-appkit-native-resize-observations.json"),
        `${JSON.stringify({ journalVersion: 1, ownerCapacity: resizeOwnerCapacity,
          nativeCapacity: 128, droppedOwners: droppedResizeOwners,
          captureErrors: resizeCaptureErrors, lastCaptureError: lastResizeCaptureError,
          flushedAt: new Date().toISOString(), flushStage: stage,
          coverage: "Snapshots from existing placement/focus callbacks; no added native event or ACK.",
          snapshots: [...resizeSnapshots.values()] }, null, 2)}\n`, "utf8");
    } catch { /* Diagnostic output cannot alter native ownership or terminality. */ }
  };
  if (resizeEnabled) app.once("will-quit", () => flushResize("will-quit"));
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
        const attachedIdentity = Object.freeze({ ...identity });
        const attachedHandle = Buffer.from(handle);
        let firstWindowPointer: string | undefined;
        const captureResize = (event: unknown): unknown => {
          if (!resizeEnabled || !object(event) || !object(event.action)) return event;
          const raw = event.action.diagnosticResizeJournal;
          if (!object(raw)) return event;
          const summary = { capacity: raw.capacity, dropped: raw.dropped,
            sequence: raw.sequence, recordCount: Array.isArray(raw.records) ? raw.records.length : null };
          try {
            if (raw.journalVersion !== 1 || raw.capacity !== 128 || !Array.isArray(raw.records) ||
                raw.records.length > 128 || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0 ||
                !Number.isSafeInteger(raw.dropped) || Number(raw.dropped) < 0) {
              throw new Error("The bounded native resize journal is malformed");
            }
            const records = raw.records;
            const last: unknown = records.at(-1);
            const windowPointer = object(last) && typeof last.windowPointer === "string"
              ? last.windowPointer : null;
            const validRecords = records.every((record, index) => object(record) &&
              record.windowID === attachedIdentity.logicalWindowId &&
              record.windowPointer === windowPointer &&
              Number.isSafeInteger(record.sequence) && Number(record.sequence) > 0 &&
              (index === 0 || Number(record.sequence) > Number(records[index - 1]?.sequence)));
            if (!validRecords) throw new Error("The native resize journal mixed its retained window owner");
            if (windowPointer && firstWindowPointer === undefined) firstWindowPointer = windowPointer;
            const key = JSON.stringify([attachedIdentity.logicalWindowId,
              attachedIdentity.launchGeneration, attachedIdentity.nativeGeneration]);
            if (!resizeSnapshots.has(key) && resizeSnapshots.size >= resizeOwnerCapacity) {
              resizeSnapshots.delete(resizeSnapshots.keys().next().value!);
              droppedResizeOwners++;
            }
            resizeSnapshots.set(key, { capturedAt: new Date().toISOString(), identity: attachedIdentity,
              callbackIdentity: event.identity, callbackType: event.action.type,
              sourceWindowMatches: event.action.sourceWindowId === attachedIdentity.logicalWindowId,
              callbackIdentityMatches: object(event.identity) &&
                event.identity.logicalWindowId === attachedIdentity.logicalWindowId &&
                event.identity.launchGeneration === attachedIdentity.launchGeneration &&
                event.identity.nativeGeneration === attachedIdentity.nativeGeneration,
              parentNativeHostId: native?.id ?? null, originalNativeHandle: attachedHandle.toString("hex"),
              currentNativeHandleMatches: !!native && !native.isDestroyed() &&
                windows.get(native.id) === native && native.getNativeWindowHandle().equals(attachedHandle),
              originalWindowPointer: firstWindowPointer ?? null,
              currentWindowPointerMatches: windowPointer !== null && windowPointer === firstWindowPointer,
              native: read(native), journal: raw });
          } catch (error) {
            resizeCaptureErrors++;
            lastResizeCaptureError = describeCoreFlowError(error).slice(0, 2_000);
          }
          // Avoid repeatedly exporting 128 native rows in the general Core journal.
          // The original eventJson still reaches the product callback unchanged.
          return { ...event, action: { ...event.action, diagnosticResizeJournal: summary } };
        };
        journal("appKitControllerAttach", identity.logicalWindowId, { identity, native: read(native) });
        const controller = addon.attachAppKitRuntimeHost(handle, identity, (eventJson) => {
          let event: unknown;
          try { event = JSON.parse(eventJson); } catch { event = { invalidJson: true }; }
          journal("appKitNativeCallback", identity.logicalWindowId,
            { identity, event: captureResize(event), native: read(native) });
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
  presentation.observeWindowPlacement = function (capturedPresentation) {
    const identity = nextCoreFlowIdentity("appkit-placement-ack");
    journal("appKitPlacementObservation", identity, { capturedPresentation }, "started");
    const claimed = observe.call(this, capturedPresentation);
    journal("appKitPlacementObservation", identity, { capturedPresentation, claimed });
    return claimed;
  };
}
