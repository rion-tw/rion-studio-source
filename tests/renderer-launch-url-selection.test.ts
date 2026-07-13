import { describe, expect, it } from "vitest";

import {
  CUSTOM_LAUNCH_URL_OPTION,
  resolveLaunchUrlFromSelection,
  resolveLaunchUrlSelection
} from "../src/renderer/src/app/launchUrlSelection";

const presetUrls = ["https://universe.flyff.com/play", "https://ffcli.ruiwoo.cn"];

describe("renderer launch URL selection helpers", () => {
  it("selects a matching preset URL", () => {
    expect(resolveLaunchUrlSelection(presetUrls[0], presetUrls)).toBe(presetUrls[0]);
  });

  it("selects custom for an existing non-preset URL", () => {
    expect(resolveLaunchUrlSelection("https://example.test/play", presetUrls)).toBe(
      CUSTOM_LAUNCH_URL_OPTION
    );
  });

  it("clears the URL when custom is newly selected", () => {
    expect(resolveLaunchUrlFromSelection(CUSTOM_LAUNCH_URL_OPTION)).toBe("");
  });

  it("uses the selected preset URL when switching away from custom", () => {
    expect(resolveLaunchUrlFromSelection(presetUrls[1])).toBe(presetUrls[1]);
  });
});
