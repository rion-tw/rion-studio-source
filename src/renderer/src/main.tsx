import {
  bootstrapRenderer,
  type RendererNativeStartupStatus
} from "./app/bootstrapRenderer";
import {
  installTauriBridgeIfNeeded,
  reportRendererStartupFailure,
  waitForNativeStartup
} from "./tauri/installTauriBridge";

const desktopE2eReady = __RION_DESKTOP_E2E__ && __RION_DESKTOP_E2E_DRIVER__ === "tauri"
  ? import("@wdio/tauri-plugin").then(() => undefined)
  : Promise.resolve();

async function prepareTauriRenderer(): Promise<RendererNativeStartupStatus> {
  await desktopE2eReady;
  await installTauriBridgeIfNeeded();
  return await waitForNativeStartup();
}

void bootstrapRenderer({
  prepare: prepareTauriRenderer,
  reportStartupFailure: reportRendererStartupFailure
});
