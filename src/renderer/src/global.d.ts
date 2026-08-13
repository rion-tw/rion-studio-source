import type { RionStudioApi } from "../../shared/api";

declare global {
  const __RION_DESKTOP_E2E__: boolean;

  interface Window {
    __rionStudioDesktopE2eNavigate?: (path: string) => Promise<void>;
    __rionShowStartupFailure?: (message: unknown) => void;
    rionStudio: RionStudioApi;
  }
}

export {};
