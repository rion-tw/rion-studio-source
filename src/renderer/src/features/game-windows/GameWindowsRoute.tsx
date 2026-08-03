import {
  Eye,
  Monitor,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  Trash2
} from "lucide-react";
import { type JSX, useMemo } from "react";

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
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader, CardTitle } from "../../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { PageFrame, PageHeader } from "../../components/ui/patterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useBusyIds } from "../../hooks/useBusyIds";
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
  const displayById = useMemo(() => new Map(displays.map((display) => [display.id, display])), [displays]);
  const primaryDisplay = displays.find((display) => display.isPrimary) ?? displays[0];

  async function run(ids: Iterable<string>, action: () => Promise<unknown>): Promise<void> {
    const finishBusy = beginBusyMany(ids);
    if (!finishBusy) return;
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      finishBusy();
    }
  }

  const runWindow = (windowId: string, action: () => Promise<unknown>): Promise<void> =>
    run([windowBusyKey(windowId)], action);

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

  return (
    <PageFrame>
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

      {gameWindows.length === 0 ? (
        <EmptyState
          icon={PanelsTopLeft}
          title={t("gameWindows.empty.title")}
          description={primaryDisplay ? t("gameWindows.empty.description") : t("gameWindows.noDisplays")}
          actionLabel={primaryDisplay ? t("gameWindows.new") : undefined}
          onAction={primaryDisplay ? create : undefined}
        />
      ) : (
        <div className="collection-grid collection-grid-game-windows gap-4">
          {gameWindows.map((gameWindow) => {
            const windowIsBusy = busyIds.has(windowBusyKey(gameWindow.id));
            const liveWindow = runtime.windows.find((item) => item.windowId === gameWindow.id);
            const activeTab = gameWindow.tabs.find((tab) => tab.id === gameWindow.activeTabId);
            const display = displayById.get(gameWindow.targetDisplay.id);
            const failed = runtime.savedWindows?.find((item) => item.id === gameWindow.id)?.state === "failed";
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
              <Card key={gameWindow.id} className="overflow-hidden">
                <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-heading">{gameWindow.name}</CardTitle>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{stateLabel}</Badge>
                      <Badge variant="secondary">{t(`gameWindows.presentation.${gameWindow.placement.presentation}`)}</Badge>
                      <Badge variant="secondary">
                        {t("gameWindows.tabCount").replace("{count}", String(gameWindow.tabs.length))}
                      </Badge>
                    </div>
                    {activeTab ? (
                      <p className="mt-2 truncate text-xs text-muted-foreground">
                        {t("gameWindows.activeTab").replace("{name}", activeTab.name)}
                      </p>
                    ) : null}
                    <div className="mt-3 flex max-w-sm items-center gap-2">
                      <span className="shrink-0 text-caption text-muted-foreground">{t("gameWindows.targetDisplay")}</span>
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
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      disabled={windowIsBusy}
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
                </CardHeader>
              </Card>
            );
          })}
        </div>
      )}
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
