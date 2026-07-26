import type { App, WebContents } from "electron";

import type {
  BrowserGraphicsSettingsRecord,
  GraphicsDiagnosticsRecord,
  RuntimeVersionRecord
} from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";

export interface GraphicsDiagnosticsServiceOptions {
  app: Pick<
    App,
    "getGPUFeatureStatus" | "getGPUInfo" | "isHardwareAccelerationEnabled"
  >;
  appliedSettings: BrowserGraphicsSettingsRecord;
  core: Pick<AppCoreClient, "invoke">;
  getVersions: () => Promise<RuntimeVersionRecord>;
  isGpuInfoReady: () => boolean;
  platform?: string;
}

/** Collects raw Electron probes; Rust normalizes, compares, and assembles the report. */
export class GraphicsDiagnosticsService {
  constructor(private readonly options: GraphicsDiagnosticsServiceOptions) {}

  async collect(sender: Pick<WebContents, "executeJavaScript">): Promise<GraphicsDiagnosticsRecord> {
    const gpuInfoReady = this.options.isGpuInfoReady();
    const [embedded, gpuInfo] = await Promise.all([
      collectRawEmbeddedProbe(sender),
      gpuInfoReady
        ? this.options.app.getGPUInfo("basic").catch(() => undefined)
        : Promise.resolve(undefined)
    ]);
    const featureStatus = gpuInfoReady
      ? this.options.app.getGPUFeatureStatus()
      : {};
    const hardwareAccelerationEnabled = gpuInfoReady
      ? this.options.app.isHardwareAccelerationEnabled()
      : null;

    return this.options.core.invoke({
      type: "graphicsDiagnosticsAssemble",
      appliedSettings: this.options.appliedSettings,
      embeddedRawJson: serializeRaw(embedded.value),
      ...(embedded.error ? { embeddedError: embedded.error } : {}),
      ...(gpuInfo === undefined ? {} : { gpuInfoRawJson: serializeRaw(gpuInfo) }),
      featureStatusRawJson: serializeRaw(featureStatus),
      gpuInfoReady,
      hardwareAccelerationEnabled,
      platform: this.options.platform ?? process.platform,
      versions: await this.options.getVersions()
    });
  }
}

async function collectRawEmbeddedProbe(
  sender: Pick<WebContents, "executeJavaScript">
): Promise<{ error?: string; value: unknown }> {
  try {
    return { value: await sender.executeJavaScript(WEB_GRAPHICS_PROBE_SOURCE) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Graphics probe failed.",
      value: null
    };
  }
}

function serializeRaw(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

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
