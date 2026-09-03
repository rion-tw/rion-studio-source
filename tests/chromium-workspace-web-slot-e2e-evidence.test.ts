import { describe, expect, it } from "vitest";

import { validateChromiumWorkspaceWebSqliteEvidence } from
  "../scripts/desktopE2eChromiumWorkspaceWebEvidence.mjs";

const web = {
  name: "Chromium Workspace Web fixture",
  startUrl: "http://127.0.0.1:49355/role/chromium-workspace-web-slot?mode=seed&marker=chromium-workspace-web-slot-marker"
};
const templateSlots = [
  { id: "slot-1", rect: { height: 1, width: 0.5, x: 0, y: 0 }, web },
  { id: "slot-2", rect: { height: 1, width: 0.5, x: 0.5, y: 0 }, roleId: "role-1" }
];
const persistedSlots = [
  { id: "slot-1", rect: { height: 1, width: 0.55, x: 0, y: 0 }, web },
  {
    id: "slot-2",
    rect: { height: 1, width: 0.44999999999999996, x: 0.55, y: 0 },
    roleId: "role-1"
  }
];

function entities(savedSlots = persistedSlots) {
  return {
    games: [],
    gameWindows: [{
      id: "window-1",
      name: "Chromium Workspace Web Window",
      payload: {
        activeTabId: "tab-1",
        tabs: [{
          id: "tab-1",
          roleSlots: [{
            rect: savedSlots[1].rect,
            roleId: "role-1",
            slotId: "slot-2"
          }],
          sourceId: "workspace-1",
          tabType: "workspace",
          workspaceSlots: savedSlots
        }]
      }
    }],
    macros: [],
    roles: [{ id: "role-1", name: "Chromium Entity Role Edited" }],
    workspaces: [{
      id: "workspace-1",
      name: "Chromium Workspace Web Slot",
      payload: { slots: templateSlots }
    }]
  };
}

const settings = [{ key: "runtimeRestoreSession", payload: { cleanExit: true } }];

describe("Chromium Workspace Web SQLite evidence", () => {
  it("keeps the Workspace template stable and proves the resized saved-window snapshot", () => {
    expect(validateChromiumWorkspaceWebSqliteEvidence(
      "chromium-workspace-web-slot-seed",
      entities(),
      settings
    )).toEqual({
      cleanExit: true,
      gameWindowId: "window-1",
      resizedWebWidth: 0.55,
      restartVerified: false,
      workspaceId: "workspace-1"
    });
  });

  it("rejects an unresized saved-window snapshot even when the template is valid", () => {
    expect(() => validateChromiumWorkspaceWebSqliteEvidence(
      "chromium-workspace-web-slot-seed",
      entities(templateSlots),
      settings
    )).toThrow("resized mixed layout was not durable in the saved Game Window snapshot");
  });

  it("retains exact restart identity while tolerating equivalent IEEE rect encoding", () => {
    validateChromiumWorkspaceWebSqliteEvidence(
      "chromium-workspace-web-slot-seed",
      entities(),
      settings
    );
    const restartedSlots = structuredClone(persistedSlots);
    restartedSlots[1]!.rect.width = 0.45;
    expect(validateChromiumWorkspaceWebSqliteEvidence(
      "chromium-workspace-web-slot-restart",
      entities(restartedSlots),
      settings
    )).toMatchObject({
      gameWindowId: "window-1",
      resizedWebWidth: 0.55,
      restartVerified: true,
      workspaceId: "workspace-1"
    });
  });
});
