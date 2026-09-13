import { describe, expect, it, vi } from "vitest";

import {
  parseExtensionStoreNavigationRequest
} from "../src/electron/extensionStoreNavigationProtocol";
import { installExtensionStoreNavigationCapture } from
  "../src/electron/preload/installExtensionStoreNavigationCapture";

const extensionId = "a".repeat(32);
const detailUrl = `https://chromewebstore.google.com/detail/fixture/${extensionId}`;

function captureHarness() {
  let listener: EventListener | null = null;
  const addEventListener = vi.fn((
    type: string,
    next: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    expect(type).toBe("click");
    expect(options).toEqual({ capture: true });
    listener = typeof next === "function" ? next : next.handleEvent.bind(next);
  });
  const send = vi.fn();
  installExtensionStoreNavigationCapture({
    addEventListener: addEventListener as unknown as Window["addEventListener"]
  }, send);
  return {
    dispatch(url: string, patch: Partial<MouseEvent> = {}) {
      const event = {
        altKey: false,
        button: 0,
        composedPath: () => [
          { tagName: "SPAN" },
          { href: url, tagName: "A", target: "" }
        ],
        ctrlKey: false,
        defaultPrevented: false,
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
        stopImmediatePropagation: vi.fn(),
        ...patch
      } as unknown as MouseEvent;
      if (!listener) throw new Error("capture listener missing");
      listener(event);
      return event;
    },
    send
  };
}

describe("Extension Store navigation capture", () => {
  it("stops an unmodified detail click before the page SPA and sends a closed request", () => {
    const capture = captureHarness();
    const event = capture.dispatch(detailUrl);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(capture.send).toHaveBeenCalledWith({ url: detailUrl });
  });

  it.each([
    ["search", "https://chromewebstore.google.com/search/adblock", {}],
    ["cross-origin", "https://example.test/detail/fixture", {}],
    ["modified", detailUrl, { metaKey: true }],
    ["new-window", detailUrl, { composedPath: () => [{
      href: detailUrl, tagName: "A", target: "_blank"
    }] }]
  ])("leaves %s clicks to the existing page or popup policy", (_kind, url, patch) => {
    const capture = captureHarness();
    const event = capture.dispatch(url, patch as Partial<MouseEvent>);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("closed-validates navigation messages", () => {
    expect(parseExtensionStoreNavigationRequest({ url: detailUrl })).toEqual({
      url: detailUrl
    });
    expect(parseExtensionStoreNavigationRequest({ url: detailUrl, extra: true })).toBeNull();
    expect(parseExtensionStoreNavigationRequest({ url: "not a url" })).toBeNull();
  });
});
