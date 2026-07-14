import { describe, expect, it } from "vitest";

import {
  formatWorkspaceDisplayLabel,
  getFirstAvailableWorkspaceDisplayId,
  getWorkspaceTargetDisplayPresentation,
  hasAvailableWorkspaceDisplay
} from "../src/renderer/src/features/workspaces/workspaceDisplayUtils";
import type { Translator } from "../src/renderer/src/i18n";
import type { WorkspaceDisplayLaunchOption } from "../src/shared/types";

const t = ((key: string) => {
  const translations: Record<string, string> = {
    "workspaces.displayFallback": "Display {index}",
    "workspaces.displayPrimary": "Primary",
    "workspaces.displayInternal": "Built-in",
    "workspaces.targetDisplay": "Target display",
    "workspaces.targetDisplayFollowApp": "Follow Rion Studio",
    "workspaces.targetDisplayUnavailable": "Unavailable display (ID {id})"
  };
  return translations[key] ?? key;
}) as Translator;

describe("workspace display picker helpers", () => {
  it("formats fallback names, resolution, and display badges", () => {
    expect(formatWorkspaceDisplayLabel(display(11, ""), 0, t)).toBe(
      "Display 1 · 1920×1080 · Primary · Built-in"
    );
  });

  it("selects only free displays and reports a cancel-only state when all are occupied", () => {
    const occupied = {
      ...display(11, "Built-in"),
      occupiedByWorkspace: { id: "workspace-2", name: "Raid" }
    };
    expect(getFirstAvailableWorkspaceDisplayId([occupied, display(22, "Side")])).toBe(22);
    expect(hasAvailableWorkspaceDisplay([occupied])).toBe(false);
    expect(getFirstAvailableWorkspaceDisplayId([occupied])).toBeNull();
  });

  it("describes a workspace that follows the app display", () => {
    expect(getWorkspaceTargetDisplayPresentation(undefined, [], t)).toEqual({
      isUnavailable: false,
      label: "Follow Rion Studio",
      title: "Target display: Follow Rion Studio"
    });
  });

  it("uses the connected display name and includes its full details in the title", () => {
    expect(getWorkspaceTargetDisplayPresentation(11, [display(11, "Built-in Retina Display")], t)).toEqual({
      isUnavailable: false,
      label: "Built-in Retina Display",
      title: "Target display: Built-in Retina Display · 1920×1080 · Primary · Built-in"
    });
  });

  it("uses a positional fallback for a connected display without a name", () => {
    expect(getWorkspaceTargetDisplayPresentation(22, [display(11, "Built-in"), display(22, "")], t)).toEqual({
      isUnavailable: false,
      label: "Display 2",
      title: "Target display: Display 2 · 1920×1080"
    });
  });

  it("marks a saved display that is no longer connected as unavailable", () => {
    expect(getWorkspaceTargetDisplayPresentation(42, [display(11, "Built-in")], t)).toEqual({
      isUnavailable: true,
      label: "Unavailable display (ID 42)",
      title: "Target display: Unavailable display (ID 42)"
    });
  });
});

function display(id: number, label: string): WorkspaceDisplayLaunchOption {
  return {
    id,
    label,
    bounds: { x: 0, y: 0, width: 1536, height: 864 },
    workArea: { x: 0, y: 0, width: 1536, height: 832 },
    resolution: { width: 1920, height: 1080 },
    scaleFactor: 1.25,
    isPrimary: id === 11,
    isInternal: id === 11
  };
}
