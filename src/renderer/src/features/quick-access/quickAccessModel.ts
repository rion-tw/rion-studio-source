import type { Translator } from "../../i18n";
import {
  formatWorkspaceContentSummary,
  projectWorkspaceContent
} from "../../app/workspaceContent";
import { findUnassignedMacroDependency } from "../../../../shared/macroDependencies";
import type {
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  QuickAccessItemRef,
  QuickAccessPreferences,
  Role,
  RoleStatus
} from "../../../../shared/types";
import { createMacroListRunActionState } from "../macros/MacroListControls";

export type QuickAccessRouteId =
  | "dashboard"
  | "games"
  | "roles"
  | "workspaces"
  | "gameWindows"
  | "macros"
  | "settings";

export type QuickAccessGroup = "pinned" | "recent" | "pages" | "results";

interface QuickAccessItemBase {
  active: boolean;
  disabled: boolean;
  group: QuickAccessGroup;
  key: string;
  label: string;
  pinned: boolean;
  pinnedRank?: number;
  recentRank?: number;
  searchText: string;
  subtitle: string;
}

export type QuickAccessItem =
  | (QuickAccessItemBase & { kind: "role"; ref: QuickAccessItemRef; role: Role })
  | (QuickAccessItemBase & {
      kind: "workspace";
      ref: QuickAccessItemRef;
      workspace: LaunchWorkspace;
    })
  | (QuickAccessItemBase & {
      gameWindow: GameWindow;
      kind: "gameWindow";
      ref: QuickAccessItemRef;
    })
  | (QuickAccessItemBase & { kind: "macro"; macro: Macro; ref: QuickAccessItemRef })
  | (QuickAccessItemBase & { kind: "route"; path: string; routeId: QuickAccessRouteId });

export interface QuickAccessCatalogInput {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  busyRoleIds: ReadonlySet<string>;
  busyWorkspaceIds: ReadonlySet<string>;
  gameWindows: readonly GameWindow[];
  games: readonly Game[];
  macroStatusByRun: Map<string, MacroRunStatus>;
  macros: readonly Macro[];
  preferences: QuickAccessPreferences;
  roles: readonly Role[];
  runtime: EmbeddedRuntimeState;
  runtimeInputAvailable?: boolean;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaces: readonly LaunchWorkspace[];
}

const ROUTES: ReadonlyArray<{ id: QuickAccessRouteId; path: string }> = [
  { id: "dashboard", path: "/dashboard" },
  { id: "games", path: "/games" },
  { id: "roles", path: "/roles" },
  { id: "workspaces", path: "/workspaces" },
  { id: "gameWindows", path: "/game-windows" },
  { id: "macros", path: "/macros" },
  { id: "settings", path: "/settings" }
];

const ROUTE_LABEL_KEYS = {
  dashboard: "app.home",
  games: "app.games",
  roles: "app.roles",
  workspaces: "app.workspaces",
  gameWindows: "app.gameWindows",
  macros: "app.macros",
  settings: "app.settings"
} as const;

export function quickAccessItemKey(item: QuickAccessItemRef): string {
  return `${item.kind}:${item.id}`;
}

export function normalizeQuickAccessSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function isQuickAccessShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "repeat" | "shiftKey">,
  platform: "mac" | "windows"
): boolean {
  if (event.isComposing || event.repeat || event.altKey || event.shiftKey) {
    return false;
  }
  if (event.key.toLocaleLowerCase() !== "k") {
    return false;
  }
  return platform === "mac"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function createQuickAccessCatalog(input: QuickAccessCatalogInput): QuickAccessItem[] {
  const pinnedKeys = new Set(input.preferences.pinnedItems.map(quickAccessItemKey));
  const pinnedRankByKey = new Map(
    input.preferences.pinnedItems.map((item, index) => [quickAccessItemKey(item), index])
  );
  const recentRankByKey = new Map(
    input.preferences.recentItems.map((item, index) => [quickAccessItemKey(item), index])
  );
  const gameNameById = new Map(input.games.map((game) => [game.id, game.name]));
  const roleById = new Map(input.roles.map((role) => [role.id, role]));
  const windowNameById = new Map(input.gameWindows.map((window) => [window.id, window.name]));
  const savedStateById = new Map(
    (input.runtime.savedWindows ?? []).map((window) => [window.id, window.state])
  );

  const roles: QuickAccessItem[] = input.roles.map((role) => {
    const ref = { kind: "role", id: role.id } as const;
    const owner = findRuntimeOwner(input.runtime, ref);
    const gameName = gameNameById.get(role.gameId) ?? "";
    const ownerName = owner ? windowNameById.get(owner.windowId) ?? owner.tab.name : "";
    return {
      active: Boolean(owner) || input.statusByRole.has(role.id),
      disabled: input.busyRoleIds.has(role.id),
      group: "results",
      key: quickAccessItemKey(ref),
      kind: "role",
      label: role.name,
      pinned: pinnedKeys.has(quickAccessItemKey(ref)),
      pinnedRank: pinnedRankByKey.get(quickAccessItemKey(ref)),
      recentRank: recentRankByKey.get(quickAccessItemKey(ref)),
      ref,
      role,
      searchText: createSafeSearchText(role.name, input.t("quickAccess.type.role"), gameName, ownerName),
      subtitle: owner
        ? input.t("quickAccess.location")
          .replace("{window}", ownerName)
          .replace("{tab}", owner.tab.name)
        : gameName
    };
  });

  const workspaces: QuickAccessItem[] = input.workspaces.map((workspace) => {
    const ref = { kind: "workspace", id: workspace.id } as const;
    const owner = findRuntimeOwner(input.runtime, ref);
    const content = projectWorkspaceContent(workspace.slots, roleById);
    const ownerName = owner ? windowNameById.get(owner.windowId) ?? owner.tab.name : "";
    return {
      active: Boolean(owner),
      disabled: input.busyWorkspaceIds.has(workspace.id) || !content.hasContent,
      group: "results",
      key: quickAccessItemKey(ref),
      kind: "workspace",
      label: workspace.name,
      pinned: pinnedKeys.has(quickAccessItemKey(ref)),
      pinnedRank: pinnedRankByKey.get(quickAccessItemKey(ref)),
      recentRank: recentRankByKey.get(quickAccessItemKey(ref)),
      ref,
      searchText: createSafeSearchText(
        workspace.name,
        input.t("quickAccess.type.workspace"),
        ...content.names,
        ownerName
      ),
      subtitle: owner
        ? input.t("quickAccess.location")
          .replace("{window}", ownerName)
          .replace("{tab}", owner.tab.name)
        : formatWorkspaceContentSummary(content, input.t),
      workspace
    };
  });

  const gameWindows: QuickAccessItem[] = input.gameWindows.map((gameWindow) => {
    const ref = { kind: "gameWindow", id: gameWindow.id } as const;
    const liveWindow = input.runtime.windows.find((window) => window.windowId === gameWindow.id);
    const tabNames = gameWindow.tabs.map((tab) => tab.name);
    return {
      active: Boolean(liveWindow),
      disabled: savedStateById.get(gameWindow.id) === "restoring",
      gameWindow,
      group: "results",
      key: quickAccessItemKey(ref),
      kind: "gameWindow",
      label: gameWindow.name,
      pinned: pinnedKeys.has(quickAccessItemKey(ref)),
      pinnedRank: pinnedRankByKey.get(quickAccessItemKey(ref)),
      recentRank: recentRankByKey.get(quickAccessItemKey(ref)),
      ref,
      searchText: createSafeSearchText(
        gameWindow.name,
        input.t("quickAccess.type.gameWindow"),
        ...tabNames
      ),
      subtitle: liveWindow
        ? input.t(liveWindow.visible ? "quickAccess.window.visible" : "quickAccess.window.hidden")
        : input.t(savedStateById.get(gameWindow.id) === "dormant"
          ? "quickAccess.window.saved"
          : "quickAccess.window.notOpen")
    };
  });

  const macros: QuickAccessItem[] = input.macros.map((macro) => {
    const ref = { kind: "macro", id: macro.id } as const;
    const runState = createMacroListRunActionState({
      busyMacroIds: input.busyMacroIds,
      busyRunKeys: input.busyRunKeys,
      hasUnassignedDependency: Boolean(findUnassignedMacroDependency([...input.macros], macro.id)),
      macro,
      macroStatusByRun: input.macroStatusByRun,
      runtimeInputAvailable: input.runtimeInputAvailable ?? true,
      statusByRole: input.statusByRole
    });
    const roleNames = macro.roleIds
      .map((roleId) => roleById.get(roleId)?.name)
      .filter((name): name is string => Boolean(name));
    const active = runState.isRunning || runState.isStopping;
    return {
      active,
      disabled: active ? false : !runState.canStart,
      group: "results",
      key: quickAccessItemKey(ref),
      kind: "macro",
      label: macro.name,
      macro,
      pinned: pinnedKeys.has(quickAccessItemKey(ref)),
      pinnedRank: pinnedRankByKey.get(quickAccessItemKey(ref)),
      recentRank: recentRankByKey.get(quickAccessItemKey(ref)),
      ref,
      searchText: createSafeSearchText(
        macro.name,
        input.t("quickAccess.type.macro"),
        ...roleNames
      ),
      subtitle: input.t(active
        ? "quickAccess.macro.running"
        : runState.canStart
          ? "quickAccess.macro.ready"
          : "quickAccess.macro.unavailable")
    };
  });

  const routes: QuickAccessItem[] = ROUTES.map(({ id, path }) => {
    const label = input.t(ROUTE_LABEL_KEYS[id]);
    return {
      active: false,
      disabled: false,
      group: "pages",
      key: `route:${id}`,
      kind: "route",
      label,
      path,
      pinned: false,
      routeId: id,
      searchText: createSafeSearchText(label, input.t("quickAccess.type.page")),
      subtitle: input.t("quickAccess.type.page")
    };
  });

  return [...roles, ...workspaces, ...gameWindows, ...macros, ...routes];
}

export function filterQuickAccessItems(
  catalog: readonly QuickAccessItem[],
  query: string,
  limit = 50
): QuickAccessItem[] {
  const normalizedQuery = normalizeQuickAccessSearch(query);
  if (!normalizedQuery) {
    const pinned = catalog.filter((item) => item.kind !== "route" && item.pinned)
      .sort((left, right) => (left.pinnedRank ?? Infinity) - (right.pinnedRank ?? Infinity));
    const pinnedKeys = new Set(pinned.map((item) => item.key));
    const recent = catalog
      .filter((item) => item.kind !== "route" && item.recentRank !== undefined && !pinnedKeys.has(item.key))
      .sort((left, right) => (left.recentRank ?? Infinity) - (right.recentRank ?? Infinity));
    const pages = catalog.filter((item) => item.kind === "route");
    return [
      ...pinned.map((item) => ({ ...item, group: "pinned" as const })),
      ...recent.map((item) => ({ ...item, group: "recent" as const })),
      ...pages
    ].slice(0, limit);
  }

  return catalog
    .flatMap((item) => {
      const score = quickAccessMatchScore(item.searchText, normalizedQuery);
      return score === undefined ? [] : [{ item, score }];
    })
    .sort((left, right) =>
      left.score - right.score ||
      Number(right.item.pinned) - Number(left.item.pinned) ||
      Number(right.item.active) - Number(left.item.active) ||
      (left.item.recentRank ?? Infinity) - (right.item.recentRank ?? Infinity) ||
      left.item.label.localeCompare(right.item.label)
    )
    .slice(0, limit)
    .map(({ item }) => ({ ...item, group: "results" }));
}

function createSafeSearchText(...values: string[]): string {
  return normalizeQuickAccessSearch(values.filter(Boolean).join(" "));
}

function quickAccessMatchScore(searchText: string, query: string): number | undefined {
  if (searchText === query) return 0;
  if (searchText.startsWith(query)) return 1;
  if (searchText.split(" ").some((token) => token.startsWith(query))) return 2;
  if (searchText.includes(query)) return 3;
  return undefined;
}

function findRuntimeOwner(runtime: EmbeddedRuntimeState, ref: QuickAccessItemRef) {
  if (ref.kind !== "role" && ref.kind !== "workspace") return undefined;
  const tab = runtime.tabs.find((candidate) => ref.kind === "workspace"
    ? candidate.type === "workspace" && candidate.sourceId === ref.id
    : (candidate.type === "role" && candidate.sourceId === ref.id) || candidate.roleIds.includes(ref.id));
  return tab ? { tab, windowId: tab.windowId } : undefined;
}
