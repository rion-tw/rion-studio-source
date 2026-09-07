import type { App } from "electron";

/** Establish the minimum supported window size; settings actions still use visible UI. */
export function installGraphicsSettingsViewport(app: Pick<App, "on">, phase: string | undefined): void {
  if (phase !== "chromium-graphics-settings-seed" && phase !== "chromium-graphics-settings-restart") return;
  app.on("browser-window-created", (_event, window) => {
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.setSize(960, 640);
    });
  });
}
