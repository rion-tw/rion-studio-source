import {
  Eye,
  Monitor,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  Trash2
} from "lucide-react";
import { type JSX, useMemo, useState } from "react";

import type {
  DisplayInfo,
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  LaunchWorkspace,
  Role
} from "../../../../shared/types";
import { EmptyState } from "../../components/EmptyState";
import { useConfirmation } from "../../components/confirmation";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { PageFrame, PageHeader } from "../../components/ui/patterns";
import { useBusyIds } from "../../hooks/useBusyIds";
import type { Translator } from "../../i18n";
import { GameWindowContentPicker } from "./GameWindowContentPicker";
import { GameWindowTabsPanel } from "./GameWindowTabsPanel";

const windowBusyKey = (windowId: string): string => `window:${windowId}`;

interface GameWindowsRouteProps {
  displays: DisplayInfo[];
  gameWindows: GameWindow[];
  games: Game[];
  runtime: EmbeddedRuntimeState;
  roles: Role[];
  t: Translator;
  workspaces: LaunchWorkspace[];
  onEdit: (windowId: string) => void;
  onError: (error: unknown) => void;
  onNew: () => void;
}

export default function GameWindowsRoute({
  displays,
  gameWindows,
  games,
  runtime,
  roles,
  t,
  workspaces,
  onEdit,
  onError,
  onNew
}: GameWindowsRouteProps): JSX.Element {
  const confirm = useConfirmation();
  const { beginBusyMany, busyIds } = useBusyIds();
  const [addTargetId, setAddTargetId] = useState<string>();
  const displayById = useMemo(() => new Map(displays.map((display) => [display.id, display])), [displays]);
  const addTarget = addTargetId ? gameWindows.find((item) => item.id === addTargetId) : undefined;

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
          <Button className="page-header-control" type="button" onClick={onNew}>
            <Plus size={16} />
            {t("gameWindows.new")}
          </Button>
        )}
      />

      {gameWindows.length === 0 ? (
        <EmptyState
          icon={PanelsTopLeft}
          title={t("gameWindows.empty.title")}
          description={t("gameWindows.empty.description")}
          actionLabel={t("gameWindows.new")}
          onAction={onNew}
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
                      <Badge className="gap-1.5" variant="secondary">
                        <Monitor size={12} />
                        {display?.label ?? t("gameWindows.displayUnavailable")}
                      </Badge>
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
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      disabled={windowIsBusy}
                      type="button"
                      variant="outline"
                      onClick={() => setAddTargetId(gameWindow.id)}
                    >
                      <Plus size={15} />
                      {t("gameWindows.add.button")}
                    </Button>
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
                        <DropdownMenuItem disabled={windowIsBusy} onSelect={() => onEdit(gameWindow.id)}>
                          {t("gameWindows.edit")}
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
                </CardHeader>
                <CardContent>
                  <GameWindowTabsPanel
                    gameWindow={gameWindow}
                    gameWindows={gameWindows}
                    runtime={runtime}
                    t={t}
                    onAdd={() => setAddTargetId(gameWindow.id)}
                    onError={onError}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {addTarget ? (
        <GameWindowContentPicker
          gameWindows={gameWindows}
          games={games}
          open
          roles={roles}
          runtime={runtime}
          t={t}
          targetWindow={addTarget}
          workspaces={workspaces}
          onClose={() => setAddTargetId(undefined)}
          onError={onError}
        />
      ) : null}
    </PageFrame>
  );
}
