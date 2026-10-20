import { afterEach, describe, expect, it } from "vitest";


import { updateWorkspaceStartAppearance } from "../src/electron/main/workspaceStartPage";
import { runtimeRolePlaceholderLabels } from "../src/electron/main/workspaceWebStatus";
import { parseRuntimeRolePlaceholderState } from "../src/shared/runtimeRolePlaceholder";

afterEach(() => updateWorkspaceStartAppearance({ language: "en" }));

describe("runtime Role placeholder labels", () => {
  it("follows the application language and names the owner tab literally", () => {
    updateWorkspaceStartAppearance({ language: "zh-TW" });
    expect(runtimeRolePlaceholderLabels({ blocked: true, ownerTabName: "$& 練功" })).toEqual({
      action: "停止原位置並在這裡開啟",
      busy: "正在開啟…",
      failed: "無法開啟角色，請再試一次。",
      message: "這個角色目前在「$& 練功」分頁。"
    });
    updateWorkspaceStartAppearance({ language: "en" });
    expect(runtimeRolePlaceholderLabels({ blocked: true, ownerTabName: null }).message)
      .toBe("This role is open in “another tab”.");
    expect(runtimeRolePlaceholderLabels({ blocked: false, ownerTabName: null })).toMatchObject({
      action: "Open here",
      message: "This role is currently stopped."
    });
  });

  it.each(["en", "zh-TW", "zh-CN", "ja"] as const)("produces a valid %s state", (language) => {
    updateWorkspaceStartAppearance({ language });
    expect(parseRuntimeRolePlaceholderState({
      blocked: true,
      generation: 1,
      labels: runtimeRolePlaceholderLabels({ blocked: true, ownerTabName: "Source" }),
      ownerGeneration: 2,
      ownerTabName: "Source",
      placeholderId: "role-placeholder:tab:slot",
      roleId: "role",
      roleName: "Role",
      slotId: "slot",
      tabId: "tab",
      topologyRevision: 3,
      windowGeneration: 1,
      windowId: "window"
    })).not.toBeNull();
  });
});
