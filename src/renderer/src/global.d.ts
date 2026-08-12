import type { RionStudioApi } from "../../shared/api";

declare global {
  const __RION_DESKTOP_E2E__: boolean;

  interface Window {
    __rionShowStartupFailure?: (message: unknown) => void;
    rionStudio: RionStudioApi;
  }
}

export {};
