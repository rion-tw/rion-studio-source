import {
  Eye,
  EyeOff,
  Monitor,
  MoreHorizontal,
  PanelsTopLeft,
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
  PixelBounds
} from "../../../../shared/types";
import { EmptyState } from "../../components/EmptyState";
import { useConfirmation } from "../../components/confirmation";
import { SelectionActionBar, SelectionGroupOutlines, SelectionMarquee } from "../../components/ListSelection";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useBusyIds } from "../../hooks/useBusyIds";
import { useListSelection } from "../../hooks/useListSelection";
import type { Translator } from "../../i18n";

const windowBusyKey = (windowId: string): string => `window:${windowId}`;
const newWindowBusyKey = "window:new";

interface GameWindowsRouteProps {
  displays: DisplayInfo[];
  gameWindows: GameWindow[];
  runtime: EmbeddedRuntimeState;
  t: Translator;
  onError: (error: unknown) => void;
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
  const displayById = useMemo(() => new Map(displays.map((display) => [display.id, display])), [displays]);
  const gameWindowIds = useMemo(() => gameWindows.map((gameWindow) => gameWindow.id), [gameWindows]);
  const liveWindowById = useMemo(
    () => new Map(runtime.windows.map((window) => [window.windowId, window])),
    [runtime.windows]
  );
  const failedWindowIds = useMemo(
    () => new Set(runtime.savedWindows?.filter((window) => window.state === "failed").map((window) => window.id)),
    [runtime.savedWindows]
  );
  const selection = useListSelection({
    orderedIds: gameWindowIds,
    scrollContainerRef: pageRef
  });
  const selectedGameWindows = gameWindows.filter((gameWindow) => selection.selectedIds.has(gameWindow.id));
  const selectedLiveWindows = selectedGameWindows.filter((gameWindow) => liveWindowById.has(gameWindow.id));
  const selectedStoppableWindows = selectedGameWindows.filter((gameWindow) => gameWindow.tabs.length > 0);
  const isSelectionBusy = selectedGameWindows.some((gameWindow) => busyIds.has(windowBusyKey(gameWindow.id)));
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
          <Button className="page-header-control" disabled={!primaryDisplay || busyIds.has(newWindowBusyKey)} type="button" onClick={create}>
            <Plus size={16} />
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
        <Surface className="game-window-list-surface w-full overflow-hidden" variant="panel">
          <div ref={setGameWindowListScrollContainer} className="relative overflow-x-auto">
            <table className="game-window-list-table w-full min-w-[640px] table-fixed border-collapse text-left">
              <caption className="sr-only">{t("gameWindows.title")}</caption>
              <colgroup>
                <col className="w-[31%]" />
                <col className="w-[18%]" />
                <col className="w-[25%]" />
                <col className="w-[10%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead className="glass-divider border-b text-caption uppercase tracking-normal text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 font-semibold" scope="col">{t("gameWindows.column.window")}</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">{t("gameWindows.column.status")}</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">{t("gameWindows.column.display")}</th>
                  <th className="px-3 py-2.5 text-right font-semibold" scope="col">{t("gameWindows.column.tabs")}</th>
                  <th className="px-3 py-2.5 text-right font-semibold" scope="col">{t("gameWindows.column.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/45 text-body">
                {gameWindows.map((gameWindow) => {
                  const windowIsBusy = busyIds.has(windowBusyKey(gameWindow.id));
                  const liveWindow = liveWindowById.get(gameWindow.id);
                  const activeTab = gameWindow.tabs.find((tab) => tab.id === gameWindow.activeTabId);
                  const display = displayById.get(gameWindow.targetDisplay.id);
                  const failed = failedWindowIds.has(gameWindow.id);
                  const stateLabel = failed
                    ? t("gameWindows.state.failed")
                    : runtime.recovery
                      ? t("gameWindows.state.restoring")
                      : gameWindow.tabs.length === 0
                        ? t("gameWindows.state.empty")
                        : liveWindow?.visible
                          ? t("gameWindows.state.open")
                          : t("gameWindows.state.hidden");
                  return (
                    <tr
                      key={gameWindow.id}
                      ref={selection.registerItem(gameWindow.id)}
                      className="group align-middle"
                      data-selection-id={gameWindow.id}
                      onClickCapture={(event) => selection.handleItemClick(event, gameWindow.id)}
                    >
                      <td className="px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground">{gameWindow.name}</p>
                          {activeTab ? (
                            <p className="mt-0.5 truncate text-control text-muted-foreground">
                              {t("gameWindows.activeTab").replace("{name}", activeTab.name)}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">{stateLabel}</Badge>
                          <span className="truncate text-control text-muted-foreground">
                            {t(`gameWindows.presentation.${gameWindow.placement.presentation}`)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Select
                          disabled={windowIsBusy}
                          value={display ? String(display.id) : "unavailable"}
                          onValueChange={(value) => changeDisplay(gameWindow, value)}
                        >
                          <SelectTrigger aria-label={t("gameWindows.targetDisplay")} className="w-full">
                            <Monitor size={15} />
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {!display ? <SelectItem disabled value="unavailable">{t("gameWindows.displayUnavailable")}</SelectItem> : null}
                            {displays.map((candidate) => (
                              <SelectItem key={candidate.id} value={String(candidate.id)}>
                                {candidate.label}{candidate.isPrimary ? ` · ${t("gameWindows.primaryDisplay")}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2.5 text-right text-control text-muted-foreground">
                        {t("gameWindows.tabCount").replace("{count}", String(gameWindow.tabs.length))}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            disabled={windowIsBusy}
                            size="sm"
                            type="button"
                            onClick={() => void runWindow(gameWindow.id, () => window.rionStudio.showGameWindow(gameWindow.id))}
                          >
                            <Eye size={15} />
                            {t("gameWindows.show")}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button aria-label={t("gameWindows.actions")} disabled={windowIsBusy} size="icon" type="button" variant="outline">
                                <MoreHorizontal size={16} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      <SelectionGroupOutlines
        container={gameWindowListScrollContainer}
        orderedIds={gameWindowIds}
        selectedIds={selection.selectedIds}
      />
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
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
