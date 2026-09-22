import { isWorkspaceStartUrl } from "./workspaceStartPage";
import type { WorkspaceWebChromeState } from "./workspaceWebChrome";

/** Paints a local shell projection; never discovers or changes navigation state. */
export function renderWorkspaceWebChrome(
  state: WorkspaceWebChromeState,
  validation: "empty" | "invalid" | null
): void {
  const { labels } = state;
  const input = document.querySelector<HTMLInputElement>("#location");
  document.documentElement.lang = state.language;
  document.documentElement.dataset.theme = state.resolvedTheme;
  document.documentElement.style.colorScheme = state.resolvedTheme;
  const nav = document.querySelector("nav");
  nav?.setAttribute("aria-label", labels.navigation);
  nav?.setAttribute("aria-busy", String(state.loading === true));
  for (const action of ["back", "forward", "reload", "home"] as const) {
    const button = document.querySelector<HTMLButtonElement>(`#${action}`);
    if (!button) continue;
    button.title = labels[action];
    button.setAttribute("aria-label", labels[action]);
    button.disabled = action === "back" ? !state.canGoBack : action === "forward" ? !state.canGoForward : false;
  }
  if (input) {
    input.disabled = false;
    input.placeholder = labels.placeholder;
    input.setAttribute("aria-label", labels.address);
  }
  const kind = validation ? "invalid" : state.errorCode !== undefined ? "failed"
    : state.loading ? "loading" : isWorkspaceStartUrl(state.url) ? "home" : "idle";
  const detail = validation === "empty" ? labels.emptyAddress : validation === "invalid" ? labels.invalidAddress
    : kind === "failed" || kind === "loading" ? state.statusText ?? labels[kind]
    : kind === "home" ? labels.home : labels.website;
  const form = document.querySelector<HTMLElement>("#location-form");
  if (form) form.dataset.state = kind;
  const icon = document.querySelector<HTMLElement>("#address-state");
  if (icon) {
    icon.title = detail;
    icon.setAttribute("aria-label", detail);
  }
  const summary = document.querySelector<HTMLElement>("#navigation-summary");
  if (summary) {
    summary.textContent = kind === "invalid" || kind === "failed" || kind === "loading" ? labels[kind] : "";
    summary.title = detail;
    summary.hidden = !summary.textContent;
  }
  const status = document.querySelector<HTMLElement>("#navigation-status");
  if (status) {
    const announcement = kind === "invalid" || kind === "failed" || kind === "loading" ? detail : "";
    // Duplicate projections should not repeatedly announce an unchanged status.
    if (status.textContent !== announcement) status.textContent = announcement;
    status.dataset.failed = String(state.errorCode !== undefined);
  }
  if (input) {
    if (validation) input.title = detail;
    else input.removeAttribute("title");
  }
}
