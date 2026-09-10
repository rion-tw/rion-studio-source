import type {
  AppKitRuntimeHostIdentityRecord,
  AppKitRuntimeHostObservationRecord,
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord,
  GameWindowSaveRuntimeInputRecord,
  StateLaunchWorkspaceRecord,
  StateRoleRecord
} from "../../shared/generated";
import type { AppLanguage } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import type { MacosAppKitRuntimeTabMenuItem } from
  "./macosAppKitRuntimeTabMenu";

export interface MacosAppKitRuntimeLauncherMenuOpenRequest {
  readonly hosts: readonly AppKitRuntimeHostObservationRecord[];
  readonly identity: AppKitRuntimeHostIdentityRecord;
}

interface LauncherFence {
  readonly appKitIdentity: AppKitRuntimeHostIdentityRecord;
  readonly lifecycleEpoch: number;
  readonly parentNativeHostId: number;
  readonly tabIds: readonly string[];
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

interface LauncherContext {
  readonly fence: LauncherFence;
  readonly logical: CoreAppSnapshotRecord["logicalWindows"][number];
  readonly native: ChromiumRuntimeExecutorSnapshot["windows"][number];
  readonly saved: boolean;
  readonly snapshot: CoreAppSnapshotRecord;
}

export interface MacosAppKitRuntimeLauncherMenuInput {
  readonly actions: Readonly<{
    activateTab: (tabId: string) => Promise<unknown>;
    launchRole: (roleId: string, windowId: string) => Promise<unknown>;
    launchWorkspace: (workspaceId: string, windowId: string) => Promise<unknown>;
    saveWindow: (
      input: GameWindowSaveRuntimeInputRecord,
      identity: AppKitRuntimeHostIdentityRecord
    ) => Promise<unknown>;
  }>;
  readonly language: () => AppLanguage;
  readonly lifecycleEpoch: () => number;
  readonly nativeMenu: Readonly<{
    popup: (input: Readonly<{
      items: readonly MacosAppKitRuntimeTabMenuItem[];
      parentNativeHostId: number;
    }>) => void;
  }>;
  readonly onError: (error: unknown) => void;
  readonly readCoreSnapshot: () => Promise<CoreAppSnapshotRecord>;
  readonly readDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
}

type LauncherTarget =
  | Readonly<{ definition: StateRoleRecord; type: "role" }>
  | Readonly<{ definition: StateLaunchWorkspaceRecord; type: "workspace" }>;

type Labels = Readonly<{
  noRoles: string;
  noWorkspaces: string;
  roles: string;
  saveWindow: string;
  workspaces: string;
  windowStem: string;
}>;

const LABELS: Readonly<Record<AppLanguage, Labels>> = Object.freeze({
  "zh-TW": Object.freeze({
    noRoles: "沒有角色",
    noWorkspaces: "沒有工作區",
    roles: "角色",
    saveWindow: "儲存為新遊戲視窗",
    workspaces: "工作區",
    windowStem: "遊戲視窗"
  }),
  "zh-CN": Object.freeze({
    noRoles: "没有角色",
    noWorkspaces: "没有工作区",
    roles: "角色",
    saveWindow: "保存为新游戏窗口",
    workspaces: "工作区",
    windowStem: "游戏窗口"
  }),
  ja: Object.freeze({
    noRoles: "ロールなし",
    noWorkspaces: "ワークスペースなし",
    roles: "ロール",
    saveWindow: "新しいゲームウインドウとして保存",
    workspaces: "ワークスペース",
    windowStem: "ゲームウィンドウ"
  }),
  en: Object.freeze({
    noRoles: "No Roles",
    noWorkspaces: "No Workspaces",
    roles: "Roles",
    saveWindow: "Save as New Game Window",
    workspaces: "Workspaces",
    windowStem: "Game Window"
  })
});

function launcherError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactBounds(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function exactIdentity(
  left: AppKitRuntimeHostIdentityRecord | undefined,
  right: AppKitRuntimeHostIdentityRecord
): boolean {
  return left?.logicalWindowId === right.logicalWindowId &&
    left.launchGeneration === right.launchGeneration &&
    left.nativeGeneration === right.nativeGeneration;
}

function exactFence(left: LauncherFence, right: LauncherFence): boolean {
  return left.windowId === right.windowId &&
    left.windowGeneration === right.windowGeneration &&
    left.topologyRevision === right.topologyRevision &&
    left.lifecycleEpoch === right.lifecycleEpoch &&
    left.parentNativeHostId === right.parentNativeHostId &&
    exactIdentity(left.appKitIdentity, right.appKitIdentity) &&
    exactIds(left.tabIds, right.tabIds);
}

function exactDefinition(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function workspaceLaunchable(
  workspace: StateLaunchWorkspaceRecord,
  roleIds: ReadonlySet<string>
): boolean {
  return workspace.slots.some(
    (slot) => slot.roleId !== undefined || slot.web !== undefined
  ) && workspace.slots.every(
    (slot) => slot.roleId === undefined || roleIds.has(slot.roleId)
  );
}

function disabledItem(id: string, label: string): MacosAppKitRuntimeTabMenuItem {
  return Object.freeze({ enabled: false, id, label, type: "normal" });
}

/** Restores the v8.4 scoped AppKit `+` launcher on an exact live window fence. */
export class MacosAppKitRuntimeLauncherMenuController {
  readonly #input: MacosAppKitRuntimeLauncherMenuInput;

  constructor(input: MacosAppKitRuntimeLauncherMenuInput) {
    this.#input = input;
  }

  async open(request: MacosAppKitRuntimeLauncherMenuOpenRequest): Promise<void> {
    const context = await this.#capture(request.identity.logicalWindowId);
    const host = request.hosts[0];
    if (
      request.hosts.length !== 1 || !host || !host.visible || host.minimized ||
      !exactIdentity(host.identity, request.identity) ||
      host.windowGeneration !== context.fence.windowGeneration ||
      host.topologyRevision !== context.fence.topologyRevision
    ) {
      throw launcherError(
        "ELECTRON_MACOS_APPKIT_LAUNCHER_HOST_STALE",
        "The native launcher target is outside the exact visible AppKit topology."
      );
    }
    const labels = LABELS[this.#input.language()];
    this.#input.nativeMenu.popup({
      parentNativeHostId: context.fence.parentNativeHostId,
      items: Object.freeze([
        ...(!context.saved
          ? [Object.freeze({
              id: "runtime-launcher-save-window",
              label: labels.saveWindow,
              type: "normal" as const,
              click: () => this.#dispatchSave(context)
            }), Object.freeze({ type: "separator" as const })]
          : []),
        Object.freeze({
          label: labels.roles,
          submenu: this.#roleItems(context, labels),
          type: "submenu" as const
        }),
        Object.freeze({
          label: labels.workspaces,
          submenu: this.#workspaceItems(context, labels),
          type: "submenu" as const
        })
      ])
    });
  }

  #roleItems(
    context: LauncherContext,
    labels: Labels
  ): readonly MacosAppKitRuntimeTabMenuItem[] {
    if (context.snapshot.state.roles.length === 0) {
      return Object.freeze([disabledItem("runtime-launcher-no-roles", labels.noRoles)]);
    }
    const status = new Map(context.snapshot.roleStatuses.map(
      (value) => [value.roleId, value.state]
    ));
    return Object.freeze(context.snapshot.state.roles.map((definition) => {
      const state = status.get(definition.id);
      const busy = state === "launching" || state === "stopping";
      return Object.freeze({
        checked: state === "running",
        enabled: !busy,
        id: `runtime-launcher-role-${definition.id}`,
        label: definition.name,
        type: "checkbox" as const,
        click: () => this.#dispatchTarget(context, {
          definition,
          type: "role"
        })
      });
    }));
  }

  #workspaceItems(
    context: LauncherContext,
    labels: Labels
  ): readonly MacosAppKitRuntimeTabMenuItem[] {
    const workspaces = context.snapshot.state.launchWorkspaces;
    if (workspaces.length === 0) {
      return Object.freeze([
        disabledItem("runtime-launcher-no-workspaces", labels.noWorkspaces)
      ]);
    }
    const roleIds = new Set(context.snapshot.state.roles.map((role) => role.id));
    const status = new Map(context.snapshot.browserRuntime.workspaces.map(
      (value) => [value.workspaceId, value.state]
    ));
    const running = new Set(context.snapshot.browserRuntime.tabs
      .filter((tab) => tab.tabType === "workspace")
      .map((tab) => tab.sourceId));
    return Object.freeze(workspaces.map((definition) => {
      const state = status.get(definition.id);
      const busy = state === "launching" || state === "stopping";
      return Object.freeze({
        checked: running.has(definition.id),
        enabled: workspaceLaunchable(definition, roleIds) && !busy,
        id: `runtime-launcher-workspace-${definition.id}`,
        label: definition.name,
        type: "checkbox" as const,
        click: () => this.#dispatchTarget(context, {
          definition,
          type: "workspace"
        })
      });
    }));
  }

  #dispatchTarget(context: LauncherContext, target: LauncherTarget): void {
    void this.#executeTarget(context, target).catch(this.#input.onError);
  }

  async #executeTarget(context: LauncherContext, target: LauncherTarget): Promise<void> {
    const current = await this.#capture(context.fence.windowId);
    const definitions = target.type === "role"
      ? current.snapshot.state.roles
      : current.snapshot.state.launchWorkspaces;
    const definition = definitions.find((value) => value.id === target.definition.id);
    if (!exactFence(current.fence, context.fence) ||
      !exactDefinition(definition, target.definition)) {
      throw launcherError(
        "ELECTRON_MACOS_APPKIT_LAUNCHER_FENCE_STALE",
        "The native launcher lost its exact Core/AppKit source fence."
      );
    }
    const existingTabId = target.type === "role"
      ? current.snapshot.browserRuntime.roles.find(
          (role) => role.roleId === target.definition.id
        )?.owner.tabId
      : current.snapshot.browserRuntime.workspaces.find(
          (workspace) => workspace.workspaceId === target.definition.id
        )?.tabId;
    if (existingTabId !== undefined) {
      const owners = current.snapshot.logicalWindows.flatMap((window) =>
        window.tabs
          .filter((tab) => tab.id === existingTabId)
          .map((tab) => ({ tab, window }))
      );
      const owner = owners[0];
      if (owners.length !== 1 || !owner) {
        throw launcherError(
          "ELECTRON_MACOS_APPKIT_LAUNCHER_OWNER_STALE",
          "The checked native launcher source lost its exact logical tab owner."
        );
      }
      if (!owner.tab.hidden && owner.window.activeTabId === existingTabId) return;
      await this.#input.actions.activateTab(existingTabId);
      return;
    }
    if (target.type === "role") {
      await this.#input.actions.launchRole(target.definition.id, context.fence.windowId);
    } else {
      await this.#input.actions.launchWorkspace(
        target.definition.id,
        context.fence.windowId
      );
    }
  }

  #dispatchSave(context: LauncherContext): void {
    void this.#save(context).catch(this.#input.onError);
  }

  async #save(context: LauncherContext): Promise<void> {
    const current = await this.#capture(context.fence.windowId);
    if (!exactFence(current.fence, context.fence) || current.saved) {
      throw launcherError(
        "ELECTRON_MACOS_APPKIT_LAUNCHER_FENCE_STALE",
        "The transient Game Window changed before it could be saved."
      );
    }
    const target = current.native.target;
    const display = this.#input.readDisplayTopology().displays.find(
      (candidate) => candidate.id === current.native.displayId
    );
    if (
      !target || !display || target.displayId !== display.id ||
      display.scaleFactor !== target.scaleFactor ||
      !exactBounds(display.workArea, target.workArea)
    ) {
      throw launcherError(
        "ELECTRON_MACOS_APPKIT_LAUNCHER_DISPLAY_STALE",
        "The transient Game Window display changed before it could be saved."
      );
    }
    const labels = LABELS[this.#input.language()];
    const names = new Set(current.snapshot.state.gameWindows.map(
      (window) => window.name.toLocaleLowerCase()
    ));
    let number = 1;
    while (names.has(`${labels.windowStem} ${number}`.toLocaleLowerCase())) number += 1;
    await this.#input.actions.saveWindow({
      windowId: current.fence.windowId,
      name: `${labels.windowStem} ${number}`,
      targetDisplay: {
        id: display.id,
        fingerprint: {
          label: display.label,
          bounds: { ...display.bounds },
          resolution: { ...display.resolution },
          scaleFactor: display.scaleFactor,
          isPrimary: display.isPrimary,
          isInternal: display.isInternal
        }
      },
      placement: {
        normalBounds: { ...target.bounds },
        savedWorkArea: { ...target.workArea },
        presentation: current.native.presentation
      },
      tabs: current.logical.tabs.map((tab) => ({ ...tab })),
      ...(current.logical.activeTabId === undefined
        ? {}
        : { activeTabId: current.logical.activeTabId })
    }, current.fence.appKitIdentity);
  }

  async #capture(windowId: string): Promise<LauncherContext> {
    const snapshot = await this.#input.readCoreSnapshot();
    const native = this.#input.readNativeSnapshot();
    const lifecycleEpoch = this.#input.lifecycleEpoch();
    const logical = snapshot.logicalWindows.filter(
      (window) => window.windowId === windowId
    );
    const owners = native.windows.filter((window) => window.windowId === windowId);
    const owner = owners[0];
    const tabIds = logical[0]?.tabs.map((tab) => tab.id) ?? [];
    if (
      logical.length !== 1 || owners.length !== 1 || !owner ||
      !Number.isSafeInteger(lifecycleEpoch) || lifecycleEpoch < 1 ||
      logical[0]!.windowGeneration !== owner.windowGeneration ||
      logical[0]!.revision !== owner.topologyRevision ||
      !exactIds(tabIds, owner.tabIds) ||
      !Number.isSafeInteger(owner.parentNativeHostId) ||
      (owner.parentNativeHostId ?? 0) < 1 ||
      !owner.appKitIdentity ||
      owner.appKitIdentity.logicalWindowId !== windowId ||
      owner.appKitIdentity.launchGeneration.length === 0 ||
      !Number.isSafeInteger(owner.appKitIdentity.nativeGeneration) ||
      owner.appKitIdentity.nativeGeneration < 1
    ) {
      throw launcherError(
        "ELECTRON_MACOS_APPKIT_LAUNCHER_TOPOLOGY_STALE",
        "The native launcher could not prove an exact Core/AppKit parent fence."
      );
    }
    return Object.freeze({
      fence: Object.freeze({
        appKitIdentity: Object.freeze({ ...owner.appKitIdentity }),
        lifecycleEpoch,
        parentNativeHostId: owner.parentNativeHostId!,
        tabIds: Object.freeze(tabIds),
        topologyRevision: owner.topologyRevision,
        windowGeneration: owner.windowGeneration,
        windowId
      }),
      logical: logical[0]!,
      native: owner,
      saved: snapshot.state.gameWindows.some((window) => window.id === windowId),
      snapshot
    });
  }
}
