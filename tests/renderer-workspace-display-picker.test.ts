import { describe, expect, it } from "vitest";

import {
  formatWorkspaceDisplayLabel,
  getFirstAvailableWorkspaceDisplayId,
  hasAvailableWorkspaceDisplay
} from "../src/renderer/src/features/workspaces/workspaceDisplayUtils";
import type { Translator } from "../src/renderer/src/i18n";
import type { WorkspaceDisplayLaunchOption } from "../src/shared/types";

const t = ((key: string) => {
  const translations: Record<string, string> = {
    "workspaces.displayFallback": "Display {index}",
    "workspaces.displayPrimary": "Primary",
    "workspaces.displayInternal": "Built-in"
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
});

function display(id: number, label: string): WorkspaceDisplayLaunchOption {
  return {
    id,
    label,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    isPrimary: id === 11,
    isInternal: id === 11
  };
}
