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
    bounds.width - LOGICAL_PIXEL_TOLERANCE
  );
  expect(hostBounds.width).toBeLessThanOrEqual(
    bounds.width + LOGICAL_PIXEL_TOLERANCE
  );
  expect(hostBounds.height).toBeGreaterThanOrEqual(
    bounds.height - LOGICAL_PIXEL_TOLERANCE
  );
  expect(hostBounds.height).toBeLessThanOrEqual(
    bounds.height + LOGICAL_PIXEL_TOLERANCE
  );
}

export function expectSingleRoleSurfaceFitsClient(
  snapshot: DesktopE2eWindowSnapshot,
  roleId: string
): void {
  if (process.platform !== "win32") return;
  const surface = snapshot.native.roleSurfaces?.find((candidate) => candidate.roleId === roleId);
  const tabStrip = snapshot.native.tabStripHostBounds ?? snapshot.native.tabStripBounds;
  if (!surface) throw new Error(`Role surface ${roleId} is unavailable for ${snapshot.windowId}`);
  if (!tabStrip || tabStrip.x === undefined || tabStrip.y === undefined) {
    throw new Error(`Tab-strip geometry is incomplete for ${snapshot.windowId}`);
  }
  if (surface.hostBounds.x === undefined || surface.hostBounds.y === undefined) {
    throw new Error(`Role host geometry is incomplete for ${roleId}`);
  }
  if (surface.controllerBounds.x === undefined || surface.controllerBounds.y === undefined) {
    throw new Error(`Role controller geometry is incomplete for ${roleId}`);
  }
  expectRoleSurfaceViewportFitsController(snapshot, roleId);
  const contentTop = tabStrip.y + tabStrip.height;
  const expectedHost = {
    height: snapshot.native.clientBounds.height - contentTop,
    width: snapshot.native.clientBounds.width,
    x: 0,
    y: contentTop
  };
  expectBoundsNear({
    ...surface.hostBounds,
    x: surface.hostBounds.x,
    y: surface.hostBounds.y
  }, expectedHost);
  expectBoundsNear({
    ...surface.controllerBounds,
    x: surface.controllerBounds.x,
    y: surface.controllerBounds.y
  }, {
    height: surface.hostBounds.height,
    width: surface.hostBounds.width,
    x: 0,
    y: 0
  });
}

export function expectRoleSurfaceViewportsFitControllers(
  snapshot: DesktopE2eWindowSnapshot
): void {
  if (process.platform !== "win32") return;
  const surfaces = snapshot.native.roleSurfaces ?? [];
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    expectRoleSurfaceViewportFitsController(snapshot, surface.roleId);
  }
}

function expectRoleSurfaceViewportFitsController(
  snapshot: DesktopE2eWindowSnapshot,
  roleId: string
): void {
  const surface = snapshot.native.roleSurfaces?.find((candidate) => candidate.roleId === roleId);
  if (!surface) throw new Error(`Role surface ${roleId} is unavailable for ${snapshot.windowId}`);
  if (!surface.documentViewport) {
    throw new Error(`Role document viewport ${roleId} is unavailable for ${snapshot.windowId}`);
  }
  expect(surface.controllerVisible).toBe(true);
  expect(surface.parentWindowMatchesHost).toBe(true);
  expect(surface.pageZoomFactor).toBeGreaterThan(0);
  const visualViewportWidth = surface.documentViewport.width * surface.pageZoomFactor;
  const visualViewportHeight = surface.documentViewport.height * surface.pageZoomFactor;
  expect(visualViewportWidth).toBeGreaterThanOrEqual(
    surface.controllerBounds.width - LOGICAL_PIXEL_TOLERANCE
  );
  expect(visualViewportWidth).toBeLessThanOrEqual(
    surface.controllerBounds.width + LOGICAL_PIXEL_TOLERANCE
  );
  expect(visualViewportHeight).toBeGreaterThanOrEqual(
    surface.controllerBounds.height - LOGICAL_PIXEL_TOLERANCE
  );
  expect(visualViewportHeight).toBeLessThanOrEqual(
    surface.controllerBounds.height + LOGICAL_PIXEL_TOLERANCE
  );
}

export function expectAppKitTabsFitTitlebar(snapshot: DesktopE2eWindowSnapshot): void {
  if (process.platform !== "darwin") return;
  const geometry = snapshot.native.appKitTitlebar;
  if (!geometry) {
    throw new Error(`AppKit titlebar geometry is unavailable for ${snapshot.windowId}`);
  }
  expect(geometry.titleHidden).toBe(true);
  expect(geometry.rootMinX).toBeGreaterThanOrEqual(-LOGICAL_PIXEL_TOLERANCE);
  expect(geometry.rootMinX).toBeLessThanOrEqual(LOGICAL_PIXEL_TOLERANCE);
  expect(geometry.rootWidth).toBeGreaterThan(0);
  expect(geometry.tabMinX).toBeGreaterThanOrEqual(
    geometry.trafficLightsMaxX - LOGICAL_PIXEL_TOLERANCE
  );
  expect(geometry.tabMinX).toBeGreaterThanOrEqual(
    geometry.windowNameMaxX - LOGICAL_PIXEL_TOLERANCE
  );
  expect(geometry.tabMinY).toBeGreaterThanOrEqual(-LOGICAL_PIXEL_TOLERANCE);
  expect(geometry.tabMaxY).toBeLessThanOrEqual(
    snapshot.native.outerBounds.height + LOGICAL_PIXEL_TOLERANCE
  );
  expect(geometry.tabMaxX).toBeLessThanOrEqual(
    geometry.rootMinX + geometry.rootWidth + LOGICAL_PIXEL_TOLERANCE
  );
}
