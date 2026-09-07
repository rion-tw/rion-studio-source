import { invoke } from "@tauri-apps/api/core";
import { installWorkspaceWebAddress } from "../../shared/workspaceWebAddress";

export type WorkspaceWebChromeIdentity = {
  capabilityToken: string;
  generation: number;
};

export type WorkspaceWebChromeState = {
  canGoBack: boolean;
  canGoForward: boolean;
  documentEpoch: number;
  url: string;
};

declare global {
  interface Window {
    __rionApplyWorkspaceWebChromeState?: (state: WorkspaceWebChromeState) => void;
    __rionWorkspaceWebChromeIdentity?: WorkspaceWebChromeIdentity;
  }
}

const back = document.querySelector<HTMLButtonElement>("#back");
const forward = document.querySelector<HTMLButtonElement>("#forward");
const reload = document.querySelector<HTMLButtonElement>("#reload");
const home = document.querySelector<HTMLButtonElement>("#home");
const form = document.querySelector<HTMLFormElement>("#location-form");
const locationInput = document.querySelector<HTMLInputElement>("#location");
const applyAddress = locationInput && form
  ? installWorkspaceWebAddress(locationInput, form, (url) => invokeAction("navigate", url))
  : undefined;
let documentEpoch = 0;

function invokeAction(type: "ready" | "back" | "forward" | "reload" | "home" | "navigate", url?: string): void {
  const identity = window.__rionWorkspaceWebChromeIdentity;
  if (!identity) return;
  void invoke("rion_workspace_web_chrome_action", {
    action: {
      capabilityToken: identity.capabilityToken,
      documentEpoch,
      generation: identity.generation,
      type,
      ...(url ? { url } : {})
    }
  }).then((state) => {
    window.__rionApplyWorkspaceWebChromeState?.(state as WorkspaceWebChromeState);
  }).catch((error: unknown) => {
    locationInput?.setAttribute("aria-invalid", "true");
    locationInput?.setAttribute("title", error instanceof Error ? error.message : String(error));
  });
}

window.__rionApplyWorkspaceWebChromeState = (state) => {
  applyAddress?.(state.url);
  documentEpoch = state.documentEpoch;
  locationInput!.removeAttribute("aria-invalid");
  back!.disabled = !state.canGoBack;
  forward!.disabled = !state.canGoForward;
};

back?.addEventListener("click", () => invokeAction("back"));
forward?.addEventListener("click", () => invokeAction("forward"));
reload?.addEventListener("click", () => invokeAction("reload"));
home?.addEventListener("click", () => invokeAction("home"));
invokeAction("ready");
