// @vitest-environment jsdom

import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

type IndicatorGlobals = typeof globalThis & {
  __rionStudioRuntimeIndicators?: { version: string };
  __rionStudioWorkspaceResizeIndicator?: (payload: { label?: string; type: string }) => void;
  __rionStudioZoomIndicator?: (label: string) => void;
};

const cssToken = "__RION_STUDIO_RUNTIME_INDICATOR_CSS__";
const hostId = "rion-studio-runtime-indicators-v1";

afterEach(() => {
  vi.useRealTimers();
  const globals = globalThis as IndicatorGlobals;
  delete globals.__rionStudioRuntimeIndicators;
  delete globals.__rionStudioWorkspaceResizeIndicator;
  delete globals.__rionStudioZoomIndicator;
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.style.fontSize = "";
});

describe("System WebView runtime indicators", () => {
  it("assembles once in an isolated shadow root and resists page host styles", async () => {
    const source = await assembledSource();
    expect(() => new Function(source)).not.toThrow();

    const hostileStyle = document.createElement("style");
    hostileStyle.textContent = `#${hostId}{font-size:99rem!important;position:static!important;top:0!important}`;
    document.head.append(hostileStyle);
    (0, eval)(source);
    (0, eval)(source);

    const globals = globalThis as IndicatorGlobals;
    globals.__rionStudioWorkspaceResizeIndicator?.({ label: "50 × 50", type: "show" });
    globals.__rionStudioZoomIndicator?.("125%");

    const hosts = document.querySelectorAll<HTMLElement>(`#${hostId}`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.style.getPropertyValue("position")).toBe("fixed");
    expect(hosts[0]?.style.getPropertyPriority("position")).toBe("important");
    expect(hosts[0]?.style.getPropertyValue("top")).toBe("16px");
    expect(hosts[0]?.style.getPropertyPriority("top")).toBe("important");
    expect(getComputedStyle(hosts[0]!).position).toBe("fixed");
    expect(getComputedStyle(hosts[0]!).top).toBe("16px");
    expect(hosts[0]?.shadowRoot?.querySelectorAll(".indicator")).toHaveLength(2);
    expect(document.querySelector(".indicator")).toBeNull();
  });

  it.each(["12px", "16px", "24px"])(
    "keeps its CSS-pixel typography when the game root font size is %s",
    async (rootFontSize) => {
      document.documentElement.style.fontSize = rootFontSize;
      (0, eval)(await assembledSource());
      (globalThis as IndicatorGlobals).__rionStudioZoomIndicator?.("110%");

      const indicator = indicatorElements()[0];
      expect(indicator).toBeDefined();
      const indicatorRoot = indicator?.getRootNode();
      const injectedCss = indicatorRoot instanceof ShadowRoot
        ? indicatorRoot.querySelector("style")?.textContent
        : undefined;
      expect(injectedCss).toBeTruthy();

      // jsdom does not resolve :host custom properties in computed Shadow DOM
      // styles, so assert the injected CSS-pixel token contract directly.
      expect(injectedCss).toContain("--type-body-size: 13px");
      expect(injectedCss).toContain("--space-1-5: 6px");
      expect(injectedCss).toContain("--space-2-5: 10px");
      expect(injectedCss).toContain("font-size:var(--type-body-size)");
      expect(injectedCss).toContain("padding:var(--space-1-5) var(--space-2-5)");
    }
  );

  it("keeps resize and zoom lifecycles independent while stacking both indicators", async () => {
    vi.useFakeTimers();
    (0, eval)(await assembledSource());
    const globals = globalThis as IndicatorGlobals;

    globals.__rionStudioWorkspaceResizeIndicator?.({ label: "40 × 60", type: "show" });
    globals.__rionStudioZoomIndicator?.("120%");
    expect(indicatorElements().map((element) => element.dataset.kind)).toEqual([
      "resize",
      "zoom"
    ]);

    vi.advanceTimersByTime(1199);
    globals.__rionStudioZoomIndicator?.("130%");
    vi.advanceTimersByTime(1199);
    expect(indicatorElements().map((element) => element.textContent)).toEqual([
      "40 × 60",
      "130%"
    ]);

    vi.advanceTimersByTime(1);
    expect(indicatorElements().map((element) => element.dataset.kind)).toEqual(["resize"]);
    globals.__rionStudioWorkspaceResizeIndicator?.({ type: "hide" });
    expect(indicatorElements()).toHaveLength(0);
    expect(document.querySelectorAll(`#${hostId}`)).toHaveLength(1);
  });

  it("keeps all injected overlay dimensions in the WebView-scaled CSS-pixel system", async () => {
    const [tokens, macroCss, indicatorCss, coordinateMeasurementModule] = await Promise.all([
      readFile("src/shared/designTokens.css", "utf8"),
      readFile("src/shared/browser-overlay/macroOverlay.css", "utf8"),
      readFile("src/shared/browser-overlay/runtimeIndicators.css", "utf8"),
      readFile("src/shared/browser-overlay/macroCoordinateMeasurement.js", "utf8")
    ]);
    const rootRelativeLength = /(?:^|[^a-z])(?:\d+(?:\.\d+)?|\.\d+)(?:rem|em)\b/i;

    expect(macroCss).not.toMatch(rootRelativeLength);
    expect(indicatorCss).not.toMatch(rootRelativeLength);
    expect(tokens).toContain("--type-micro-size: 10px");
    expect(tokens).toContain("--type-body-size: 13px");
    expect(macroCss).toContain("font-size:var(--type-micro-size)");
    expect(indicatorCss).toContain("font-size:var(--type-body-size)");
    expect(coordinateMeasurementModule).toContain('String(value.xPx) + "px"');
    expect(coordinateMeasurementModule).toContain('String(value.yPx) + "px"');
  });
});

async function assembledSource() {
  const [runtime, tokens, css] = await Promise.all([
    readFile("src/shared/browser-overlay/runtimeIndicators.js", "utf8"),
    readFile("src/shared/designTokens.css", "utf8"),
    readFile("src/shared/browser-overlay/runtimeIndicators.css", "utf8")
  ]);
  const token = JSON.stringify(cssToken);
  expect(runtime.split(token)).toHaveLength(2);
  const source = runtime.replace(token, JSON.stringify(`${tokens}\n${css}`));
  expect(source).not.toContain(cssToken);
  return source;
}

function indicatorElements() {
  const host = document.querySelector<HTMLElement>(`#${hostId}`);
  return Array.from(host?.shadowRoot?.querySelectorAll<HTMLElement>(".indicator") ?? []);
}
