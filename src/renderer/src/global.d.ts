import type { RionStudioApi } from "../../shared/api";

declare global {
  const __RION_DESKTOP_E2E__: boolean;
  const __RION_DESKTOP_E2E_DRIVER__: "chromium" | "none" | "tauri";
  const __RION_DESKTOP_SHELL__: "electron" | "tauri";

  interface Window {
    __rionStudioDesktopE2eNavigate?: (path: string) => Promise<void>;
    __rionShowStartupFailure?: (message: unknown) => void;
    rionStudio: RionStudioApi;
  }
}

export {};
