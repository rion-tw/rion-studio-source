import {
  parseExtensionStoreNavigationRequest,
  type ExtensionStoreNavigationRequest
} from "../extensionStoreNavigationProtocol";

interface ExtensionStoreCaptureWindow {
  addEventListener: Window["addEventListener"];
}

function anchorFromEvent(event: MouseEvent): {
  readonly href: string;
  readonly target: string;
} | null {
  for (const candidate of event.composedPath()) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const element = candidate as { href?: unknown; tagName?: unknown; target?: unknown };
    if (element.tagName !== "A" || typeof element.href !== "string") continue;
    return {
      href: element.href,
      target: typeof element.target === "string" ? element.target : ""
    };
  }
  return null;
}

export function installExtensionStoreNavigationCapture(
  target: ExtensionStoreCaptureWindow,
  send: (request: ExtensionStoreNavigationRequest) => void
): void {
  target.addEventListener("click", (event) => {
    const click = event as MouseEvent;
    if (
      click.defaultPrevented || click.button !== 0 || click.altKey || click.ctrlKey ||
      click.metaKey || click.shiftKey
    ) return;
    const anchor = anchorFromEvent(click);
    if (!anchor || (anchor.target !== "" && anchor.target !== "_self")) return;
    const request = parseExtensionStoreNavigationRequest({ url: anchor.href });
    if (!request) return;
    click.preventDefault();
    click.stopImmediatePropagation();
    send(request);
  }, { capture: true });
}
