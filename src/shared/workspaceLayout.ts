import type {
  LaunchWorkspaceSlot,
  NormalizedRect,
  WorkspaceBrowserZoomPercent,
  WorkspaceLayoutTemplate,
  WorkspaceResourcePolicy
} from "./types";

export const MAX_WORKSPACE_SLOTS = 8;
export const MIN_WORKSPACE_SLOT_SIZE = 0.12;
export const DEFAULT_WORKSPACE_TEMPLATE: WorkspaceLayoutTemplate = "two_columns";
export const DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT: WorkspaceBrowserZoomPercent = 100;
export const DEFAULT_WORKSPACE_RESOURCE_POLICY: WorkspaceResourcePolicy = {
  mode: "unrestricted",
  backgroundCpuThrottleRate: 2
};
export const workspaceBrowserZoomPercents: WorkspaceBrowserZoomPercent[] = [75, 80, 90, 100, 110, 125];

const WORKSPACE_RECT_PRECISION_SCALE = 10_000;
const WORKSPACE_RECT_EDGE_TOLERANCE = 0.0001;

interface WorkspaceRectEdges {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

type WorkspaceRectEdgeSide = "bottom" | "left" | "right" | "top";

interface WorkspaceRectEdgeReference {
  rectIndex: number;
  side: WorkspaceRectEdgeSide;
}

export const workspaceLayoutTemplates: WorkspaceLayoutTemplate[] = [
  "two_columns",
  "three_columns",
  "main_left_stack_right",
  "main_right_stack_left",
  "main_center_side_stacks",
  "three_top_two_bottom",
  "two_top_three_bottom",
  "quad",
  "four_columns",
  "six_grid",
  "eight_grid"
];

const readableWorkspaceLayoutTemplates: WorkspaceLayoutTemplate[] = ["single", ...workspaceLayoutTemplates];

export function getDefaultWorkspaceBrowserZoomPercent(
  template: WorkspaceLayoutTemplate
): WorkspaceBrowserZoomPercent {
  if (template === "eight_grid") {
    return 75;
  }

  if (
    template === "six_grid" ||
    template === "main_center_side_stacks" ||
    template === "three_top_two_bottom" ||
    template === "two_top_three_bottom"
  ) {
    return 80;
  }

  return template === "three_columns" || template === "quad" || template === "four_columns" ? 90 : 100;
}

export function isWorkspaceBrowserZoomPercent(value: unknown): value is WorkspaceBrowserZoomPercent {
  return (
    typeof value === "number" &&
    workspaceBrowserZoomPercents.includes(value as WorkspaceBrowserZoomPercent)
  );
}

export function getWorkspaceTemplateSlotCount(template: WorkspaceLayoutTemplate): number {
  switch (template) {
    case "single":
      return 1;
    case "two_columns":
      return 2;
    case "three_columns":
    case "main_left_stack_right":
    case "main_right_stack_left":
      return 3;
    case "quad":
    case "four_columns":
      return 4;
    case "main_center_side_stacks":
    case "three_top_two_bottom":
    case "two_top_three_bottom":
      return 5;
    case "six_grid":
      return 6;
    case "eight_grid":
      return 8;
  }
}

export function getDefaultWorkspaceRects(template: WorkspaceLayoutTemplate): NormalizedRect[] {
  switch (template) {
    case "single":
      return [{ x: 0, y: 0, width: 1, height: 1 }];
    case "two_columns":
      return [
        { x: 0, y: 0, width: 0.5, height: 1 },
        { x: 0.5, y: 0, width: 0.5, height: 1 }
      ];
    case "three_columns":
      return createEqualColumnRects(3);
    case "main_left_stack_right":
      return [
        { x: 0, y: 0, width: 0.5, height: 1 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "main_right_stack_left":
      return [
        { x: 0.5, y: 0, width: 0.5, height: 1 },
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "main_center_side_stacks":
      return [
        { x: 0.3, y: 0, width: 0.4, height: 1 },
        { x: 0, y: 0, width: 0.3, height: 0.5 },
        { x: 0, y: 0.5, width: 0.3, height: 0.5 },
        { x: 0.7, y: 0, width: 0.3, height: 0.5 },
        { x: 0.7, y: 0.5, width: 0.3, height: 0.5 }
      ];
    case "three_top_two_bottom":
      return createSplitRowRects(3, 2);
    case "two_top_three_bottom":
      return createSplitRowRects(2, 3);
    case "quad":
      return [
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "four_columns":
      return createEqualColumnRects(4);
    case "six_grid":
      return createGridRects(3, 2);
    case "eight_grid":
      return createGridRects(4, 2);
  }
}

export function normalizeWorkspaceRectEdges(rects: NormalizedRect[]): NormalizedRect[] {
  const edges = rects.map(toWorkspaceRectEdges);
  const references = edges.flatMap((_rect, rectIndex): WorkspaceRectEdgeReference[] => [
    { rectIndex, side: "left" },
    { rectIndex, side: "right" },
    { rectIndex, side: "top" },
    { rectIndex, side: "bottom" }
  ]);
  const parents = references.map((_reference, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) {
      root = parents[root];
    }
    while (parents[index] !== index) {
      const parent = parents[index];
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const union = (leftIndex: number, rightIndex: number): void => {
    const leftRoot = find(leftIndex);
    const rightRoot = find(rightIndex);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };
  const referenceIndex = (rectIndex: number, side: WorkspaceRectEdgeSide): number =>
    rectIndex * 4 + workspaceRectEdgeSideIndex(side);

  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex += 1) {
      const left = edges[leftIndex];
      const right = edges[rightIndex];
      const verticalOverlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      const horizontalOverlap = Math.min(left.right, right.right) - Math.max(left.left, right.left);

      if (verticalOverlap > 0) {
        if (workspaceRectEdgesTouch(left.right, right.left)) {
          union(referenceIndex(leftIndex, "right"), referenceIndex(rightIndex, "left"));
        }
        if (workspaceRectEdgesTouch(right.right, left.left)) {
          union(referenceIndex(rightIndex, "right"), referenceIndex(leftIndex, "left"));
        }
      }

      if (horizontalOverlap > 0) {
        if (workspaceRectEdgesTouch(left.bottom, right.top)) {
          union(referenceIndex(leftIndex, "bottom"), referenceIndex(rightIndex, "top"));
        }
        if (workspaceRectEdgesTouch(right.bottom, left.top)) {
          union(referenceIndex(rightIndex, "bottom"), referenceIndex(leftIndex, "top"));
        }
      }
    }
  }

  const groupedReferenceIndexes = new Map<number, number[]>();
  references.forEach((_reference, index) => {
    const root = find(index);
    const group = groupedReferenceIndexes.get(root) ?? [];
    group.push(index);
    groupedReferenceIndexes.set(root, group);
  });
  const normalizedValues = references.map((reference) =>
    toWorkspaceRectPrecisionUnits(edges[reference.rectIndex][reference.side])
  );

  groupedReferenceIndexes.forEach((group) => {
    if (group.length < 2) {
      return;
    }

    const preferred = group.filter((index) => {
      const side = references[index].side;
      return side === "left" || side === "top";
    });
    const candidates = preferred.length > 0 ? preferred : group;
    const value = Math.round(
      candidates.reduce((sum, index) => sum + normalizedValues[index], 0) / candidates.length
    );
    group.forEach((index) => {
      normalizedValues[index] = value;
    });
  });

  return edges.map((_rect, rectIndex) => {
    const left = normalizedValues[referenceIndex(rectIndex, "left")];
    const right = normalizedValues[referenceIndex(rectIndex, "right")];
    const top = normalizedValues[referenceIndex(rectIndex, "top")];
    const bottom = normalizedValues[referenceIndex(rectIndex, "bottom")];

    return {
      x: fromWorkspaceRectPrecisionUnits(left),
      y: fromWorkspaceRectPrecisionUnits(top),
      width: fromWorkspaceRectPrecisionUnits(right - left),
      height: fromWorkspaceRectPrecisionUnits(bottom - top)
    };
  });
}

function toWorkspaceRectEdges(rect: NormalizedRect): WorkspaceRectEdges {
  return {
    left: rect.x,
    right: rect.x + rect.width,
    top: rect.y,
    bottom: rect.y + rect.height
  };
}

function workspaceRectEdgeSideIndex(side: WorkspaceRectEdgeSide): number {
  switch (side) {
    case "left":
      return 0;
    case "right":
      return 1;
    case "top":
      return 2;
    case "bottom":
      return 3;
  }
}

function workspaceRectEdgesTouch(left: number, right: number): boolean {
  return Math.abs(left - right) <= WORKSPACE_RECT_EDGE_TOLERANCE + Number.EPSILON;
}

function toWorkspaceRectPrecisionUnits(value: number): number {
  return Math.round(value * WORKSPACE_RECT_PRECISION_SCALE);
}

function fromWorkspaceRectPrecisionUnits(value: number): number {
  return value / WORKSPACE_RECT_PRECISION_SCALE;
}

function createGridRects(columnCount: number, rowCount: number): NormalizedRect[] {
  return Array.from({ length: columnCount * rowCount }, (_value, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);

    return {
      x: column / columnCount,
      y: row / rowCount,
      width: 1 / columnCount,
      height: 1 / rowCount
    };
  });
}

function createSplitRowRects(topColumnCount: number, bottomColumnCount: number): NormalizedRect[] {
  return [
    ...createEqualColumnRects(topColumnCount).map((rect) => ({ ...rect, height: 0.5 })),
    ...createEqualColumnRects(bottomColumnCount).map((rect) => ({ ...rect, y: 0.5, height: 0.5 }))
  ];
}

function createEqualColumnRects(columnCount: number): NormalizedRect[] {
  return Array.from({ length: columnCount }, (_value, index) => ({
    x: index / columnCount,
    y: 0,
    width: 1 / columnCount,
    height: 1
  }));
}

export function createDefaultWorkspaceSlots(template: WorkspaceLayoutTemplate): LaunchWorkspaceSlot[] {
  return getDefaultWorkspaceRects(template).map((rect, index) => ({
    id: `slot-${index + 1}`,
    rect
  }));
}

export function isWorkspaceLayoutTemplate(value: unknown): value is WorkspaceLayoutTemplate {
  return typeof value === "string" && readableWorkspaceLayoutTemplates.includes(value as WorkspaceLayoutTemplate);
}
