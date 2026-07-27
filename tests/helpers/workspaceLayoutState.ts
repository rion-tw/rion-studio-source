import type { NormalizedRect } from "../../src/shared/types";

type AdaptiveZoomPercent = 25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125;

const thresholds: ReadonlyArray<[number, AdaptiveZoomPercent]> = [
  [0, 25], [372, 33], [532, 50], [749, 67], [909, 75],
  [992, 80], [1_088, 90], [1_216, 100], [1_344, 110], [1_504, 125]
];

export function resolveTestAdaptiveZoom(
  viewportWidth: number,
  currentPercent?: AdaptiveZoomPercent
): AdaptiveZoomPercent {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return currentPercent ?? 100;
  let targetIndex = 0;
  for (let index = thresholds.length - 1; index >= 0; index -= 1) {
    if (viewportWidth >= thresholds[index][0]) {
      targetIndex = index;
      break;
    }
  }
  if (currentPercent === undefined) return thresholds[targetIndex][1];
  const currentIndex = thresholds.findIndex(([, percent]) => percent === currentPercent);
  if (currentIndex < 0 || currentIndex === targetIndex) return thresholds[targetIndex][1];
  if (targetIndex > currentIndex) {
    const next = thresholds[currentIndex + 1]?.[0];
    if (next !== undefined && viewportWidth < next + 12) return currentPercent;
  } else if (viewportWidth >= thresholds[currentIndex][0] - 12) {
    return currentPercent;
  }
  return thresholds[targetIndex][1];
}

export function normalizeTestWorkspaceRects(rects: NormalizedRect[]): NormalizedRect[] {
  const edges = rects.map((rect) => [rect.x, rect.x + rect.width, rect.y, rect.y + rect.height]);
  const parents = Array.from({ length: edges.length * 4 }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const parent = parents[index];
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const touches = (left: number, right: number) => Math.abs(left - right) <= 0.000_1 + Number.EPSILON;
  edges.forEach((left, leftIndex) => {
    edges.slice(leftIndex + 1).forEach((right, offset) => {
      const rightIndex = leftIndex + offset + 1;
      if (Math.min(left[3], right[3]) - Math.max(left[2], right[2]) > 0) {
        if (touches(left[1], right[0])) union(leftIndex * 4 + 1, rightIndex * 4);
        if (touches(right[1], left[0])) union(rightIndex * 4 + 1, leftIndex * 4);
      }
      if (Math.min(left[1], right[1]) - Math.max(left[0], right[0]) > 0) {
        if (touches(left[3], right[2])) union(leftIndex * 4 + 3, rightIndex * 4 + 2);
        if (touches(right[3], left[2])) union(rightIndex * 4 + 3, leftIndex * 4 + 2);
      }
    });
  });
  const values = edges.flat().map((value) => Math.round(value * 10_000));
  const groups = new Map<number, number[]>();
  values.forEach((_value, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), index]));
  groups.forEach((group) => {
    if (group.length < 2) return;
    const preferred = group.filter((index) => index % 4 === 0 || index % 4 === 2);
    const candidates = preferred.length > 0 ? preferred : group;
    const value = Math.round(candidates.reduce((sum, index) => sum + values[index], 0) / candidates.length);
    group.forEach((index) => { values[index] = value; });
  });
  return rects.map((_rect, index) => {
    const offset = index * 4;
    return {
      x: values[offset] / 10_000,
      y: values[offset + 2] / 10_000,
      width: (values[offset + 1] - values[offset]) / 10_000,
      height: (values[offset + 3] - values[offset + 2]) / 10_000
    };
  });
}
