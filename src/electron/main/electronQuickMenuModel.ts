import type {
  CoreAppSnapshotRecord,
  LegalAcceptanceStatusRecord
} from "../../shared/generated";
import type { AppLanguage } from "../../shared/types";

export type ElectronQuickMenuPlatform = "darwin" | "win32";

export type ElectronQuickMenuEntry =
  | Readonly<{
      id: string;
      label: string;
      enabled: boolean;
      checked?: boolean;
    }>
  | Readonly<{
      label: string;
      submenu: readonly ElectronQuickMenuEntry[];
    }>
  | Readonly<{ type: "separator" }>;

export interface ElectronQuickMenuModelInput {
  readonly language: AppLanguage;
  readonly legal: LegalAcceptanceStatusRecord;
  readonly platform: ElectronQuickMenuPlatform;
  readonly snapshot: CoreAppSnapshotRecord;
}

interface QuickMenuLabels {
  readonly noRoles: string;
  readonly noWindows: string;
  readonly noWorkspaces: string;
  readonly open: string;
  readonly quit: string;
  readonly reviewTerms: string;
  readonly roles: string;
  readonly stopAll: string;
  readonly temporaryWindow: string;
  readonly windows: string;
  readonly workspaces: string;
}

const LABELS: Readonly<Record<AppLanguage, QuickMenuLabels>> = Object.freeze({
  "zh-TW": Object.freeze({
    noRoles: "沒有角色",
    noWindows: "沒有視窗",
    noWorkspaces: "沒有工作區",
    open: "開啟 Rion Studio",
    quit: "結束 Rion Studio",
    reviewTerms: "啟動前請先檢閱條款",
    roles: "角色",
    stopAll: "停止所有執行中的角色",
    temporaryWindow: "臨時視窗",
    windows: "視窗",
    workspaces: "工作區"
  }),
  "zh-CN": Object.freeze({
    noRoles: "没有角色",
    noWindows: "没有窗口",
    noWorkspaces: "没有工作区",
    open: "打开 Rion Studio",
    quit: "退出 Rion Studio",
    reviewTerms: "启动前请先查看条款",
    roles: "角色",
    stopAll: "停止所有运行中的角色",
    temporaryWindow: "临时窗口",
    windows: "窗口",
    workspaces: "工作区"
  }),
  ja: Object.freeze({
    noRoles: "ロールなし",
    noWindows: "ウインドウなし",
    noWorkspaces: "ワークスペースなし",
    open: "Rion Studio を開く",
    quit: "Rion Studio を終了",
    reviewTerms: "起動前に利用規約を確認",
    roles: "ロール",
    stopAll: "実行中のロールをすべて停止",
    temporaryWindow: "一時ウインドウ",
    windows: "ウインドウ",
    workspaces: "ワークスペース"
  }),
  en: Object.freeze({
    noRoles: "No Roles",
    noWindows: "No Windows",
    noWorkspaces: "No Workspaces",
    open: "Open Rion Studio",
    quit: "Quit Rion Studio",
    reviewTerms: "Review terms before launching",
    roles: "Roles",
    stopAll: "Stop All Running Roles",
    temporaryWindow: "Temporary Window",
    windows: "Windows",
    workspaces: "Workspaces"
  })
});

function item(
  id: string,
  label: string,
  enabled: boolean,
  checked = false
): ElectronQuickMenuEntry {
  return Object.freeze({
    id,
    label,
    enabled,
    ...(checked ? { checked: true } : {})
  });
}

export function buildElectronQuickMenuStarter(
  language: AppLanguage,
  platform: ElectronQuickMenuPlatform
): readonly ElectronQuickMenuEntry[] {
  const labels = LABELS[language];
  return Object.freeze([
    item("open-app", labels.open, true),
    ...(platform === "win32"
      ? [Object.freeze({ type: "separator" as const }),
          item("quit-app", labels.quit, true)]
      : [])
  ]);
}

export function buildElectronQuickMenuModel(
  input: ElectronQuickMenuModelInput
): readonly ElectronQuickMenuEntry[] {
  const { snapshot } = input;
  const labels = LABELS[input.language];
  const legalAccepted = input.legal.isAccepted;
  const roleStatusById = new Map(
    snapshot.roleStatuses.map((status) => [status.roleId, status])
  );
  const roleIds = new Set(snapshot.state.roles.map((role) => role.id));
  const roleItems = snapshot.state.roles.length === 0
    ? [item("no-roles", labels.noRoles, false)]
    : snapshot.state.roles.map((role) => {
        const state = roleStatusById.get(role.id)?.state;
        const busy = state === "launching" || state === "stopping";
        const running = state === "running";
        return item(
          `launch-role:${role.id}`,
          `${busy && !running ? "… " : ""}${role.name}`,
          legalAccepted && !busy,
          running
        );
      });

  const workspaceStatusById = new Map(
    snapshot.browserRuntime.workspaces.map((status) => [status.workspaceId, status])
  );
  const openWorkspaceIds = new Set(
    snapshot.browserRuntime.tabs
      .filter((tab) => tab.tabType === "workspace")
      .map((tab) => tab.sourceId)
  );
  const workspaceItems = snapshot.state.launchWorkspaces.length === 0
    ? [item("no-workspaces", labels.noWorkspaces, false)]
    : snapshot.state.launchWorkspaces.map((workspace) => {
        const state = workspaceStatusById.get(workspace.id)?.state;
        const busy = state === "launching" || state === "stopping";
        const running = openWorkspaceIds.has(workspace.id);
        const assignedRoleIds = workspace.slots.flatMap((slot) =>
          slot.roleId === undefined ? [] : [slot.roleId]
        );
        const hasContent = workspace.slots.some(
          (slot) => slot.roleId !== undefined || slot.web !== undefined
        );
        const missingRole = assignedRoleIds.some((roleId) => !roleIds.has(roleId));
        return item(
          `launch-workspace:${workspace.id}`,
          `${busy && !running ? "… " : ""}${workspace.name}`,
          legalAccepted && hasContent && !missingRole && (running || !busy),
          running
        );
      });

  const runningWindowIds = new Set(
    snapshot.browserRuntime.windows.map((window) => window.windowId)
  );
  const savedWindowIds = new Set(
    snapshot.state.gameWindows.map((window) => window.id)
  );
  const windowItems: ElectronQuickMenuEntry[] = snapshot.state.gameWindows.map(
    (window) => {
      const running = runningWindowIds.has(window.id);
      return item(
        `${running ? "show-display" : "restore-window"}:${window.id}`,
        window.name,
        running || legalAccepted,
        running
      );
    }
  );
  for (const window of snapshot.browserRuntime.windows) {
    if (savedWindowIds.has(window.windowId)) continue;
    const tabs = snapshot.browserRuntime.tabs.filter(
      (tab) => tab.windowId === window.windowId
    );
    const active = tabs.find((tab) => tab.id === window.activeTabId) ?? tabs[0];
    windowItems.push(item(
      `show-display:${window.windowId}`,
      `${active?.name ?? "Rion Studio"} · ${labels.temporaryWindow}`,
      true,
      true
    ));
  }
  if (windowItems.length === 0) {
    windowItems.push(item("no-windows", labels.noWindows, false));
  }

  return Object.freeze([
    item("open-app", labels.open, true),
    ...(!legalAccepted
      ? [item("review-terms", labels.reviewTerms, true)]
      : []),
    Object.freeze({ type: "separator" as const }),
    Object.freeze({ label: labels.roles, submenu: Object.freeze(roleItems) }),
    Object.freeze({
      label: labels.workspaces,
      submenu: Object.freeze(workspaceItems)
    }),
    Object.freeze({ label: labels.windows, submenu: Object.freeze(windowItems) }),
    ...(snapshot.roleStatuses.length > 0
      ? [Object.freeze({ type: "separator" as const }),
          item("stop-all", labels.stopAll, true)]
      : []),
    ...(input.platform === "win32"
      ? [Object.freeze({ type: "separator" as const }),
          item("quit-app", labels.quit, true)]
      : [])
  ]);
}
