// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

const scrollLockSource = readFileSync(
  "src/shared/browser-overlay/canvasScrollLock.js",
  "utf8"
);
const builderSource = readFileSync(
  "src-tauri/src/system_runtime/section_19_webview_builder.rs",
  "utf8"
);

function installScrollLock(): void {
  window.eval(scrollLockSource);
}

describe("role canvas scroll lock", () => {
  beforeEach(() => {
    document.documentElement.replaceChildren(document.createElement("head"), document.createElement("body"));
  });

  it("leaves ordinary documents scrollable and follows a dynamic #canvas", () => {
    installScrollLock();
    expect(getComputedStyle(document.documentElement).overflow).not.toBe("hidden");
    expect(getComputedStyle(document.body).overflow).not.toBe("hidden");

    const canvas = document.createElement("canvas");
    canvas.id = "canvas";
    document.body.append(canvas);
    expect(getComputedStyle(document.documentElement).overflow).toBe("hidden");
    expect(getComputedStyle(document.body).overflow).toBe("hidden");

    canvas.remove();
    expect(getComputedStyle(document.documentElement).overflow).not.toBe("hidden");
    expect(getComputedStyle(document.body).overflow).not.toBe("hidden");
  });

  it("does not install the style in child documents", () => {
    installScrollLock();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    expect(frame.contentDocument?.querySelector("[data-rion-canvas-scroll-lock]")).toBeNull();
  });

  it("uses the main-frame-only builder API and keeps popup initialization separate", () => {
    expect(builderSource).toContain(
      ".initialization_script(CANVAS_SCROLL_LOCK_INITIALIZATION_SCRIPT)"
    );
    expect(builderSource).not.toContain(
      ".initialization_script_for_all_frames(CANVAS_SCROLL_LOCK_INITIALIZATION_SCRIPT)"
    );
    const popupBuilder = builderSource.slice(
      builderSource.indexOf("let popup_builder = WebviewWindowBuilder::new"),
      builderSource.indexOf("let popup = popup_builder.build()")
    );
    expect(popupBuilder).not.toContain("CANVAS_SCROLL_LOCK_INITIALIZATION_SCRIPT");
  });
});
