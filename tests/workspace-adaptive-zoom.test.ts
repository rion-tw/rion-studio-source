import { describe, expect, it } from "vitest";

import { getAdaptiveWorkspaceBrowserZoomPercent } from "../src/shared/workspaceLayout";

describe("adaptive workspace browser zoom", () => {
  it.each([
    [1, 25],
    [231, 25],
    [232, 33],
    [331, 33],
    [332, 50],
    [467, 50],
    [468, 67],
    [567, 67],
    [568, 75],
    [619, 75],
    [620, 80],
    [679, 80],
    [680, 90],
    [759, 90],
    [760, 100],
    [839, 100],
    [840, 110],
    [939, 110],
    [940, 125],
    [1600, 125]
  ] as const)("maps %s DIP to %s percent", (width, expected) => {
    expect(getAdaptiveWorkspaceBrowserZoomPercent(width)).toBe(expected);
  });

  it("keeps the current zoom within the 12 DIP hysteresis band", () => {
    expect(getAdaptiveWorkspaceBrowserZoomPercent(232, 25)).toBe(25);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(243, 25)).toBe(25);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(244, 25)).toBe(33);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(231, 33)).toBe(33);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(220, 33)).toBe(33);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(219, 33)).toBe(25);
  });

  it("uses a safe fallback for invalid widths", () => {
    expect(getAdaptiveWorkspaceBrowserZoomPercent(Number.NaN)).toBe(100);
    expect(getAdaptiveWorkspaceBrowserZoomPercent(0, 67)).toBe(67);
  });
});
