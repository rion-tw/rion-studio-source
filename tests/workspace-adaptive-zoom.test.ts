import { describe, expect, it } from "vitest";

import { getAdaptiveWorkspaceBrowserZoomPercent } from "../src/shared/workspaceLayout";

describe("adaptive workspace browser zoom", () => {
  it.each([
    [1, 25],
    [371, 25],
    [372, 33],
    [531, 33],
    [532, 50],
    [748, 50],
    [749, 67],
    [908, 67],
    [909, 75],
    [991, 75],
    [992, 80],
    [1_087, 80],
    [1_088, 90],
    [1_215, 90],
    [1_216, 100],
    [1_278, 100],
    [1_343, 100],
    [1_344, 110],
    [1_503, 110],
    [1_504, 125],
    [2_560, 125]
  ] as const)("maps %s DIP to %s percent", (width, expected) => {
    expect(getAdaptiveWorkspaceBrowserZoomPercent(width)).toBe(expected);
  });

  it("keeps the current zoom within the 12 DIP hysteresis band", () => {
    expect(getAdaptiveWorkspaceBrowserZoomPercent(372, 25)).toBe(25);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(383, 25)).toBe(25);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(384, 25)).toBe(33);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(371, 33)).toBe(33);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(360, 33)).toBe(33);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(359, 33)).toBe(25);
  });

  it("uses a safe fallback for invalid widths", () => {
    expect(getAdaptiveWorkspaceBrowserZoomPercent(Number.NaN)).toBe(100);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(0, 67)).toBe(67);
  });
});
