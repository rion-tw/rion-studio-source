import { describe, expect, it } from "vitest";

import { buildElectronQuickMenuModel } from
  "../src/electron/main/electronQuickMenuModel";
import type {
  CoreAppSnapshotRecord,
  LegalAcceptanceStatusRecord
} from "../src/shared/generated";

function snapshot(): CoreAppSnapshotRecord {
  return {
    revision: 8,
    stateRevision: 4,
    runtimeRevision: 6,
    state: {
      revision: 4,
      games: [],
      roles: [
        { id: "role-running", name: "Alpha" },
        { id: "role-busy", name: "Beta" }
      ],
      launchWorkspaces: [
        {
          id: "workspace-open",
          name: "Squad",
          slots: [{ id: "slot-one", roleId: "role-running" }]
        },
        {
          id: "workspace-invalid",
          name: "Broken",
          slots: [{ id: "slot-two", roleId: "missing-role" }]
        }
      ],
      gameWindows: [
        { id: "window-live", name: "Live", tabs: [] },
        { id: "window-saved", name: "Saved", tabs: [] }
      ],
      macros: []
    },
    browserRuntime: {
      roles: [],
      workspaces: [{
        workspaceId: "workspace-open",
        name: "Squad",
        runtime: "embedded",
        windowId: "window-live",
        tabId: "tab-workspace",
        roleIds: ["role-running"],
        state: "stopping"
      }],
      windows: [
        { windowId: "window-live", activeTabId: "tab-workspace", tabIds: [] },
        { windowId: "window-temp", activeTabId: "tab-temp", tabIds: [] }
      ],
      tabs: [
        {
          id: "tab-workspace",
          audioMuted: false,
          sourceId: "workspace-open",
          name: "Squad",
          windowId: "window-live",
          tabType: "workspace",
          slots: [],
          webSurfaces: [],
          hidden: false
        },
        {
          id: "tab-temp",
          audioMuted: false,
          sourceId: "role-running",
          name: "Temporary Role",
          windowId: "window-temp",
          tabType: "role",
          slots: [],
          webSurfaces: [],
          hidden: false
        }
      ]
    },
    logicalWindows: [],
    roleStatuses: [
      { roleId: "role-running", state: "running", runtimeMode: "embedded" },
      { roleId: "role-busy", state: "launching", runtimeMode: "embedded" }
    ],
    macroStatuses: []
  } as unknown as CoreAppSnapshotRecord;
}

const legal = (isAccepted: boolean) => ({
  isAccepted,
  currentVersions: { terms: "1", privacy: "1", fairUse: "1" }
}) as unknown as LegalAcceptanceStatusRecord;

function submenu(
  model: ReturnType<typeof buildElectronQuickMenuModel>,
  label: string
) {
  const value = model.find((entry) => "submenu" in entry && entry.label === label);
  if (!value || !("submenu" in value)) throw new Error(`Missing ${label} submenu`);
  return value.submenu;
}

describe("Electron Quick Menu model", () => {
  it.each(["darwin", "win32"] as const)("lists only live windows directly, sharing submenu names and order (%s)", (platform) => {
    const state = snapshot();
    // Hidden tabs still belong to a live window; multiple tabs yield one entry.
    state.browserRuntime.tabs[1]!.hidden = true;
    state.browserRuntime.tabs.push({
      ...state.browserRuntime.tabs[1]!, id: "second-tab", name: "Inactive"
    });
    const model = buildElectronQuickMenuModel({ language: "zh-TW", legal: legal(false), platform, snapshot: state });
    const direct = model.filter((entry) => "id" in entry && entry.id.startsWith("show-display:"));
    expect(direct).toEqual([
      { id: "show-display:window-live", label: "Live", checked: true, enabled: true },
      { id: "show-display:window-temp", label: "Temporary Role · 臨時視窗", checked: true, enabled: true }
    ]);
    for (const entry of direct) expect(submenu(model, "視窗")).toContain(entry);
    expect(model).not.toContainEqual(expect.objectContaining({ id: "restore-window:window-saved" }));
    expect(submenu(model, "視窗")).toContainEqual(expect.objectContaining({ id: "restore-window:window-saved" }));
    expect(model.slice(0, 7)).toEqual([
      expect.objectContaining({ id: "open-app" }),
      expect.objectContaining({ id: "review-terms" }),
      { type: "separator" }, ...direct, { type: "separator" },
      expect.objectContaining({ label: "角色", submenu: expect.any(Array) })
    ]);
  });

  it.each(["darwin", "win32"] as const)("omits the direct section without live windows (%s)", (platform) => {
    const state = snapshot();
    state.browserRuntime.windows = [];
    state.browserRuntime.tabs = [];
    const model = buildElectronQuickMenuModel({ language: "en", legal: legal(true), platform, snapshot: state });
    expect(model.slice(0, 3)).toEqual([
      expect.objectContaining({ id: "open-app" }), { type: "separator" },
      expect.objectContaining({ label: "Roles", submenu: expect.any(Array) })
    ]);
    expect(model.some((entry) => "id" in entry && entry.id.startsWith("show-display:"))).toBe(false);
    expect(submenu(model, "Windows")).toHaveLength(2);
    for (let index = 1; index < model.length; index += 1) {
      expect("type" in model[index]! && "type" in model[index - 1]!).toBe(false);
    }
  });

  it.each(["darwin", "win32"] as const)("names an empty temporary window without the product name (%s)", (platform) => {
    const state = snapshot();
    state.browserRuntime.tabs = state.browserRuntime.tabs.filter((tab) => tab.windowId !== "window-temp");
    const model = buildElectronQuickMenuModel({ language: "zh-TW", legal: legal(true), platform, snapshot: state });
    expect(submenu(model, "視窗")).toContainEqual(expect.objectContaining({
      id: "show-display:window-temp", label: "臨時視窗"
    }));
    expect(model).toContainEqual(expect.objectContaining({
      id: "show-display:window-temp", label: "臨時視窗"
    }));
  });

  it("restores the complete v8.4 role, workspace, and window model on macOS", () => {
    const model = buildElectronQuickMenuModel({
      language: "zh-TW",
      legal: legal(true),
      platform: "darwin",
      snapshot: snapshot()
    });
    expect(model.some((entry) => "id" in entry && entry.id === "quit-app"))
      .toBe(false);
    expect(submenu(model, "角色")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "launch-role:role-running",
        label: "Alpha",
        checked: true,
        enabled: true
      }),
      expect.objectContaining({
        id: "launch-role:role-busy",
        label: "… Beta",
        enabled: false
      })
    ]));
    expect(submenu(model, "工作區")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "launch-workspace:workspace-open",
        checked: true,
        enabled: true
      }),
      expect.objectContaining({
        id: "launch-workspace:workspace-invalid",
        enabled: false
      })
    ]));
    expect(submenu(model, "視窗")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "show-display:window-live", checked: true }),
      expect.objectContaining({ id: "restore-window:window-saved" }),
      expect.objectContaining({
        id: "show-display:window-temp",
        label: "Temporary Role · 臨時視窗",
        checked: true
      })
    ]));
    expect(model).toContainEqual(expect.objectContaining({ id: "stop-all" }));
  });

  it("adds review and guarded Windows quit actions before legal acceptance", () => {
    const model = buildElectronQuickMenuModel({
      language: "en",
      legal: legal(false),
      platform: "win32",
      snapshot: snapshot()
    });
    expect(model).toContainEqual(expect.objectContaining({ id: "review-terms" }));
    expect(model).toContainEqual(expect.objectContaining({ id: "quit-app" }));
    expect(submenu(model, "Roles")).toContainEqual(expect.objectContaining({
      id: "launch-role:role-running",
      checked: true,
      enabled: false
    }));
    expect(submenu(model, "Windows")).toContainEqual(expect.objectContaining({
      id: "restore-window:window-saved",
      enabled: false
    }));
  });
});
