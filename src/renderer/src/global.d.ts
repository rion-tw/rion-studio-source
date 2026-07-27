import type { RionStudioApi } from "../../shared/api";

declare global {
  interface Window {
    __rionShowStartupFailure?: (message: unknown) => void;
    rionStudio: RionStudioApi;
  }
}

export {};
