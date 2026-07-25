import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";

import { App } from "./App";
import { AppRouteError } from "./components/AppRouteError";
import { AppWindowStateSync } from "./components/AppWindowStateSync";
import { ConfirmationProvider } from "./components/ConfirmationDialog";
import { installTauriBridgeIfNeeded } from "./tauri/installTauriBridge";
import "./styles.css";

await installTauriBridgeIfNeeded();

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppWindowStateSync />
    <RouterProvider router={router} />
  </React.StrictMode>
);
