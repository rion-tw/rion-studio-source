// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readStoredLanguage,
  resolvePreferredLanguage
} from "../src/renderer/src/i18n";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("preferred application language", () => {
  it.each([
    [["zh-TW", "ja-JP"], "zh-TW"],
    [["ja-JP", "zh-TW"], "ja"],
    [["fr-FR", "zh-HK"], "zh-TW"],
    [["zh-CN", "zh-TW"], "zh-CN"],
    [["fr-FR", "de-DE"], "en"]
  ])("uses the first supported locale from %j", (locales, expected) => {
    expect(resolvePreferredLanguage(locales)).toBe(expected);
  });

  it.each([
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh", "zh-CN"],
    ["ja-JP", "ja"]
  ])("maps %s to %s", (locale, expected) => {
    expect(resolvePreferredLanguage([locale])).toBe(expected);
  });

  it("prefers a valid stored language over the system languages", () => {
    localStorage.setItem("language", "ja");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-TW", "en-US"]);

    expect(readStoredLanguage("language")).toBe("ja");
  });

  it("falls back to the preferred system language for an invalid stored value", () => {
    localStorage.setItem("language", "fr");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-TW", "ja-JP"]);

    expect(readStoredLanguage("language")).toBe("zh-TW");
  });
});
