// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGoogleFontPreviewRequests,
  getGoogleFontPreviewStatus,
  quoteFontFamily,
  requestGoogleFontPreview,
  resetGoogleFontPreviewRegistryForTests,
  retryGoogleFontPreview,
  subscribeGoogleFontPreview
} from "../src/renderer/src/features/settings/googleFontPreview";

afterEach(() => {
  resetGoogleFontPreviewRegistryForTests();
  vi.restoreAllMocks();
});

describe("Google Font settings previews", () => {
  it("deduplicates and encodes families with a text subset", () => {
    const requests = buildGoogleFontPreviewRequests(
      ["Noto Sans TC", "Inter", "Noto Sans TC"],
      "繁體中文 0123"
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.families).toEqual(["Inter", "Noto Sans TC"]);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.origin).toBe("https://fonts.googleapis.com");
    expect(url.searchParams.getAll("family")).toEqual(["Inter", "Noto Sans TC"]);
    expect(url.searchParams.get("display")).toBe("swap");
    expect(url.searchParams.get("text")).toBe("繁體中文 0123");
  });

  it("splits requests before the configured URL limit", () => {
    const requests = buildGoogleFontPreviewRequests(
      ["Atkinson Hyperlegible Next", "Noto Sans Traditional Chinese", "Source Serif 4"],
      "Rion Studio",
      120
    );

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap((request) => request.families)).toEqual([
      "Atkinson Hyperlegible Next",
      "Noto Sans Traditional Chinese",
      "Source Serif 4"
    ]);
  });

  it("batches same-tick requests and reports loaded status", async () => {
    const appended: HTMLLinkElement[] = [];
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      for (const node of nodes) {
        if (node instanceof HTMLLinkElement) appended.push(node);
      }
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn(async () => []) }
    });
    const statuses: string[] = [];
    const unsubscribe = subscribeGoogleFontPreview("Inter", "Rion", (status) => {
      statuses.push(status);
    });

    requestGoogleFontPreview("Inter", "Rion");
    requestGoogleFontPreview("Roboto", "Rion");
    await Promise.resolve();
    expect(appended).toHaveLength(1);
    expect(new URL(appended[0]?.href ?? "").searchParams.getAll("family")).toEqual([
      "Inter",
      "Roboto"
    ]);
    appended[0]?.onload?.(new Event("load"));
    await Promise.resolve();
    await Promise.resolve();

    expect(getGoogleFontPreviewStatus("Inter", "Rion")).toBe("loaded");
    expect(statuses).toContain("loading");
    expect(statuses.at(-1)).toBe("loaded");
    unsubscribe();
  });

  it("creates a fresh request when an errored preview is retried", async () => {
    const appended: HTMLLinkElement[] = [];
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      for (const node of nodes) {
        if (node instanceof HTMLLinkElement) appended.push(node);
      }
    });

    requestGoogleFontPreview("Handlee", "0123");
    await Promise.resolve();
    appended[0]?.onerror?.(new Event("error"));
    expect(getGoogleFontPreviewStatus("Handlee", "0123")).toBe("error");

    retryGoogleFontPreview("Handlee", "0123");
    await Promise.resolve();
    expect(appended).toHaveLength(2);
    expect(getGoogleFontPreviewStatus("Handlee", "0123")).toBe("loading");
    appended[1]?.onerror?.(new Event("error"));
  });

  it("quotes CSS family names safely", () => {
    expect(quoteFontFamily('Demo "Sans"')).toBe('"Demo \\"Sans\\""');
  });
});
