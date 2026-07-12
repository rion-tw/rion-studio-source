import type { RionStudioApi } from "../../shared/api";

declare global {
  interface Window {
    rionStudio: RionStudioApi;
  }
}

export {};
