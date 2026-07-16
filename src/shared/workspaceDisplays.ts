import type {
  WorkspaceDisplayFingerprint,
  WorkspaceDisplayInfo,
  WorkspaceDisplayTarget
} from "./types";

export function createWorkspaceDisplayFingerprint(
  display: WorkspaceDisplayInfo
): WorkspaceDisplayFingerprint {
  return {
    label: display.label,
    bounds: { ...display.bounds },
    resolution: { ...display.resolution },
    scaleFactor: display.scaleFactor,
    isPrimary: display.isPrimary,
    isInternal: display.isInternal
  };
}

export function createWorkspaceDisplayTarget(
  display: WorkspaceDisplayInfo
): WorkspaceDisplayTarget {
  return {
    id: display.id,
    fingerprint: createWorkspaceDisplayFingerprint(display)
  };
}

export function cloneWorkspaceDisplayTarget(
  target: WorkspaceDisplayTarget
): WorkspaceDisplayTarget {
  return {
    id: target.id,
    ...(target.fingerprint
      ? {
          fingerprint: {
            ...target.fingerprint,
            bounds: { ...target.fingerprint.bounds },
            resolution: { ...target.fingerprint.resolution }
          }
        }
      : {})
  };
}

export function resolveWorkspaceDisplayTarget(
  target: WorkspaceDisplayTarget | undefined,
  displays: WorkspaceDisplayInfo[]
): WorkspaceDisplayInfo | undefined {
  if (!target) {
    return undefined;
  }

  const fingerprint = target.fingerprint;
  if (!fingerprint) {
    return displays.find((display) => display.id === target.id);
  }

  const matches = displays.filter((display) =>
    workspaceDisplayMatchesFingerprint(display, fingerprint)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function workspaceDisplayMatchesFingerprint(
  display: WorkspaceDisplayInfo,
  fingerprint: WorkspaceDisplayFingerprint
): boolean {
  return (
    display.label === fingerprint.label &&
    display.bounds.x === fingerprint.bounds.x &&
    display.bounds.y === fingerprint.bounds.y &&
    display.bounds.width === fingerprint.bounds.width &&
    display.bounds.height === fingerprint.bounds.height &&
    display.resolution.width === fingerprint.resolution.width &&
    display.resolution.height === fingerprint.resolution.height &&
    display.scaleFactor === fingerprint.scaleFactor &&
    display.isPrimary === fingerprint.isPrimary &&
    display.isInternal === fingerprint.isInternal
  );
}
