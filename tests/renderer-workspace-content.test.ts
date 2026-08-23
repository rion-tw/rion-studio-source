import { describe, expect, it } from "vitest";

import {
  formatWorkspaceContentSummary,
  projectWorkspaceContent
} from "../src/renderer/src/app/workspaceContent";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { LaunchWorkspaceSlot } from "../src/shared/types";

const t: Translator = (key) => en[key];

describe("workspace content projection", () => {
  it("projects role and Web App content with searchable names", () => {
    const slots: LaunchWorkspaceSlot[] = [
      { id: "role-slot", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      {
        id: "web-slot",
        web: { name: "Video room", startUrl: "https://example.test/watch" },
        rect: { x: 0.5, y: 0, width: 0.5, height: 1 }
      }
    ];

    const content = projectWorkspaceContent(slots, new Map([
      ["role-1", { name: "Main role" }]
    ]));

    expect(content).toEqual({
      contentCount: 2,
      hasContent: true,
      names: ["Main role", "Video room"],
      roleCount: 1,
      webCount: 1
    });
    expect(formatWorkspaceContentSummary(content, t)).toBe("1 role · 1 Web App");
  });

  it("keeps an empty workspace non-launchable while giving it a localized summary", () => {
    const content = projectWorkspaceContent([
      { id: "empty-slot", rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);

    expect(content).toMatchObject({
      contentCount: 0,
      hasContent: false,
      roleCount: 0,
      webCount: 0
    });
    expect(formatWorkspaceContentSummary(content, t)).toBe("Not configured");
  });
});
