import { describe, expect, it, vi } from "vitest";

import { ElectronQuickMenuController } from
  "../src/electron/main/electronQuickMenuController";
import type { ElectronQuickMenuEntry } from
  "../src/electron/main/electronQuickMenuModel";
import type {
  CoreAppSnapshotRecord,
  CoreEvent,
  LegalAcceptanceStatusRecord
} from "../src/shared/generated";

const snapshot = {
  revision: 1,
  stateRevision: 1,
  runtimeRevision: 1,
  state: {
    revision: 1,
    games: [],
    roles: [],
    launchWorkspaces: [],
    gameWindows: [],
    macros: []
  },
  browserRuntime: { roles: [], workspaces: [], windows: [], tabs: [] },
  logicalWindows: [],
  roleStatuses: [],
  macroStatuses: []
} as unknown as CoreAppSnapshotRecord;
const legal = {
  isAccepted: true,
  currentVersions: {}
} as unknown as LegalAcceptanceStatusRecord;

describe("Electron Quick Menu controller", () => {
  it("starts with a native-safe menu then refreshes from Core events", async () => {
    let listener: (event: CoreEvent) => void = () => undefined;
    let action: (id: string) => void = () => undefined;
    const applied: Array<readonly ElectronQuickMenuEntry[]> = [];
    const unsubscribe = vi.fn();
    const controller = new ElectronQuickMenuController({
      actions: {
        launchRole: vi.fn(async () => undefined),
        launchWorkspace: vi.fn(async () => undefined),
        presentMainWindow: vi.fn(async () => undefined),
        requestQuit: vi.fn(async () => undefined),
        showGameWindow: vi.fn(async () => undefined),
        stopAllRoles: vi.fn(async () => undefined)
      },
      apply: (entries, onAction) => {
        applied.push(entries);
        action = onAction;
      },
      initialLanguage: "en",
      onError: vi.fn(),
      platform: "win32",
      state: {
        read: vi.fn(async () => ({ legal, snapshot })),
        subscribe: (value) => {
          listener = value;
          return unsubscribe;
        }
      }
    });
    controller.start();
    expect(applied[0]).toContainEqual(expect.objectContaining({ id: "open-app" }));
    expect(applied[0]).toContainEqual(expect.objectContaining({ id: "quit-app" }));
    await vi.waitFor(() => expect(applied).toHaveLength(2));

    controller.setLanguage("zh-TW");
    await vi.waitFor(() => expect(applied).toHaveLength(3));
    expect(applied.at(-1)).toContainEqual(expect.objectContaining({
      id: "open-app",
      label: "開啟 Rion Studio"
    }));

    listener({
      type: "stateChanged",
      revision: 2,
      changedCollections: []
    });
    await Promise.resolve();
    action("open-app");
    controller.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("routes every restored v8.4 action through the privileged action ports", async () => {
    let action: (id: string) => void = () => undefined;
    const actions = {
      launchRole: vi.fn(async () => undefined),
      launchWorkspace: vi.fn(async () => undefined),
      presentMainWindow: vi.fn(async () => undefined),
      requestQuit: vi.fn(async () => undefined),
      showGameWindow: vi.fn(async () => undefined),
      stopAllRoles: vi.fn(async () => undefined)
    };
    const controller = new ElectronQuickMenuController({
      actions,
      apply: (_entries, onAction) => { action = onAction; },
      initialLanguage: "en",
      onError: vi.fn(),
      platform: "darwin",
      state: {
        read: vi.fn(async () => ({ legal, snapshot })),
        subscribe: () => vi.fn()
      }
    });
    controller.start();
    for (const id of [
      "open-app",
      "review-terms",
      "launch-role:role-one",
      "launch-workspace:workspace-one",
      "show-display:window-live",
      "restore-window:window-saved",
      "stop-all",
      "quit-app"
    ]) action(id);
    await vi.waitFor(() => {
      expect(actions.presentMainWindow).toHaveBeenCalledTimes(2);
      expect(actions.launchRole).toHaveBeenCalledWith("role-one");
      expect(actions.launchWorkspace).toHaveBeenCalledWith("workspace-one");
      expect(actions.showGameWindow).toHaveBeenNthCalledWith(1, "window-live");
      expect(actions.showGameWindow).toHaveBeenNthCalledWith(2, "window-saved");
      expect(actions.stopAllRoles).toHaveBeenCalledOnce();
      expect(actions.requestQuit).toHaveBeenCalledOnce();
    });
  });
});
