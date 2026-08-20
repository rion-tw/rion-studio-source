import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { readSourceTree as readFile } from "./helpers/readSourceTree";

const channel = "workspace-contained-fullscreen-test-channel";
let policySource = "";

beforeAll(async () => {
  policySource = (
    await readFile(
      new URL(
        "../src-tauri/src/system_runtime/workspace_contained_fullscreen.js",
        import.meta.url
      ),
      "utf8"
    )
  ).replaceAll("__RION_CONTAINED_FULLSCREEN_CHANNEL__", channel);
});

function createDocument(options: { popover?: boolean; url?: string } = {}) {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><main><section id='target'><video></video></section></main></body></html>",
    {
      runScripts: "outside-only",
      url: options.url ?? "https://workspace.rion.test/fixture",
    }
  );
  const { window } = dom;
  const transitions: Array<{ phase: string; sequence: number }> = [];
  Object.defineProperty(window, "__rionWorkspaceWebIdentity", {
    configurable: true,
    value: { capabilityToken: "capability", generation: 7 }
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: (_command: string, payload: { transition: { phase: string; sequence: number } }) => {
        transitions.push(payload.transition);
        return window.Promise.resolve({ documentEpoch: 1, fullscreen: payload.transition.phase === "enter" });
      }
    }
  });
  const popovers = new WeakSet<Element>();
  if (options.popover) {
    const nativeMatches = window.Element.prototype.matches;
    Object.defineProperty(window.Element.prototype, "matches", {
      configurable: true,
      value(this: Element, selector: string) {
        if (selector === ":popover-open") return popovers.has(this);
        return nativeMatches.call(this, selector);
      },
    });
    Object.defineProperties(window.HTMLElement.prototype, {
      hidePopover: {
        configurable: true,
        value(this: Element) {
          popovers.delete(this);
        },
      },
      showPopover: {
        configurable: true,
        value(this: Element) {
          popovers.add(this);
        },
      },
    });
  }
  window.eval(policySource);
  return { dom, popovers, transitions, window };
}

describe("Workspace Web contained fullscreen policy", () => {
  it("passes the about:blank page-world preflight without a host transition", () => {
    const { dom, transitions, window } = createDocument({ url: "about:blank" });
    const preflight = (window as unknown as {
      __rionWorkspaceContainedFullscreenPreflight(): boolean;
    }).__rionWorkspaceContainedFullscreenPreflight;

    expect(preflight()).toBe(true);
    expect(window.document.fullscreenElement).toBeNull();
    expect(transitions).toEqual([]);
    dom.window.close();
  });

  it("waits for host geometry, implements the standard getters and events, and exits", async () => {
    const { dom, transitions, window } = createDocument();
    const target = window.document.querySelector<HTMLElement>("#target")!;
    const ancestor = target.parentElement!;
    target.style.position = "relative";
    ancestor.style.setProperty("transform", "translateX(10px)", "important");
    const events: string[] = [];
    target.addEventListener("fullscreenchange", (event) => {
      events.push(event.type);
      if (window.document.fullscreenElement === target) {
        target.style.setProperty("width", "42px", "important");
      }
    });
    target.addEventListener("webkitfullscreenchange", (event) =>
      events.push(event.type)
    );

    const request = target.requestFullscreen();
    expect(request).toBeInstanceOf(window.Promise);
    await request;

    expect(window.document.fullscreenElement).toBe(target);
    expect((window.document as Document & {
      webkitFullscreenElement: Element | null;
    }).webkitFullscreenElement).toBe(target);
    expect(window.document.fullscreenEnabled).toBe(true);
    expect(target.hasAttribute("data-rion-contained-fullscreen")).toBe(true);
    expect(window.document.documentElement.dataset).toHaveProperty(
      "rionContainedFullscreenActive"
    );
    expect(window.document.querySelector("#__rion_web_toolbar_host")).toBeNull();
    expect(target.style.getPropertyValue("position")).toBe("fixed");
    expect(target.style.getPropertyValue("width")).toBe("100vw");
    expect(target.style.getPropertyPriority("width")).toBe("important");
    expect(ancestor.style.getPropertyValue("transform")).toBe("none");
    expect(events).toEqual(["fullscreenchange", "webkitfullscreenchange"]);
    expect(transitions.map(({ phase }) => phase)).toEqual(["ready", "enter"]);

    await window.document.exitFullscreen();
    expect(window.document.fullscreenElement).toBeNull();
    expect(target.hasAttribute("data-rion-contained-fullscreen")).toBe(false);
    expect(target.style.position).toBe("relative");
    expect(target.style.width).toBe("");
    expect(ancestor.style.getPropertyValue("transform")).toBe("translateX(10px)");
    expect(ancestor.style.getPropertyPriority("transform")).toBe("important");
    expect(events).toEqual([
      "fullscreenchange",
      "webkitfullscreenchange",
      "fullscreenchange",
      "webkitfullscreenchange",
    ]);
    expect(transitions.map(({ phase }) => phase)).toEqual(["ready", "enter", "exit"]);
    await expect(window.document.exitFullscreen()).resolves.toBeUndefined();
    dom.window.close();
  });

  it("uses the manual popover top layer and restores an injected attribute", async () => {
    const { dom, popovers, window } = createDocument({ popover: true });
    const target = window.document.querySelector<HTMLElement>("#target")!;

    await target.requestFullscreen();
    expect(target.getAttribute("popover")).toBe("manual");
    expect(popovers.has(target)).toBe(true);

    await window.document.exitFullscreen();
    expect(popovers.has(target)).toBe(false);
    expect(target.hasAttribute("popover")).toBe(false);
    dom.window.close();
  });

  it("restores state on Escape and when the active element is removed", async () => {
    const { dom, window } = createDocument();
    const target = window.document.querySelector<HTMLElement>("#target")!;

    await target.requestFullscreen();
    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    await vi.waitFor(() => expect(window.document.fullscreenElement).toBeNull());

    await target.requestFullscreen();
    target.remove();
    await vi.waitFor(() => expect(window.document.fullscreenElement).toBeNull());
    expect(window.document.documentElement.hasAttribute(
      "data-rion-contained-fullscreen-active"
    )).toBe(false);
    dom.window.close();
  });

  it("rebinds Escape handling when a popup replaces its provisional document", async () => {
    const { dom, window } = createDocument({ url: "about:blank" });
    const provisionalDocument = window.document;
    const navigatedDocument = provisionalDocument.implementation.createHTMLDocument("popup");
    const target = navigatedDocument.createElement("section");
    navigatedDocument.body.appendChild(target);
    const installation = (window as unknown as {
      __rionStudioWorkspaceContainedFullscreen: {
        bindDocument(nextDocument: Document): void;
        version: number;
      };
    }).__rionStudioWorkspaceContainedFullscreen;

    installation.bindDocument(navigatedDocument);
    expect(installation.version).toBe(3);
    await target.requestFullscreen();

    provisionalDocument.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(navigatedDocument.fullscreenElement).toBe(target);

    navigatedDocument.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    await vi.waitFor(() => expect(navigatedDocument.fullscreenElement).toBeNull());
    dom.window.close();
  });

  it("delegates Escape to the active popup policy across script worlds", async () => {
    const { dom, window } = createDocument({ url: "about:blank" });
    const popupDocument = window.document.implementation.createHTMLDocument("popup");
    const target = popupDocument.createElement("section");
    popupDocument.body.appendChild(target);
    const installation = (window as unknown as {
      __rionStudioWorkspaceContainedFullscreen: {
        bindDocument(nextDocument: Document): void;
      };
    }).__rionStudioWorkspaceContainedFullscreen;
    let activeElement: Element | null = target;
    let exitCalls = 0;
    Object.defineProperties(popupDocument, {
      exitFullscreen: {
        configurable: true,
        value: async () => {
          exitCalls += 1;
          activeElement = null;
        }
      },
      fullscreenElement: {
        configurable: true,
        get: () => activeElement
      }
    });

    installation.bindDocument(popupDocument);
    popupDocument.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );

    await vi.waitFor(() => expect(activeElement).toBeNull());
    expect(exitCalls).toBe(1);
    dom.window.close();
  });

  it("supports an event-bound host force-exit when the containing tab leaves", async () => {
    const { dom, transitions, window } = createDocument();
    const target = window.document.querySelector<HTMLElement>("#target")!;
    const events: string[] = [];
    target.addEventListener("fullscreenchange", () => events.push("change"));

    await target.requestFullscreen();
    window.document.dispatchEvent(
      new window.Event("__rionWorkspaceContainedFullscreenForceExit")
    );

    expect(window.document.fullscreenElement).toBeNull();
    expect(target.hasAttribute("data-rion-contained-fullscreen")).toBe(false);
    expect(events).toEqual(["change", "change"]);
    expect(transitions.map(({ phase }) => phase)).toEqual(["ready", "enter"]);
    dom.window.close();
  });

  it("supports repeated requests plus WebKit video aliases", async () => {
    const { dom, window } = createDocument();
    const target = window.document.querySelector<HTMLElement>("#target")!;
    const video = window.document.querySelector("video")!;

    await target.requestFullscreen();
    await target.requestFullscreen();
    expect(window.document.fullscreenElement).toBe(target);
    await window.document.exitFullscreen();

    const webkitVideo = video as HTMLVideoElement & {
      readonly webkitDisplayingFullscreen: boolean;
      webkitEnterFullscreen(): Promise<void>;
      webkitExitFullScreen(): Promise<void>;
    };
    await webkitVideo.webkitEnterFullscreen();
    expect((window.document as Document & {
      webkitCurrentFullScreenElement: Element | null;
    }).webkitCurrentFullScreenElement).toBe(video);
    expect(webkitVideo.webkitDisplayingFullscreen).toBe(true);
    await webkitVideo.webkitExitFullScreen();
    expect(webkitVideo.webkitDisplayingFullscreen).toBe(false);
    dom.window.close();
  });

  it("relays an allowed cross-origin child frame after the top host acknowledges geometry", async () => {
    const { dom, window } = createDocument();
    const frame = window.document.createElement("iframe");
    frame.setAttribute("allow", "fullscreen");
    window.document.body.appendChild(frame);
    const source = frame.contentWindow!;

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { __rionContainedFullscreen: channel, requestId: "child:1", type: "enter" },
        origin: "https://player.rion.test",
        source,
      })
    );
    await vi.waitFor(() => expect(window.document.fullscreenElement).toBe(frame));
    expect(frame.style.getPropertyValue("position")).toBe("fixed");
    expect(frame.style.getPropertyValue("width")).toBe("100vw");
    expect(frame.style.getPropertyPriority("width")).toBe("important");

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { __rionContainedFullscreen: channel, requestId: "child:2", type: "exit" },
        origin: "https://player.rion.test",
        source,
      })
    );
    await vi.waitFor(() => expect(window.document.fullscreenElement).toBeNull());
    dom.window.close();
  });

  it("rejects disconnected targets and emits both error aliases", async () => {
    const { dom, window } = createDocument();
    const target = window.document.createElement("div");
    const events: string[] = [];
    window.document.addEventListener("fullscreenerror", (event) =>
      events.push(event.type)
    );
    window.document.addEventListener("webkitfullscreenerror", (event) =>
      events.push(event.type)
    );

    await expect(target.requestFullscreen()).rejects.toMatchObject({
      name: "TypeError",
    });
    expect(events).toEqual(["fullscreenerror", "webkitfullscreenerror"]);
    dom.window.close();
  });
});

describe("Workspace Web surface wiring", () => {
  it("binds the macOS native fullscreen guard to a fenced failure receipt", async () => {
    const [native, runtime] = await Promise.all([
      readFile(new URL("../src-tauri/native/macos/RionWKWebViewInput/02_input_zoom.m", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/system_runtime/platform/macos.rs", import.meta.url), "utf8")
    ]);

    expect(native).toContain("rion_wk_bind_contained_fullscreen_failure_callback");
    expect(native).toContain("RionWKSurfaceUnexpectedNativeFullscreen");
    expect(runtime).toContain("unexpectedNativeFullscreenIsolated");
    expect(runtime).toContain("SYSTEM_UNEXPECTED_NATIVE_FULLSCREEN");
  });

  it("injects containment only for Workspace Web and carries the policy into popups", async () => {
    const source = await readFile(
      new URL(
        "../src-tauri/src/system_runtime/section_19_webview_builder.rs",
        import.meta.url
      ),
      "utf8"
    );

    expect(source).toContain("WebviewSurfaceFeaturePolicy::Role");
    expect(source).toContain("WebviewSurfaceFeaturePolicy::WorkspaceWeb");
    expect(source).toContain("WebviewSurfaceFeaturePolicy::Utility");
    expect(source).toContain("popup_install_contained_fullscreen");
    expect(source).toContain("workspace_contained_fullscreen_script()");
    expect(source).toContain("popupContainedFullscreenPolicyFailed");
    expect(source).toContain("preflight_platform_contained_fullscreen_policy");
    expect(source).toContain("defer_windows_contained_fullscreen_popup_setup");
    expect(source).toContain("drop(tauri::async_runtime::spawn_blocking");
    expect(source).toContain("popup_navigation_ready_for_handler.load(Ordering::Acquire)");
    expect(source).not.toContain("__rion_web_toolbar_host");
  });
});
