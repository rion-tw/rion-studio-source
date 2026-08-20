import { invoke } from "@tauri-apps/api/core";

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

export function normalizeWorkspaceWebUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const back = document.querySelector<HTMLButtonElement>("#back");
const forward = document.querySelector<HTMLButtonElement>("#forward");
const reload = document.querySelector<HTMLButtonElement>("#reload");
const home = document.querySelector<HTMLButtonElement>("#home");
const form = document.querySelector<HTMLFormElement>("#location-form");
const locationInput = document.querySelector<HTMLInputElement>("#location");
let committedUrl = "";
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
  committedUrl = state.url;
  documentEpoch = state.documentEpoch;
  if (document.activeElement !== locationInput) locationInput!.value = state.url;
  locationInput!.removeAttribute("aria-invalid");
  back!.disabled = !state.canGoBack;
  forward!.disabled = !state.canGoForward;
};

back?.addEventListener("click", () => invokeAction("back"));
forward?.addEventListener("click", () => invokeAction("forward"));
reload?.addEventListener("click", () => invokeAction("reload"));
home?.addEventListener("click", () => invokeAction("home"));
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const normalized = normalizeWorkspaceWebUrl(locationInput!.value);
  if (!normalized) {
    locationInput!.setAttribute("aria-invalid", "true");
    return;
  }
  locationInput!.removeAttribute("aria-invalid");
  invokeAction("navigate", normalized);
});
locationInput?.addEventListener("input", () => locationInput.removeAttribute("aria-invalid"));
locationInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  locationInput.value = committedUrl;
  locationInput.removeAttribute("aria-invalid");
  locationInput.blur();
  event.preventDefault();
});

invokeAction("ready");
