import { expect } from "@wdio/globals";

import type { DesktopE2eWindowSnapshot, WindowBounds } from "./control";

const LOGICAL_PIXEL_TOLERANCE = 1;

export function expectBoundsNear(
  actual: WindowBounds,
  expected: Required<WindowBounds>,
  tolerance = LOGICAL_PIXEL_TOLERANCE
): void {
  expect(actual.x).toBeGreaterThanOrEqual(expected.x - tolerance);
  expect(actual.x).toBeLessThanOrEqual(expected.x + tolerance);
  expect(actual.y).toBeGreaterThanOrEqual(expected.y - tolerance);
  expect(actual.y).toBeLessThanOrEqual(expected.y + tolerance);
  expect(actual.width).toBeGreaterThanOrEqual(expected.width - tolerance);
  expect(actual.width).toBeLessThanOrEqual(expected.width + tolerance);
  expect(actual.height).toBeGreaterThanOrEqual(expected.height - tolerance);
  expect(actual.height).toBeLessThanOrEqual(expected.height + tolerance);
}

export function expectPlacement(
  snapshot: DesktopE2eWindowSnapshot,
  bounds: Required<WindowBounds>,
  presentation: "fullscreen" | "maximized" | "normal"
): void {
  const placement = snapshot.kernel?.placement;
  if (!placement) throw new Error(`Kernel placement is unavailable for ${snapshot.windowId}`);
  expect(snapshot.kernel?.placement?.presentation).toBe(presentation);
  expect(snapshot.target.presentation).toBe(presentation);
  expect(snapshot.native.presentation).toBe(presentation);
  expectBoundsNear(placement.normalBounds, bounds);
  expectBoundsNear(snapshot.target.bounds, bounds);
  if (presentation === "normal") {
    expectBoundsNear({
      height: snapshot.native.clientBounds.height,
      width: snapshot.native.clientBounds.width,
      x: snapshot.native.outerBounds.x,
      y: snapshot.native.outerBounds.y
    }, bounds);
  }
}

export function expectTabStripFitsClient(snapshot: DesktopE2eWindowSnapshot): void {
  if (process.platform !== "win32") return;
  const bounds = snapshot.native.tabStripBounds;
  const hostBounds = snapshot.native.tabStripHostBounds;
  if (!bounds) throw new Error(`Tab-strip bounds are unavailable for ${snapshot.windowId}`);
  if (!hostBounds) throw new Error(`Tab-strip host bounds are unavailable for ${snapshot.windowId}`);
  if (bounds.y === undefined || bounds.height === undefined) {
    throw new Error(`Tab-strip geometry is incomplete for ${snapshot.windowId}`);
  }
  expect(bounds.x).toBeGreaterThanOrEqual(-LOGICAL_PIXEL_TOLERANCE);
  expect(bounds.x).toBeLessThanOrEqual(LOGICAL_PIXEL_TOLERANCE);
  expect(bounds.y).toBeGreaterThanOrEqual(-LOGICAL_PIXEL_TOLERANCE);
  expect(bounds.y).toBeLessThanOrEqual(LOGICAL_PIXEL_TOLERANCE);
  expect(bounds.width).toBeGreaterThanOrEqual(
    snapshot.native.clientBounds.width - LOGICAL_PIXEL_TOLERANCE
  );
  expect(bounds.width).toBeLessThanOrEqual(
    snapshot.native.clientBounds.width + LOGICAL_PIXEL_TOLERANCE
  );
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.height).toBeLessThan(snapshot.native.clientBounds.height);
  expect(hostBounds.x).toBeGreaterThanOrEqual(-LOGICAL_PIXEL_TOLERANCE);
  expect(hostBounds.x).toBeLessThanOrEqual(LOGICAL_PIXEL_TOLERANCE);
  expect(hostBounds.y).toBeGreaterThanOrEqual(-LOGICAL_PIXEL_TOLERANCE);
  expect(hostBounds.y).toBeLessThanOrEqual(LOGICAL_PIXEL_TOLERANCE);
  expect(hostBounds.width).toBeGreaterThanOrEqual(
    snapshot.native.clientBounds.width - LOGICAL_PIXEL_TOLERANCE
  );
  expect(hostBounds.width).toBeLessThanOrEqual(
    snapshot.native.clientBounds.width + LOGICAL_PIXEL_TOLERANCE
  );
  expect(hostBounds.height).toBeGreaterThanOrEqual(
    bounds.y + bounds.height - LOGICAL_PIXEL_TOLERANCE
  );
  expect(hostBounds.height).toBeLessThanOrEqual(snapshot.native.clientBounds.height);
}
