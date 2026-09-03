/// <reference lib="dom" />

import { ipcRenderer } from "electron";

import {
  WORKSPACE_WEB_CHROME_ACTION_CHANNEL,
  WORKSPACE_WEB_CHROME_STATE_CHANNEL,
  canonicalWorkspaceWebUrl,
  parseWorkspaceWebChromeAction,
  parseWorkspaceWebChromeState
} from "../../shared/workspaceWebChrome";
import {
  RUNTIME_ROLE_PLACEHOLDER_CHANNEL,
  RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL,
  parseRuntimeRolePlaceholderAction,
  parseRuntimeRolePlaceholderClaimReceipt,
  parseRuntimeRolePlaceholderState,
  type RuntimeRolePlaceholderState
} from "../../shared/runtimeRolePlaceholder";

let identity: Readonly<{ surfaceId: string; generation: number }> | null = null;
let committedUrl = "";

function elements() {
  return {
    back: document.querySelector<HTMLButtonElement>("#back"),
    forward: document.querySelector<HTMLButtonElement>("#forward"),
    reload: document.querySelector<HTMLButtonElement>("#reload"),
    home: document.querySelector<HTMLButtonElement>("#home"),
    form: document.querySelector<HTMLFormElement>("#location-form"),
    location: document.querySelector<HTMLInputElement>("#location")
  };
}

function send(type: string, url?: string): void {
  if (!identity) return;
  const action = parseWorkspaceWebChromeAction({
    ...identity,
    type,
    ...(url === undefined ? {} : { url })
  });
  if (action) ipcRenderer.send(WORKSPACE_WEB_CHROME_ACTION_CHANNEL, action);
}

function normalizedUrl(value: string): string | null {
  return canonicalWorkspaceWebUrl(value);
}

ipcRenderer.on(
  WORKSPACE_WEB_CHROME_STATE_CHANNEL,
  (_event, value: unknown) => {
    const state = parseWorkspaceWebChromeState(value);
    if (!state) return;
    if (identity && (
      identity.surfaceId !== state.surfaceId || identity.generation !== state.generation
    )) return;
    identity = Object.freeze({
      surfaceId: state.surfaceId,
      generation: state.generation
    });
    committedUrl = state.url;
    const controls = elements();
    if (document.activeElement !== controls.location && controls.location) {
      controls.location.value = state.url;
    }
    controls.location?.removeAttribute("aria-invalid");
    if (controls.back) controls.back.disabled = !state.canGoBack;
    if (controls.forward) controls.forward.disabled = !state.canGoForward;
  }
);

window.addEventListener("DOMContentLoaded", () => {
  if (document.body.matches("[data-rion-runtime-role-placeholder]")) {
    installRuntimeRolePlaceholder();
    return;
  }
  const controls = elements();
  controls.back?.addEventListener("click", () => send("back"));
  controls.forward?.addEventListener("click", () => send("forward"));
  controls.reload?.addEventListener("click", () => send("reload"));
  controls.home?.addEventListener("click", () => send("home"));
  controls.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const destination = normalizedUrl(controls.location?.value ?? "");
    if (!destination) {
      controls.location?.setAttribute("aria-invalid", "true");
      return;
    }
    controls.location?.removeAttribute("aria-invalid");
    send("navigate", destination);
  });
  controls.location?.addEventListener("input", () => {
    controls.location?.removeAttribute("aria-invalid");
  });
  controls.location?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    controls.location!.value = committedUrl;
    controls.location!.removeAttribute("aria-invalid");
    controls.location!.blur();
    event.preventDefault();
  });
});

function installRuntimeRolePlaceholder(): void {
  const roleName = document.querySelector<HTMLElement>("#role-name");
  const message = document.querySelector<HTMLElement>("#message");
  const claim = document.querySelector<HTMLButtonElement>("#claim");
  const error = document.querySelector<HTMLElement>("#error");
  if (!roleName || !message || !claim || !error) return;
  let state: RuntimeRolePlaceholderState | null = null;
  const render = (next: RuntimeRolePlaceholderState): void => {
    state = next;
    roleName.textContent = next.roleName;
    message.textContent = next.blocked
      ? `This role is open in “${next.ownerTabName ?? "another tab"}”.`
      : "This role is currently stopped.";
    claim.textContent = next.blocked ? "Stop there and open here" : "Open here";
    claim.disabled = false;
    error.hidden = true;
  };
  ipcRenderer.on(
    RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL,
    (_event, value: unknown) => {
      const next = parseRuntimeRolePlaceholderState(value);
      if (!next) return;
      if (state && (
        state.placeholderId !== next.placeholderId ||
        state.generation !== next.generation
      )) return;
      render(next);
    }
  );
  claim.addEventListener("click", async () => {
    if (!state) return;
    const submitted = state;
    claim.disabled = true;
    claim.textContent = "Opening…";
    error.hidden = true;
    try {
      const {
        blocked: _blocked,
        ownerTabName: _ownerTabName,
        roleName: _roleName,
        ...identity
      } = submitted;
      const action = parseRuntimeRolePlaceholderAction({
        ...identity,
        type: "claim"
      });
      if (!action) throw new Error("The role-slot identity is invalid.");
      const receipt = parseRuntimeRolePlaceholderClaimReceipt(
        await ipcRenderer.invoke(RUNTIME_ROLE_PLACEHOLDER_CHANNEL, action)
      );
      if (!receipt) throw new Error("The role-slot claim receipt is invalid.");
    } catch {
      if (state !== submitted) return;
      claim.disabled = false;
      claim.textContent = state.blocked ? "Stop there and open here" : "Open here";
      error.textContent = "Could not open the role. Try again.";
      error.hidden = false;
    }
  });
  const ready = parseRuntimeRolePlaceholderAction({ type: "ready" });
  if (ready) {
    void ipcRenderer.invoke(RUNTIME_ROLE_PLACEHOLDER_CHANNEL, ready)
      .then((value) => {
        const next = parseRuntimeRolePlaceholderState(value);
        if (next) render(next);
      })
      .catch(() => undefined);
  }
}
