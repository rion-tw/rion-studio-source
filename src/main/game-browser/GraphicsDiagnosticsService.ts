import type { App, WebContents } from "electron";

import type { BrowserManager } from "../browser/BrowserManager";
import type { GameBrowserSettingsStore } from "./GameBrowserSettingsStore";
import type {
  BrowserGraphicsMode,
  GraphicsDeviceDiagnostics,
  GraphicsDiagnostics,
  WebGraphicsDiagnostics
} from "../../shared/types";

const PROBE_TIMEOUT_MS = 2_000;

export const WEB_GRAPHICS_PROBE_SOURCE = `(async () => {
  const result = { webgl: "unavailable", webgl2: "unavailable", webgpu: "unavailable" };
  try {
    const canvas = document.createElement("canvas");
    const webgl2 = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    const webgl = webgl2 || canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    result.webgl2 = webgl2 ? "available" : "unavailable";
    result.webgl = webgl ? "available" : "unavailable";
    if (webgl) {
      const extension = webgl.getExtension("WEBGL_debug_renderer_info");
      if (extension) {
        result.renderer = String(webgl.getParameter(extension.UNMASKED_RENDERER_WEBGL) || "");
        result.vendor = String(webgl.getParameter(extension.UNMASKED_VENDOR_WEBGL) || "");
      }
    }
    if (navigator.gpu && typeof navigator.gpu.requestAdapter === "function") {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      result.webgpu = adapter ? "available" : "unavailable";
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
})()`;

interface GraphicsDiagnosticsServiceOptions {
  app: Pick<
    App,
    "getGPUFeatureStatus" | "getGPUInfo" | "isHardwareAccelerationEnabled"
  >;
  appliedMode: BrowserGraphicsMode;
  browserManager: Pick<BrowserManager, "getAutomationSession" | "listStatuses">;
  gameBrowserSettingsStore: Pick<GameBrowserSettingsStore, "getSettings">;
  isGpuInfoReady: () => boolean;
  platform?: string;
  versions?: NodeJS.ProcessVersions;
}

export class GraphicsDiagnosticsService {
  constructor(private readonly options: GraphicsDiagnosticsServiceOptions) {}

  async collect(sender: Pick<WebContents, "executeJavaScript">): Promise<GraphicsDiagnostics> {
    const savedMode = (await this.options.gameBrowserSettingsStore.getSettings()).graphics.mode;
    const gpuInfoReady = this.options.isGpuInfoReady();
    const [embedded, gpuInfo] = await Promise.all([
      probeWebGraphics((source) => sender.executeJavaScript(source)),
      gpuInfoReady
        ? withTimeout(this.options.app.getGPUInfo("basic"), PROBE_TIMEOUT_MS).catch(() => undefined)
        : Promise.resolve(undefined)
    ]);
    const featureStatus = gpuInfoReady
      ? normalizeFeatureStatus(this.options.app.getGPUFeatureStatus())
      : {};
    const externalStatuses = this.options.browserManager
      .listStatuses()
      .filter((status) => status.runtimeMode === "external" && status.state === "running");
    const externalRoles = await Promise.all(
      externalStatuses.map(async (status) => {
        const session = this.options.browserManager.getAutomationSession(status.roleId);
        if (!session) {
          return {
            error: "Chrome DevTools connection is unavailable.",
            roleId: status.roleId,
            roleName: status.roleId,
            state: "unavailable" as const
          };
        }

        const probe = await probeWebGraphics((source) => session.target.evaluate(source));
        return {
          roleId: status.roleId,
          roleName: session.role.name,
          state: probe.error ? "unavailable" as const : "ready" as const,
          probe,
          ...(probe.error ? { error: probe.error } : {})
        };
      })
    );

    return {
      appliedMode: this.options.appliedMode,
      collectedAt: new Date().toISOString(),
      embedded,
      externalRoles,
      featureStatus,
      gpuDevice: readGpuDevice(gpuInfo),
      gpuInfoReady,
      hardwareAccelerationEnabled: gpuInfoReady ? this.options.app.isHardwareAccelerationEnabled() : null,
      platform: this.options.platform ?? process.platform,
      restartRequired: savedMode !== this.options.appliedMode,
      savedMode,
      versions: {
        chromium: this.options.versions?.chrome ?? process.versions.chrome ?? "unknown",
        electron: this.options.versions?.electron ?? process.versions.electron ?? "unknown",
        node: this.options.versions?.node ?? process.versions.node
      }
    };
  }
}

export async function probeWebGraphics(
  evaluate: (source: string) => Promise<unknown>
): Promise<WebGraphicsDiagnostics> {
  try {
    const value = await withTimeout(evaluate(WEB_GRAPHICS_PROBE_SOURCE), PROBE_TIMEOUT_MS);
    return normalizeWebGraphicsDiagnostics(value);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Graphics probe failed.",
      webgl: "unknown",
      webgl2: "unknown",
      webgpu: "unknown"
    };
  }
}

function normalizeWebGraphicsDiagnostics(value: unknown): WebGraphicsDiagnostics {
  const input = isRecord(value) ? value : {};
  return {
    webgl: normalizeAvailability(input.webgl),
    webgl2: normalizeAvailability(input.webgl2),
    webgpu: normalizeAvailability(input.webgpu),
    ...(typeof input.renderer === "string" && input.renderer ? { renderer: input.renderer } : {}),
    ...(typeof input.vendor === "string" && input.vendor ? { vendor: input.vendor } : {}),
    ...(typeof input.error === "string" && input.error ? { error: input.error } : {})
  };
}

function normalizeAvailability(value: unknown): WebGraphicsDiagnostics["webgl"] {
  return value === "available" || value === "unavailable" ? value : "unknown";
}

function normalizeFeatureStatus(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function readGpuDevice(value: unknown): GraphicsDeviceDiagnostics | undefined {
  if (!isRecord(value) || !Array.isArray(value.gpuDevice)) {
    return undefined;
  }

  const device = value.gpuDevice.find((candidate) => isRecord(candidate) && candidate.active) ?? value.gpuDevice[0];
  if (!isRecord(device)) {
    return undefined;
  }

  const aux = isRecord(value.auxAttributes) ? value.auxAttributes : {};
  return {
    ...(typeof device.active === "boolean" ? { active: device.active } : {}),
    ...(typeof device.deviceId === "number" ? { deviceId: device.deviceId } : {}),
    ...(typeof device.deviceString === "string" ? { deviceString: device.deviceString } : {}),
    ...(typeof device.vendorId === "number" ? { vendorId: device.vendorId } : {}),
    ...(typeof device.vendorString === "string" ? { vendorString: device.vendorString } : {}),
    ...(typeof aux.driverVendor === "string" ? { driverVendor: aux.driverVendor } : {}),
    ...(typeof aux.driverVersion === "string" ? { driverVersion: aux.driverVersion } : {})
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Graphics probe timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
