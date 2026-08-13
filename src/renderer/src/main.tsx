import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";

import { App } from "./App";
import { AppRouteError } from "./components/AppRouteError";
import { AppWindowStateSync } from "./components/AppWindowStateSync";
import { ConfirmationProvider } from "./components/ConfirmationDialog";
import { ApplicationQuitGuardProvider } from "./components/ApplicationQuitGuard";
import { RendererReadyReporter } from "./components/RendererReadyReporter";
import { showStartupFailure, startupFailureMessage } from "./app/startupFallback";
import {
  installTauriBridgeIfNeeded,
  reportRendererStartupFailure,
  waitForNativeStartup
} from "./tauri/installTauriBridge";
import "./styles.css";

const desktopE2eReady = __RION_DESKTOP_E2E__
  ? import("@wdio/tauri-plugin").then(() => undefined)
  : Promise.resolve();

function detectPlatform(): "linux" | "mac" | "windows" {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "mac";
  }

  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }

  return "linux";
}

document.documentElement.dataset.platform = detectPlatform();
document.documentElement.dataset.windowFullscreen = "false";
document.documentElement.dataset.windowMaximized = "false";
document.documentElement.dataset.windowFocused = "true";
document.documentElement.dataset.windowControlsScrolled = "false";
document.documentElement.dataset.windowsMica = "fallback";

async function bootstrapRenderer(): Promise<void> {
  try {
    await desktopE2eReady;
    await installTauriBridgeIfNeeded();
    const startup = await waitForNativeStartup();
    document.documentElement.dataset.windowsMica = startup.windowsMicaEnabled ? "enabled" : "fallback";
  } catch (error) {
    const message = startupFailureMessage(error);
    showStartupFailure(message);
    void reportRendererStartupFailure(message).catch(() => undefined);
    return;
  }

  const router = createHashRouter([
    {
      path: "*",
      element: (
        <ConfirmationProvider>
          <ApplicationQuitGuardProvider>
            <App />
          </ApplicationQuitGuardProvider>
        </ConfirmationProvider>
      ),
      errorElement: <AppRouteError />
    }
  ]);
  if (__RION_DESKTOP_E2E__) {
    window.__rionStudioDesktopE2eNavigate = (path) => router.navigate(path);
  }
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    showStartupFailure(new Error("The renderer root element is unavailable."));
    return;
  }

  const root = ReactDOM.createRoot(rootElement);
  const handleRendererReadyFailure = (error: unknown): void => {
    const message = startupFailureMessage(error);
    root.unmount();
    showStartupFailure(message);
    void reportRendererStartupFailure(message).catch(() => undefined);
  };
  root.render(
    <React.StrictMode>
      <RendererReadyReporter onFailure={handleRendererReadyFailure} />
      <AppWindowStateSync />
      <RouterProvider router={router} />
    </React.StrictMode>
  );
}

void bootstrapRenderer();
