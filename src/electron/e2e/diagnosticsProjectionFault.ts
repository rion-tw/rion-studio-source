import { ElectronRuntimeDiagnosticsCollector } from "../main/electronRuntimeDiagnosticsCollector";
import { ChromiumRuntimeEffectExecutor } from "../main/chromiumRuntimeEffectExecutor";

/** Classified test fault: only diagnostics observes an orphaned native host. */
export function installDiagnosticsProjectionFault(): void {
  if (process.env.RION_STUDIO_E2E_PHASE !== "chromium-system-settings") return;
  let capturing = false;
  const capture = ElectronRuntimeDiagnosticsCollector.prototype.capture;
  ElectronRuntimeDiagnosticsCollector.prototype.capture = function () {
    capturing = true;
    // Production capture reads its event cache synchronously; no mutation is injected.
    try { return capture.call(this); } finally { capturing = false; }
  };
  const snapshot = ChromiumRuntimeEffectExecutor.prototype.snapshot;
  ChromiumRuntimeEffectExecutor.prototype.snapshot = function () {
    const observed = snapshot.call(this);
    if (!capturing) return observed;
    return { ...observed, windows: [...observed.windows, {
      windowId: "e2e-orphaned-native-host", activeTabId: "", tabIds: [], displayId: 1,
      bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false, focused: false,
      presentation: "normal", windowGeneration: 99, topologyRevision: 999
    }] };
  };
}
