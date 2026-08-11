import { getViewportForBounds, type Viewport } from "@xyflow/react";

import type { MacroMindMapBounds } from "./macroMindMapModel";

export const MACRO_MIND_MAP_MIN_READABLE_ZOOM = 0.75;
export const MACRO_MIND_MAP_MAX_AUTO_ZOOM = 1;

const HORIZONTAL_PADDING = 32;
const VERTICAL_PADDING = 24;
const MIN_CANVAS_HEIGHT = 240;
const MIN_CANVAS_WIDTH = 320;

export interface MacroMindMapViewportPlan {
  height: number;
  horizontalOverflow: boolean;
  viewport: Viewport;
  zoom: number;
}

export function calculateMacroMindMapViewport(
  bounds: MacroMindMapBounds,
  containerWidth: number
): MacroMindMapViewportPlan {
  const width = Math.max(MIN_CANVAS_WIDTH, Math.floor(containerWidth));
  const usableWidth = Math.max(1, width - HORIZONTAL_PADDING * 2);
  const widthFitZoom = usableWidth / Math.max(1, bounds.width);
  const zoom = Math.min(
    MACRO_MIND_MAP_MAX_AUTO_ZOOM,
    Math.max(MACRO_MIND_MAP_MIN_READABLE_ZOOM, widthFitZoom)
  );
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    Math.ceil(bounds.height * zoom + VERTICAL_PADDING * 2)
  );
  const viewport = getViewportForBounds(
    bounds,
    width,
    height,
    zoom,
    zoom,
    { x: HORIZONTAL_PADDING, y: VERTICAL_PADDING }
  );

  return {
    height,
    horizontalOverflow: bounds.width * zoom + HORIZONTAL_PADDING * 2 > width,
    viewport,
    zoom
  };
}
