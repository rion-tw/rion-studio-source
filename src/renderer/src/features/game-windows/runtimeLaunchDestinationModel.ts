import type { Translator } from "../../i18n";
import type {
  EmbeddedRuntimeState,
  GameWindow,
  RuntimeLaunchDestination,
  SavedGameWindowState
} from "../../../../shared/types";

export interface RuntimeLaunchSource {
  id: string;
  type: "role" | "workspace";
}

export interface RuntimeLaunchDestinationOption {
  destination: RuntimeLaunchDestination;
  detail: string;
  disabled: boolean;
  id: string;
  label: string;
}

export interface RuntimeLaunchDestinationModel {
  live: RuntimeLaunchDestinationOption[];
  saved: RuntimeLaunchDestinationOption[];
  sourceOwnerWindowId?: string;
}

export function automaticRuntimeLaunchTitle(
  gameWindows: readonly GameWindow[],
  runtime: EmbeddedRuntimeState,
  source: RuntimeLaunchSource,
  t: Translator
): string {
  const model = createRuntimeLaunchDestinationModel(gameWindows, runtime, source, t);
  if (model.sourceOwnerWindowId) {
    return t("launchDestination.primary.existing").replace(
      "{window}",
      runtimeWindowLabel(model.sourceOwnerWindowId, gameWindows, runtime, t)
    );
  }
  if (runtime.windows.length === 0) {
    return t("launchDestination.primary.new");
  }
  if (runtime.windows.length === 1) {
    return t("launchDestination.primary.only").replace(
      "{window}",
      runtimeWindowLabel(runtime.windows[0].windowId, gameWindows, runtime, t)
    );
  }
  return t("launchDestination.primary.recent");
}

export function createRuntimeLaunchDestinationModel(
  gameWindows: readonly GameWindow[],
  runtime: EmbeddedRuntimeState,
  source: RuntimeLaunchSource,
  t: Translator
): RuntimeLaunchDestinationModel {
  const sourceTab = runtime.tabs.find((tab) => runtimeTabContainsSource(tab, source));
  const sourceOwnerWindowId = sourceTab?.windowId;
  const liveWindowIds = new Set(runtime.windows.map((window) => window.windowId));
  const savedWindowStateById = new Map(
    (runtime.savedWindows ?? []).map((window) => [window.id, window.state])
  );

  const live = runtime.windows.map((window) => ({
    destination: { kind: "game-window", windowId: window.windowId } as const,
    detail: t("launchDestination.state.running"),
    disabled: false,
    id: `live:${window.windowId}`,
    label: runtimeWindowLabel(window.windowId, gameWindows, runtime, t)
  }));

  const saved = gameWindows
    .filter((window) => !liveWindowIds.has(window.id))
    .map((window) => {
      const state = savedWindowStateById.get(window.id);
      const isEmpty = window.tabs.length === 0;
      return {
        destination: { kind: "game-window", windowId: window.id } as const,
        detail: savedWindowDetail(state, isEmpty, t),
        disabled: !isEmpty && state !== "dormant",
        id: `saved:${window.id}`,
        label: window.name
      };
    });

  return { live, saved, sourceOwnerWindowId };
}

function runtimeTabContainsSource(
  tab: EmbeddedRuntimeState["tabs"][number],
  source: RuntimeLaunchSource
): boolean {
  if (source.type === "workspace") {
    return tab.type === "workspace" && tab.sourceId === source.id;
  }
  return (tab.type === "role" && tab.sourceId === source.id) || tab.roleIds.includes(source.id);
}

function runtimeWindowLabel(
  windowId: string,
  gameWindows: readonly GameWindow[],
  runtime: EmbeddedRuntimeState,
  t: Translator
): string {
  const savedName = gameWindows.find((window) => window.id === windowId)?.name.trim();
  if (savedName) {
    return savedName;
  }
  const liveWindow = runtime.windows.find((window) => window.windowId === windowId);
  const activeTab = runtime.tabs.find((tab) => tab.id === liveWindow?.activeTabId);
  if (activeTab?.name.trim()) {
    return t("launchDestination.temporaryWindow.named").replace("{name}", activeTab.name);
  }
  return t("launchDestination.temporaryWindow");
}

function savedWindowDetail(
  state: SavedGameWindowState | undefined,
  isEmpty: boolean,
  t: Translator
): string {
  if (isEmpty) {
    return t("launchDestination.state.empty");
  }
  switch (state) {
    case "dormant":
      return t("launchDestination.state.saved");
    case "awaiting-recovery":
      return t("launchDestination.state.awaitingRecovery");
    case "restoring":
      return t("launchDestination.state.restoring");
    case "failed":
      return t("launchDestination.state.failed");
    default:
      return t("launchDestination.state.unavailable");
  }
}
