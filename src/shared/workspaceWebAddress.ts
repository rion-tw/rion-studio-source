import { isWorkspaceStartUrl } from "./workspaceStartPage";
import { canonicalWorkspaceWebUrl } from "./workspaceWebChrome";

/** Presentation only: never use the shortened value as authoritative state. */
export function displayWorkspaceWebUrl(url: string): string {
  if (isWorkspaceStartUrl(url)) return "";
  return url.replace(/^https:\/\/(?:www\.)?/u, "");
}

export function resolveWorkspaceWebAddress(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (/^https?:/iu.test(input)) {
    return /^https?:\/\//iu.test(input) ? canonicalWorkspaceWebUrl(input) : null;
  }
  // A port on a host is not a URI scheme. Explicit other schemes stay invalid.
  const host = input.split(/[/?#]/u, 1)[0]!;
  const hostWithPort = /^(?:localhost|[^\s:]+\.[^\s:]+|\[[^\]]+\]):\d+$/iu.test(host);
  if (/^[a-z][a-z\d+.-]*:/iu.test(input) && !hostWithPort) return null;
  if (!/\s/u.test(input) && (
    /^(?:localhost)(?::\d+)?$/iu.test(host) ||
    /^\[[^\]]+\](?::\d+)?$/u.test(host) ||
    /^[^\s:@]+\.[^\s:@]+(?::\d+)?$/u.test(host)
  )) return canonicalWorkspaceWebUrl(input);
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** Local editing state follows authoritative navigation events without polling. */
export function installWorkspaceWebAddress(
  input: HTMLInputElement,
  form: HTMLFormElement,
  navigate: (url: string) => void
): (url: string) => void {
  let committedUrl = "";
  let composing = false;
  const clearError = () => {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("title");
  };
  const restore = () => {
    input.value = displayWorkspaceWebUrl(committedUrl);
    clearError();
  };
  input.addEventListener("focus", () => { input.value = isWorkspaceStartUrl(committedUrl) ? "" : committedUrl; });
  input.addEventListener("blur", restore);
  input.addEventListener("input", clearError);
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || composing || event.keyCode === 229) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key !== "Escape") return;
    restore();
    input.blur();
    event.preventDefault();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (composing) return;
    const destination = resolveWorkspaceWebAddress(input.value);
    if (!destination) {
      input.setAttribute("aria-invalid", "true");
      return;
    }
    clearError();
    navigate(destination);
  });
  return (url) => {
    committedUrl = url;
    if (document.activeElement !== input) input.value = displayWorkspaceWebUrl(url);
    clearError();
  };
}
