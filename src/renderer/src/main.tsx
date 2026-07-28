import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";

import { App } from "./App";
import { AppRouteError } from "./components/AppRouteError";
import { AppWindowStateSync } from "./components/AppWindowStateSync";
import { ConfirmationProvider } from "./components/ConfirmationDialog";
import { RendererReadyReporter } from "./components/RendererReadyReporter";
import { showStartupFailure, startupFailureMessage } from "./app/startupFallback";
import {
  installTauriBridgeIfNeeded,
  reportRendererStartupFailure,
  waitForNativeStartup
} from "./tauri/installTauriBridge";
import "./styles.css";

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

async function bootstrapRenderer(): Promise<void> {
  try {
    await installTauriBridgeIfNeeded();
    await waitForNativeStartup();
  } catch (error) {
    const message = startupFailureMessage(error);
    showStartupFailure(message);
    void reportRendererStartupFailure(message).catch(() => undefined);
    return;
  }

  document.documentElement.dataset.platform = detectPlatform();
  document.documentElement.dataset.windowFullscreen = "false";

  const router = createHashRouter([
    {
      path: "*",
      element: (
        <ConfirmationProvider>
          <App />
        </ConfirmationProvider>
      ),
      errorElement: <AppRouteError />
    }
  ]);
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
