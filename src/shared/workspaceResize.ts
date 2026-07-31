import type { NormalizedRect } from "./types";

const WORKSPACE_RESIZE_SNAP_STEP = 0.05;

const WORKSPACE_RESIZE_COMMON_POSITIONS = [1 / 3, 1 / 2, 2 / 3] as const;
const WORKSPACE_RESIZE_EPSILON = 0.000_001;
const WORKSPACE_RESIZE_SWITCH_TOLERANCE = 0.001;

interface WorkspaceResizeSnapOptions {
  initialPosition: number;
  max: number;
  min: number;
  previousPosition?: number;
}

type WorkspaceResizeIndicatorPayload =
  | { type: "hide" }
  | { label: string; type: "show" | "update" };

export function snapWorkspaceResizePosition(
  requestedPosition: number,
  options: WorkspaceResizeSnapOptions
): number {
  const min = Math.min(options.min, options.max);
  const max = Math.max(options.min, options.max);
  const requested = clampWorkspaceResizePosition(requestedPosition, min, max);
  const candidates = createWorkspaceResizeSnapCandidates(min, max, options.initialPosition);
  let closest = candidates[0] ?? requested;

  candidates.slice(1).forEach((candidate) => {
    const candidateDistance = Math.abs(requested - candidate);
    const closestDistance = Math.abs(requested - closest);

    if (candidateDistance < closestDistance - WORKSPACE_RESIZE_EPSILON) {
      closest = candidate;
    }
  });

  const previous = options.previousPosition;
  if (
    previous !== undefined &&
    previous >= min - WORKSPACE_RESIZE_EPSILON &&
    previous <= max + WORKSPACE_RESIZE_EPSILON
  ) {
    const previousCandidate = candidates.find(
      (candidate) => Math.abs(candidate - previous) < WORKSPACE_RESIZE_EPSILON
    );

    if (previousCandidate !== undefined) {
      const previousDistance = Math.abs(requested - previousCandidate);
      const closestDistance = Math.abs(requested - closest);

      if (previousDistance <= closestDistance + WORKSPACE_RESIZE_SWITCH_TOLERANCE) {
        return previousCandidate;
      }
    }
  }

  return closest;
}

export function formatWorkspaceResizeRatio(rect: Pick<NormalizedRect, "height" | "width">): string {
  return `${formatWorkspaceResizePercent(rect.width)} × ${formatWorkspaceResizePercent(rect.height)}`;
}

export function formatWorkspaceResizePercent(value: number): string {
  const percent = Math.round(value * 1_000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export function isWorkspaceResizeIndicatorPayload(value: unknown): value is WorkspaceResizeIndicatorPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Partial<WorkspaceResizeIndicatorPayload>;
  if (payload.type === "hide") {
    return true;
  }

  return (
    (payload.type === "show" || payload.type === "update") &&
    typeof payload.label === "string" &&
    payload.label.length > 0 &&
    payload.label.length <= 40
  );
}

function createWorkspaceResizeSnapCandidates(min: number, max: number, initialPosition: number): number[] {
  const candidates = new Set<number>();
  const addCandidate = (candidate: number, round = false): void => {
    if (candidate >= min - WORKSPACE_RESIZE_EPSILON && candidate <= max + WORKSPACE_RESIZE_EPSILON) {
      const clamped = clampWorkspaceResizePosition(candidate, min, max);
      candidates.add(round ? roundWorkspaceResizePosition(clamped) : clamped);
    }
  };

  addCandidate(min);
  addCandidate(max);
  addCandidate(initialPosition);
  WORKSPACE_RESIZE_COMMON_POSITIONS.forEach((candidate) => addCandidate(candidate));

  const firstStep = Math.ceil((min - WORKSPACE_RESIZE_EPSILON) / WORKSPACE_RESIZE_SNAP_STEP);
  const lastStep = Math.floor((max + WORKSPACE_RESIZE_EPSILON) / WORKSPACE_RESIZE_SNAP_STEP);
  for (let stepIndex = firstStep; stepIndex <= lastStep; stepIndex += 1) {
    addCandidate(stepIndex * WORKSPACE_RESIZE_SNAP_STEP, true);
  }

  return [...candidates].sort((left, right) => left - right);
}

function clampWorkspaceResizePosition(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundWorkspaceResizePosition(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
