import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";

import { App } from "../App";
import { ApplicationQuitGuardProvider } from "../components/ApplicationQuitGuard";
import { AppRouteError } from "../components/AppRouteError";
import { AppWindowStateSync } from "../components/AppWindowStateSync";
import { ConfirmationProvider } from "../components/ConfirmationDialog";
import { RendererReadyReporter } from "../components/RendererReadyReporter";
import { showStartupFailure, startupFailureMessage } from "./startupFallback";
import { windowGestureMode } from "./windowGestureMode";
import "../styles.css";

export interface RendererNativeStartupStatus {
  windowsMicaEnabled: boolean;
}

export interface RendererShellBootstrap {
  prepare: () => Promise<RendererNativeStartupStatus>;
  reportStartupFailure: (message: string) => Promise<void> | void;
}

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

function initializeDocumentState(): void {
  const platform = detectPlatform();
  document.documentElement.dataset.platform = platform;
  document.documentElement.dataset.windowGestureMode = windowGestureMode(
    platform,
    __RION_DESKTOP_SHELL__
  );
  document.documentElement.dataset.windowFullscreen = "false";
  document.documentElement.dataset.windowMaximized = "false";
  document.documentElement.dataset.windowFocused = "true";
  document.documentElement.dataset.windowControlsScrolled = "false";
  document.documentElement.dataset.windowsMica = "fallback";
}

function reportStartupFailure(shell: RendererShellBootstrap, message: string): void {
  try {
    void Promise.resolve(shell.reportStartupFailure(message)).catch(() => undefined);
  } catch {
    // The bundled startup fallback remains authoritative when the native log lane is unavailable.
  }
}

export async function bootstrapRenderer(shell: RendererShellBootstrap): Promise<void> {
  initializeDocumentState();
  try {
    const startup = await shell.prepare();
    document.documentElement.dataset.windowsMica = startup.windowsMicaEnabled
      ? "enabled"
      : "fallback";
  } catch (error) {
    const message = startupFailureMessage(error);
    showStartupFailure(message);
    reportStartupFailure(shell, message);
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
    reportStartupFailure(shell, message);
  };
  root.render(
    <React.StrictMode>
      <RendererReadyReporter onFailure={handleRendererReadyFailure} />
      <AppWindowStateSync />
      <RouterProvider router={router} />
    </React.StrictMode>
  );
}
