import {
  bootstrapRenderer,
  type RendererNativeStartupStatus
} from "./app/bootstrapRenderer";

async function prepareElectronRenderer(): Promise<RendererNativeStartupStatus> {
  if (typeof window.rionStudio !== "object" || window.rionStudio === null) {
    throw new Error("The Chromium desktop bridge is unavailable.");
  }
  // Mica is presentation-only: an unavailable backdrop degrades to the opaque
  // fallback surfaces instead of failing renderer startup.
  const windowsMicaEnabled = await window.rionStudio
    .getWindowsMicaEnabled()
    .catch(() => false);
  return { windowsMicaEnabled };
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
