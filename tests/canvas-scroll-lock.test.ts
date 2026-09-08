// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

const scrollLockSource = readFileSync(
  "src/shared/browser-overlay/canvasScrollLock.js",
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

});
