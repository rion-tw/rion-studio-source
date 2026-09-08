import {
  bootstrapRenderer,
  type RendererNativeStartupStatus
} from "./app/bootstrapRenderer";

async function prepareElectronRenderer(): Promise<RendererNativeStartupStatus> {
  if (typeof window.rionStudio !== "object" || window.rionStudio === null) {
    throw new Error("The Chromium desktop bridge is unavailable.");
  }
  return { windowsMicaEnabled: false };
}

function reportElectronRendererStartupFailure(message: string): void {
  if (typeof window.rionStudio !== "object" || window.rionStudio === null) return;
  window.rionStudio.reportRendererLog({
    event: "renderer_error",
    message
  });
}

void bootstrapRenderer({
  prepare: prepareElectronRenderer,
  reportStartupFailure: reportElectronRendererStartupFailure
});
