import { describe, expect, it } from "vitest";

import {
  formatWorkspaceResizePercent,
  formatWorkspaceResizeRatio,
  isWorkspaceResizeIndicatorPayload,
  snapWorkspaceResizePosition
} from "../src/shared/workspaceResize";

describe("workspace resize helpers", () => {
  it("snaps continuous pointer positions to five-percent intervals", () => {
    expect(
      snapWorkspaceResizePosition(0.574, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88
      })
    ).toBe(0.55);
    expect(
      snapWorkspaceResizePosition(0.586, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88
      })
    ).toBe(0.6);
  });

  it("preserves common thirds, custom starting positions, and legal edges", () => {
    expect(
      snapWorkspaceResizePosition(0.34, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88
      })
    ).toBeCloseTo(1 / 3);
    expect(
      snapWorkspaceResizePosition(0.621, {
        initialPosition: 0.62,
        min: 0.12,
        max: 0.88
      })
    ).toBe(0.62);
    expect(
      snapWorkspaceResizePosition(0, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88
      })
    ).toBe(0.12);
    expect(
      snapWorkspaceResizePosition(1, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88
      })
    ).toBe(0.88);
  });

  it("keeps the current detent at the midpoint and switches after crossing it", () => {
    expect(
      snapWorkspaceResizePosition(0.575, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88,
        previousPosition: 0.55
      })
    ).toBe(0.55);
    expect(
      snapWorkspaceResizePosition(0.577, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88,
        previousPosition: 0.55
      })
    ).toBe(0.6);
    expect(
      snapWorkspaceResizePosition(0.575, {
        initialPosition: 0.5,
        min: 0.12,
        max: 0.88,
        previousPosition: 0.6
      })
    ).toBe(0.6);
  });

  it("formats relative dimensions with at most one decimal place", () => {
    expect(formatWorkspaceResizePercent(1 / 3)).toBe("33.3%");
    expect(formatWorkspaceResizePercent(0.5)).toBe("50%");
    expect(formatWorkspaceResizeRatio({ width: 1 / 3, height: 0.5 })).toBe("33.3% × 50%");
  });

  it("validates internal indicator messages", () => {
    expect(isWorkspaceResizeIndicatorPayload({ type: "show", label: "50% × 100%" })).toBe(true);
    expect(isWorkspaceResizeIndicatorPayload({ type: "update", label: "55% × 100%" })).toBe(true);
    expect(isWorkspaceResizeIndicatorPayload({ type: "hide" })).toBe(true);
    expect(isWorkspaceResizeIndicatorPayload({ type: "show", label: "" })).toBe(false);
    expect(isWorkspaceResizeIndicatorPayload({ type: "update", label: 55 })).toBe(false);
  });
});
