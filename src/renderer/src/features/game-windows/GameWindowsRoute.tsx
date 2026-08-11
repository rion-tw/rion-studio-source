import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Monitor,
  MoreHorizontal,
  PanelsTopLeft,
  Pencil,
  Plus,
  Square,
  Trash2
} from "lucide-react";
import { type JSX, useMemo, useRef, useState } from "react";

import type {
  CreateGameWindowInput,
  DisplayInfo,
  DisplayTarget,
  EmbeddedRuntimeState,
  GameWindow,
  PixelBounds,
  SavedEmbeddedRuntimeWindowSummary
} from "../../../../shared/types";
import { EmptyState } from "../../components/EmptyState";
import { useConfirmation } from "../../components/confirmation";
import { SelectionActionBar, SelectionGroupOutlines, SelectionMarquee } from "../../components/ListSelection";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "../../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { useBusyIds } from "../../hooks/useBusyIds";
import { useListSelection } from "../../hooks/useListSelection";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import { RenameGameWindowDialog } from "./RenameGameWindowDialog";

const windowBusyKey = (windowId: string): string => `window:${windowId}`;
const newWindowBusyKey = "window:new";

type GameWindowListSortKey = "name" | "status" | "display" | "active" | "tabs";
type GameWindowListSortDirection = "asc" | "desc";

interface GameWindowListSortState {
  direction: GameWindowListSortDirection;
  key: GameWindowListSortKey;
}

type GameWindowRuntimeStateKind =
  | "awaitingRecovery"
  | "restoring"
  | "restoreFailed"
  | "visible"
  | "hidden"
  | "notOpen";

interface GameWindowRuntimeState {
  badgeVariant: "activity" | "destructive" | "muted" | "success" | "warning";
  kind: GameWindowRuntimeStateKind;
  label: string;
}

const DEFAULT_GAME_WINDOW_LIST_SORT: GameWindowListSortState = {
  direction: "asc",
  key: "name"
};

interface GameWindowsRouteProps {
  displays: DisplayInfo[];
  gameWindows: GameWindow[];
  runtime: EmbeddedRuntimeState;
  t: Translator;
  onError: (error: unknown) => void;
}

function GameWindowSortHeader({
  label,
  onSort,
  sort,
  sortKey,
  t
}: {
  label: string;
  onSort: (key: GameWindowListSortKey) => void;
  sort: GameWindowListSortState;
  sortKey: GameWindowListSortKey;
  t: Translator;
}): JSX.Element {
  const isActive = sort.key === sortKey;
  const DirectionIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const directionLabel = t(sort.direction === "asc" ? "gameWindows.sortAscending" : "gameWindows.sortDescending");

  return (
    <th
      className="px-4 py-1"
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        className="-mx-1 inline-flex h-[var(--control-height)] max-w-full items-center gap-1 rounded-sm px-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
        type="button"
        title={t("gameWindows.sortBy").replace("{column}", label)}
        onClick={() => onSort(sortKey)}
      >
        <span className="min-w-0 truncate">{label}</span>
        {isActive ? (
          <>
            <DirectionIcon aria-hidden="true" className="shrink-0" size={12} />
            <span className="sr-only">{directionLabel}</span>
          </>
        ) : null}
      </button>
    </th>
  );
}

export default function GameWindowsRoute({
  displays,
  gameWindows,
  runtime,
  t,
  onError
}: GameWindowsRouteProps): JSX.Element {
  const confirm = useConfirmation();
  const { beginBusyMany, busyIds } = useBusyIds();
  const pageRef = useRef<HTMLElement | null>(null);
  const [gameWindowListScrollContainer, setGameWindowListScrollContainer] = useState<HTMLDivElement | null>(null);
  const [renameTarget, setRenameTarget] = useState<GameWindow | null>(null);
  const [sort, setSort] = useState<GameWindowListSortState>(DEFAULT_GAME_WINDOW_LIST_SORT);
  const displayById = useMemo(() => new Map(displays.map((display) => [display.id, display])), [displays]);
  const liveWindowById = useMemo(
    () => new Map(runtime.windows.map((window) => [window.windowId, window])),
    [runtime.windows]
  );
  const savedWindowById = useMemo(
    () => new Map(runtime.savedWindows?.map((window) => [window.id, window]) ?? []),
    [runtime.savedWindows]
  );
  const stateByWindowId = useMemo(
    () => new Map(gameWindows.map((gameWindow) => [
      gameWindow.id,
      getGameWindowRuntimeState(liveWindowById.get(gameWindow.id), savedWindowById.get(gameWindow.id), t)
    ])),
    [gameWindows, liveWindowById, savedWindowById, t]
  );
  const stateLabelByWindowId = useMemo(
    () => new Map(Array.from(stateByWindowId, ([windowId, state]) => [windowId, state.label])),
    [stateByWindowId]
  );
  const sortedGameWindows = useMemo(
    () => sortGameWindows(gameWindows, sort, displayById, stateLabelByWindowId, t),
    [displayById, gameWindows, sort, stateLabelByWindowId, t]
  );
  const gameWindowIds = useMemo(() => sortedGameWindows.map((gameWindow) => gameWindow.id), [sortedGameWindows]);
  const selection = useListSelection({
    orderedIds: gameWindowIds,
    scrollContainerRef: pageRef
  });
  const selectedGameWindows = gameWindows.filter((gameWindow) => selection.selectedIds.has(gameWindow.id));
  const selectedLiveWindows = selectedGameWindows.filter((gameWindow) => liveWindowById.has(gameWindow.id));
  const selectedStoppableWindows = selectedGameWindows.filter((gameWindow) => gameWindow.tabs.length > 0);
  const isSelectionBusy = selectedGameWindows.some((gameWindow) =>
    busyIds.has(windowBusyKey(gameWindow.id))
      || stateByWindowId.get(gameWindow.id)?.kind === "restoring"
  );
  const primaryDisplay = displays.find((display) => display.isPrimary) ?? displays[0];

  async function run(ids: Iterable<string>, action: () => Promise<unknown>): Promise<boolean> {
    const finishBusy = beginBusyMany(ids);
    if (!finishBusy) return false;
    try {
      await action();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      finishBusy();
    }
  }

  const runWindow = (windowId: string, action: () => Promise<unknown>): Promise<boolean> =>
    run([windowBusyKey(windowId)], action);

  const runWindows = (
    windows: readonly GameWindow[],
    action: (gameWindow: GameWindow) => Promise<unknown>
  ): Promise<boolean> => run(
    windows.map((gameWindow) => windowBusyKey(gameWindow.id)),
    async () => {
      for (const gameWindow of windows) {
        await action(gameWindow);
      }
    }
  );

  function create(): void {
    if (!primaryDisplay) return;
    void run([newWindowBusyKey], () => window.rionStudio.createGameWindow(
      createGameWindowInput(gameWindows, primaryDisplay, t)
    ));
  }

  function changeDisplay(gameWindow: GameWindow, nextDisplayId: string): void {
    const nextDisplay = displayById.get(Number(nextDisplayId));
    if (!nextDisplay || nextDisplay.id === gameWindow.targetDisplay.id) return;
    void runWindow(gameWindow.id, () => window.rionStudio.updateGameWindow(gameWindow.id, {
      targetDisplay: displayTarget(nextDisplay),
      placement: {
        ...gameWindow.placement,
        normalBounds: mapBounds(
          gameWindow.placement.normalBounds,
          gameWindow.placement.savedWorkArea,
          nextDisplay.workArea
        ),
        savedWorkArea: nextDisplay.workArea
      }
    }));
  }

  function rename(gameWindow: GameWindow, name: string): Promise<boolean> {
    return runWindow(gameWindow.id, () => window.rionStudio.updateGameWindow(gameWindow.id, { name }));
  }

  function handleSortChange(key: GameWindowListSortKey): void {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  }

  async function remove(gameWindow: GameWindow): Promise<void> {
    const accepted = await confirm({
      title: t("gameWindows.delete.title").replace("{name}", gameWindow.name),
      description: t("gameWindows.delete.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });
    if (accepted) {
      await runWindow(gameWindow.id, () => window.rionStudio.deleteGameWindow(gameWindow.id));
    }
  }

  async function removeSelected(): Promise<void> {
    const accepted = await confirm({
      title: t("gameWindows.deleteMany.title").replace("{count}", String(selectedGameWindows.length)),
      description: t("gameWindows.delete.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });
    if (!accepted) return;

    const completed = await runWindows(
      selectedGameWindows,
      (gameWindow) => window.rionStudio.deleteGameWindow(gameWindow.id)
    );
    if (completed) {
      selection.clearSelection();
    }
  }

  return (
    <PageFrame containerRef={pageRef} {...selection.collectionProps}>
      <PageHeader
        kicker={t("gameWindows.kicker")}
        title={t("gameWindows.title")}
        description={t("gameWindows.description")}
        actions={(
          <Button
            className="page-header-control gap-1.5 px-2.5"
            disabled={!primaryDisplay || busyIds.has(newWindowBusyKey)}
            type="button"
            variant="outline"
            onClick={create}
          >
            <Plus size={14} />
            {t("gameWindows.new")}
          </Button>
        )}
      />

      {selection.hasSelection ? (
        <SelectionActionBar
          actions={(
            <>
              <Button
                disabled={isSelectionBusy}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => void runWindows(
                  selectedGameWindows,
                  (gameWindow) => window.rionStudio.showGameWindow(gameWindow.id)
                )}
              >
                <Eye size={14} />
                {t("gameWindows.bulk.showCount").replace("{count}", String(selectedGameWindows.length))}
              </Button>
              <Button
                disabled={isSelectionBusy || selectedLiveWindows.length === 0}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => void runWindows(
                  selectedLiveWindows,
                  (gameWindow) => window.rionStudio.hideGameWindow(gameWindow.id)
                )}
              >
                <EyeOff size={14} />
                {t("gameWindows.bulk.hideCount").replace("{count}", String(selectedLiveWindows.length))}
              </Button>
              <Button
                disabled={isSelectionBusy || selectedStoppableWindows.length === 0}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => void runWindows(
                  selectedStoppableWindows,
                  (gameWindow) => window.rionStudio.stopGameWindow(gameWindow.id)
                )}
              >
                <Square size={14} />
                {t("gameWindows.bulk.stopCount").replace("{count}", String(selectedStoppableWindows.length))}
              </Button>
            </>
          )}
          isBusy={isSelectionBusy}
          selectedCount={selection.selectedIds.size}
          t={t}
          totalCount={gameWindows.length}
          onClear={selection.clearSelection}
          onDelete={() => void removeSelected()}
          onSelectAll={selection.selectAll}
        />
      ) : null}

      {gameWindows.length === 0 ? (
        <EmptyState
          icon={PanelsTopLeft}
          title={t("gameWindows.empty.title")}
          description={primaryDisplay ? t("gameWindows.empty.description") : t("gameWindows.noDisplays")}
          actionLabel={primaryDisplay ? t("gameWindows.new") : undefined}
          onAction={primaryDisplay ? create : undefined}
        />
      ) : (
        <div className="grid justify-items-start gap-2">
          <Surface className="game-window-list-surface w-full overflow-hidden" variant="panel">
            <div ref={setGameWindowListScrollContainer} className="relative overflow-auto">
              <table className="game-window-list-table w-full min-w-[900px] border-collapse text-left">
                <caption className="sr-only">{t("gameWindows.title")}</caption>
                <thead className="glass-divider border-b text-caption uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <GameWindowSortHeader
                      label={t("gameWindows.column.window")}
                      sort={sort}
                      sortKey="name"
                      t={t}
                      onSort={handleSortChange}
                    />
                    <GameWindowSortHeader
                      label={t("gameWindows.column.status")}
                      sort={sort}
                      sortKey="status"
                      t={t}
                      onSort={handleSortChange}
                    />
                    <GameWindowSortHeader
                      label={t("gameWindows.column.display")}
                      sort={sort}
                      sortKey="display"
                      t={t}
                      onSort={handleSortChange}
                    />
                    <GameWindowSortHeader
                      label={t("gameWindows.column.active")}
                      sort={sort}
                      sortKey="active"
                      t={t}
                      onSort={handleSortChange}
                    />
                    <GameWindowSortHeader
                      label={t("gameWindows.column.tabs")}
                      sort={sort}
                      sortKey="tabs"
                      t={t}
                      onSort={handleSortChange}
                    />
                    <th className="w-12 px-2 py-1" aria-label={t("gameWindows.column.actions")} scope="col" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/45 text-body">
                  {sortedGameWindows.map((gameWindow) => {
                    const state = stateByWindowId.get(gameWindow.id)!;
                    const windowIsBusy = busyIds.has(windowBusyKey(gameWindow.id)) || state.kind === "restoring";
                    const liveWindow = liveWindowById.get(gameWindow.id);
                    const activeTab = gameWindow.tabs.find((tab) => tab.id === gameWindow.activeTabId);
                    const display = displayById.get(gameWindow.targetDisplay.id);
                    const displayLabel = getGameWindowDisplayLabel(gameWindow, displayById, t);
                    return (
                      <ContextMenu key={gameWindow.id}>
                        <ContextMenuTrigger asChild>
                          <tr
                            ref={selection.registerItem(gameWindow.id)}
                            className={cn(
                              "group align-middle transition-[background-color,box-shadow,opacity]",
                              selection.isSelected(gameWindow.id) && "bg-activity/10"
                            )}
                            data-selection-id={gameWindow.id}
                            onClickCapture={(event) => selection.handleItemClick(event, gameWindow.id)}
                          >
                        <td className="relative max-w-[280px] px-4 py-2 align-middle">
                          <div className="min-w-0 pl-6">
                            <div className="absolute inset-y-0 left-4 -ml-1.5 flex items-center">
                              <Button
                                aria-label={t("gameWindows.show")}
                                className="h-5 w-5 shrink-0"
                                disabled={windowIsBusy}
                                size="icon"
                                title={t("gameWindows.show")}
                                type="button"
                                variant="ghost"
                                onClick={() => void runWindow(gameWindow.id, () => window.rionStudio.showGameWindow(gameWindow.id))}
                              >
                                <Eye size={10} />
                              </Button>
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-foreground">{gameWindow.name}</p>
                            </div>
                          </div>
                        </td>
                        <td className="max-w-[220px] px-4 py-2 align-middle">
                          <Badge variant={state.badgeVariant}>{state.label}</Badge>
                        </td>
                        <td className="max-w-[260px] px-4 py-2 align-middle">
                          <span className="inline-flex max-w-full items-center gap-1.5 text-muted-foreground" title={displayLabel}>
                            <Monitor aria-hidden="true" className="shrink-0" size={14} />
                            <span className="min-w-0 truncate">{displayLabel}</span>
                          </span>
                        </td>
                        <td className="max-w-[240px] px-4 py-2 align-middle text-muted-foreground">
                          {activeTab ? <span className="block truncate">{activeTab.name}</span> : "—"}
                        </td>
                        <td className="px-4 py-2 align-middle text-muted-foreground">
                          {t("gameWindows.tabCount").replace("{count}", String(gameWindow.tabs.length))}
                        </td>
                        <td className="relative w-12 p-0">
                          <div className="absolute inset-0 grid place-items-center px-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  aria-label={t("gameWindows.actions")}
                                  className="h-5 w-5"
                                  disabled={windowIsBusy}
                                  size="icon"
                                  title={t("gameWindows.actions")}
                                  type="button"
                                  variant="ghost"
                                >
                                  <MoreHorizontal size={10} />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger disabled={windowIsBusy}>
                                    <Monitor aria-hidden="true" className="shrink-0" size={14} />
                                    {t("gameWindows.targetDisplay")}
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent>
                                    <DropdownMenuRadioGroup
                                      value={display ? String(display.id) : ""}
                                      onValueChange={(value) => changeDisplay(gameWindow, value)}
                                    >
                                      {displays.map((candidate) => (
                                        <DropdownMenuRadioItem key={candidate.id} value={String(candidate.id)}>
                                          {candidate.label}{candidate.isPrimary ? ` · ${t("gameWindows.primaryDisplay")}` : ""}
                                        </DropdownMenuRadioItem>
                                      ))}
                                    </DropdownMenuRadioGroup>
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuItem disabled={windowIsBusy} onSelect={() => setRenameTarget(gameWindow)}>
                                  <Pencil className="mr-2" size={14} />
                                  {t("gameWindows.rename")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={windowIsBusy || !liveWindow}
                                  onSelect={() => void runWindow(gameWindow.id, () => window.rionStudio.hideGameWindow(gameWindow.id))}
                                >
                                  {t("gameWindows.hide")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={windowIsBusy || gameWindow.tabs.length === 0}
                                  onSelect={() => void runWindow(gameWindow.id, () => window.rionStudio.stopGameWindow(gameWindow.id))}
                                >
                                  {t("gameWindows.stopAll")}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive" disabled={windowIsBusy} onSelect={() => void remove(gameWindow)}>
                                  <Trash2 className="mr-2" size={14} />
                                  {t("gameWindows.delete")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                          </tr>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="min-w-44">
                          <ContextMenuSub>
                            <ContextMenuSubTrigger disabled={windowIsBusy}>
                              <Monitor aria-hidden="true" className="shrink-0" size={14} />
                              {t("gameWindows.targetDisplay")}
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              <ContextMenuRadioGroup
                                value={display ? String(display.id) : ""}
                                onValueChange={(value) => changeDisplay(gameWindow, value)}
                              >
                                {displays.map((candidate) => (
                                  <ContextMenuRadioItem key={candidate.id} value={String(candidate.id)}>
                                    {candidate.label}{candidate.isPrimary ? ` · ${t("gameWindows.primaryDisplay")}` : ""}
                                  </ContextMenuRadioItem>
                                ))}
                              </ContextMenuRadioGroup>
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                          <ContextMenuItem className="gap-2" disabled={windowIsBusy} onSelect={() => setRenameTarget(gameWindow)}>
                            <Pencil size={14} />
                            {t("gameWindows.rename")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={windowIsBusy || !liveWindow}
                            onSelect={() => void runWindow(gameWindow.id, () => window.rionStudio.hideGameWindow(gameWindow.id))}
                          >
                            {t("gameWindows.hide")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={windowIsBusy || gameWindow.tabs.length === 0}
                            onSelect={() => void runWindow(gameWindow.id, () => window.rionStudio.stopGameWindow(gameWindow.id))}
                          >
                            {t("gameWindows.stopAll")}
                          </ContextMenuItem>
                          <ContextMenuItem className="gap-2 text-destructive" disabled={windowIsBusy} onSelect={() => void remove(gameWindow)}>
                            <Trash2 size={14} />
                            {t("gameWindows.delete")}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Surface>
          <Button
            className="gap-1.5 border-dashed bg-transparent px-2.5 text-muted-foreground shadow-none hover:text-foreground"
            disabled={!primaryDisplay || busyIds.has(newWindowBusyKey)}
            type="button"
            variant="outline"
            onClick={create}
          >
            <Plus aria-hidden="true" size={14} />
            <span>{t("gameWindows.new")}</span>
          </Button>
        </div>
      )}
      <SelectionGroupOutlines
        container={gameWindowListScrollContainer}
        orderedIds={gameWindowIds}
        selectedIds={selection.selectedIds}
      />
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
      <RenameGameWindowDialog
        gameWindow={renameTarget}
        isSaving={renameTarget ? busyIds.has(windowBusyKey(renameTarget.id)) : false}
        t={t}
        onCancel={() => setRenameTarget(null)}
        onSave={(name) => renameTarget ? rename(renameTarget, name) : Promise.resolve(false)}
      />
    </PageFrame>
  );
}

function createGameWindowInput(
  gameWindows: GameWindow[],
  display: DisplayInfo,
  t: Translator
): CreateGameWindowInput {
  const existingNames = new Set(gameWindows.map((item) => item.name.toLocaleLowerCase()));
  let number = gameWindows.length + 1;
  let name = `${t("gameWindows.defaultName")} ${number}`;
  while (existingNames.has(name.toLocaleLowerCase())) {
    number += 1;
    name = `${t("gameWindows.defaultName")} ${number}`;
  }
  const width = Math.min(display.workArea.width, Math.max(Math.min(960, display.workArea.width), Math.round(display.workArea.width * 0.8)));
  const height = Math.min(display.workArea.height, Math.max(Math.min(640, display.workArea.height), Math.round(display.workArea.height * 0.8)));
  const sameDisplayCount = gameWindows.filter((item) => item.targetDisplay.id === display.id).length;
  const offset = Math.min(240, sameDisplayCount * 24);
  const centered: PixelBounds = {
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2) + offset,
    y: display.workArea.y + Math.round((display.workArea.height - height) / 2) + offset,
    width,
    height
  };
  return {
    name,
    targetDisplay: displayTarget(display),
    placement: {
      normalBounds: clampBounds(centered, display.workArea),
      savedWorkArea: display.workArea,
      presentation: "normal"
    }
  };
}

function displayTarget(display: DisplayInfo): DisplayTarget {
  return {
    id: display.id,
    fingerprint: {
      label: display.label,
      bounds: display.bounds,
      resolution: display.resolution,
      scaleFactor: display.scaleFactor,
      isPrimary: display.isPrimary,
      isInternal: display.isInternal
    }
  };
}

function mapBounds(bounds: PixelBounds, oldArea: PixelBounds, nextArea: PixelBounds): PixelBounds {
  if (oldArea.width <= 0 || oldArea.height <= 0) return clampBounds(bounds, nextArea);
  return clampBounds({
    x: nextArea.x + Math.round(((bounds.x - oldArea.x) / oldArea.width) * nextArea.width),
    y: nextArea.y + Math.round(((bounds.y - oldArea.y) / oldArea.height) * nextArea.height),
    width: Math.round((bounds.width / oldArea.width) * nextArea.width),
    height: Math.round((bounds.height / oldArea.height) * nextArea.height)
  }, nextArea);
}

function clampBounds(bounds: PixelBounds, area: PixelBounds): PixelBounds {
  const width = Math.min(area.width, Math.max(Math.min(640, area.width), bounds.width));
  const height = Math.min(area.height, Math.max(Math.min(480, area.height), bounds.height));
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(bounds.y, area.y), area.y + Math.max(0, area.height - height)),
    width,
    height
  };
}

function getGameWindowRuntimeState(
  liveWindow: { visible: boolean } | undefined,
  savedWindow: SavedEmbeddedRuntimeWindowSummary | undefined,
  t: Translator
): GameWindowRuntimeState {
  if (savedWindow?.state === "awaiting-recovery") {
    return {
      badgeVariant: "warning",
      kind: "awaitingRecovery",
      label: t("gameWindows.state.awaitingRecovery")
    };
  }
  if (savedWindow?.state === "restoring") {
    return {
      badgeVariant: "activity",
      kind: "restoring",
      label: t("gameWindows.state.restoring")
    };
  }
  if (savedWindow?.state === "failed") {
    return {
      badgeVariant: "destructive",
      kind: "restoreFailed",
      label: t("gameWindows.state.restoreFailed")
    };
  }
  if (liveWindow?.visible) {
    return {
      badgeVariant: "success",
      kind: "visible",
      label: t("gameWindows.state.visible")
    };
  }
  if (liveWindow) {
    return {
      badgeVariant: "muted",
      kind: "hidden",
      label: t("gameWindows.state.hidden")
    };
  }
  return {
    badgeVariant: "muted",
    kind: "notOpen",
    label: t("gameWindows.state.notOpen")
  };
}

function sortGameWindows(
  gameWindows: readonly GameWindow[],
  sort: GameWindowListSortState,
  displayById: ReadonlyMap<number, DisplayInfo>,
  stateLabelByWindowId: ReadonlyMap<string, string>,
  t: Translator
): GameWindow[] {
  return gameWindows
    .map((gameWindow, index) => ({ gameWindow, index }))
    .sort((first, second) => {
      const primary = compareGameWindows(first.gameWindow, second.gameWindow, sort.key, displayById, stateLabelByWindowId, t);
      if (primary !== 0) {
        return sort.direction === "asc" ? primary : -primary;
      }

      return compareText(first.gameWindow.name, second.gameWindow.name)
        || first.gameWindow.createdAt.localeCompare(second.gameWindow.createdAt)
        || first.index - second.index;
    })
    .map(({ gameWindow }) => gameWindow);
}

function compareGameWindows(
  first: GameWindow,
  second: GameWindow,
  sortKey: GameWindowListSortKey,
  displayById: ReadonlyMap<number, DisplayInfo>,
  stateLabelByWindowId: ReadonlyMap<string, string>,
  t: Translator
): number {
  switch (sortKey) {
    case "name":
      return compareText(first.name, second.name);
    case "status":
      return compareText(stateLabelByWindowId.get(first.id)!, stateLabelByWindowId.get(second.id)!);
    case "display":
      return compareText(getGameWindowDisplayLabel(first, displayById, t), getGameWindowDisplayLabel(second, displayById, t));
    case "active":
      return compareText(
        first.tabs.find((tab) => tab.id === first.activeTabId)?.name ?? "",
        second.tabs.find((tab) => tab.id === second.activeTabId)?.name ?? ""
      );
    case "tabs":
      return first.tabs.length - second.tabs.length;
  }
}

function getGameWindowDisplayLabel(
  gameWindow: GameWindow,
  displayById: ReadonlyMap<number, DisplayInfo>,
  t: Translator
): string {
  const display = displayById.get(gameWindow.targetDisplay.id);
  return display
    ? `${display.label}${display.isPrimary ? ` · ${t("gameWindows.primaryDisplay")}` : ""}`
    : t("gameWindows.displayUnavailable");
}

function compareText(first: string, second: string): number {
  return first.localeCompare(second, undefined, { numeric: true, sensitivity: "base" });
}
