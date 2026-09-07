// @vitest-environment jsdom
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildWorkspaceStartPage } from "../scripts/generateWorkspaceStartPage.mjs";
import { WORKSPACE_START_URL, isWorkspaceStartUrl, workspaceWebLaunchUrl } from "../src/shared/workspaceStartPage";
import { installWorkspaceWebAddress, resolveWorkspaceWebAddress } from "../src/shared/workspaceWebAddress";
import { parseWorkspaceWebChromeAction, parseWorkspaceWebChromeState } from "../src/shared/workspaceWebChrome";
import catalog from "../src/shared/workspaceWebCatalog.json";

describe("packaged website entrance", () => {
  it("ships the exact offline catalog, tokens and four locales without scripts or a search input", () => {
    const html = buildWorkspaceStartPage(pathToFileURL(`${process.cwd()}/`));
    expect(readFileSync(`${process.cwd()}/src/shared/generated/workspace-start.html`, "utf8")).toBe(html);
    const page = new DOMParser().parseFromString(html, "text/html");
    expect(page.querySelector("script,input,iframe")).toBeNull();
    expect([...page.querySelectorAll("a")].map((card) => [card.dataset.workspaceStartSite, card.getAttribute("href")]))
      .toEqual(catalog.map((site) => [site.id, site.startUrl]));
    expect([...page.images].every((image) => image.src.startsWith("data:image/"))).toBe(true);
    for (const language of ["en", "zh-TW", "zh-CN", "ja"]) {
      expect(page.querySelector(`h1 [data-language="${language}"]`)?.textContent).toBeTruthy();
    }
  });

  it.each(["macos", "windows"])("distinguishes configured and internal URLs on %s", (platform) => {
    const nativeUrl = platform === "windows" ? "http://rion-start.home/" : WORKSPACE_START_URL;
    expect(workspaceWebLaunchUrl(" ")).toBe(WORKSPACE_START_URL);
    expect(workspaceWebLaunchUrl("https://example.test/")).toBe("https://example.test/");
    expect(isWorkspaceStartUrl(nativeUrl)).toBe(platform === "macos");
    expect(isWorkspaceStartUrl(`${WORKSPACE_START_URL}?injected=1`)).toBe(false);
    const identity = { surfaceId: "web-1", generation: 1 };
    expect(parseWorkspaceWebChromeState({ ...identity, url: WORKSPACE_START_URL, canGoBack: false, canGoForward: false })).not.toBeNull();
    expect(parseWorkspaceWebChromeAction({ ...identity, type: "navigate", url: WORKSPACE_START_URL })).toBeNull();
    expect(resolveWorkspaceWebAddress(WORKSPACE_START_URL)).toBeNull();
  });

  it("keeps the internal address blank on focus, blur and Escape while following real navigation", () => {
    document.body.innerHTML = '<form><input></form>';
    const input = document.querySelector("input")!;
    const apply = installWorkspaceWebAddress(input, document.querySelector("form")!, () => undefined);
    apply(WORKSPACE_START_URL);
    expect(input.value).toBe("");
    input.focus();
    expect(input.value).toBe("");
    input.value = "unsent";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(input.value).toBe("");
    apply("https://www.youtube.com/");
    expect(input.value).toBe("youtube.com/");
    apply(WORKSPACE_START_URL);
    expect(input.value).toBe("");
  });
});
