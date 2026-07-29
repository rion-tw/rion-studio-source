import {
  Eye,
  EyeOff,
  Monitor,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  Square,
  Trash2,
  Volume2,
  VolumeX
} from "lucide-react";
import { type JSX, useMemo } from "react";

import type {
  DisplayInfo,
  EmbeddedRuntimeState,
  GameWindow,
  GameWindowTab
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
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { useBusyIds } from "../../hooks/useBusyIds";
import type { Translator } from "../../i18n";

const windowBusyKey = (windowId: string): string => `window:${windowId}`;
const tabBusyKey = (tabId: string): string => `tab:${tabId}`;
const NEW_WINDOW_BUSY_KEY = "window:new";

interface GameWindowsRouteProps {
  displays: DisplayInfo[];
  gameWindows: GameWindow[];
  runtime: EmbeddedRuntimeState;
  t: Translator;
  onEdit: (windowId: string) => void;
  onError: (error: unknown) => void;
  onNew: () => void;
}

export default function GameWindowsRoute({
  displays,
  gameWindows,
  runtime,
  t,
  onEdit,
  onError,
  onNew
}: GameWindowsRouteProps): JSX.Element {
  const confirm = useConfirmation();
  const { beginBusyMany, busyIds } = useBusyIds();
  const displayById = useMemo(() => new Map(displays.map((display) => [display.id, display])), [displays]);

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
                    : t("gameWindows.state.closed");
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
                          onSelect={() => void runWindow(gameWindow.id, () => window.rionStudio.closeGameWindow(gameWindow.id))}
                        >
                          {t("gameWindows.close")}
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
                  {gameWindow.tabs.length === 0 ? (
                    <Surface className="px-3 py-5 text-center text-xs text-muted-foreground" variant="inset">
                      {t("gameWindows.emptyWindow")}
                    </Surface>
                  ) : (
                    <div className="grid gap-2">
                      {gameWindow.tabs.map((tab) => (
                        <GameWindowTabRow
                          key={tab.id}
                          gameWindow={gameWindow}
                          gameWindows={gameWindows}
                          runtime={runtime}
                          tab={tab}
                          t={t}
                          busy={windowIsBusy || busyIds.has(tabBusyKey(tab.id))}
                          onInvoke={(targetWindowId, action) => void run([
                            tabBusyKey(tab.id),
                            windowBusyKey(gameWindow.id),
                            ...(targetWindowId
                              ? [targetWindowId === "new" ? NEW_WINDOW_BUSY_KEY : windowBusyKey(targetWindowId)]
                              : [])
                          ], action)}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}

function GameWindowTabRow({
  gameWindow,
  gameWindows,
  runtime,
  tab,
  t,
  busy,
  onInvoke
}: {
  gameWindow: GameWindow;
  gameWindows: GameWindow[];
  runtime: EmbeddedRuntimeState;
  tab: GameWindowTab;
  t: Translator;
  busy: boolean;
  onInvoke: (targetWindowId: string | undefined, action: () => Promise<unknown>) => void;
}): JSX.Element {
  const live = runtime.tabs.find((item) => item.id === tab.id);
  const invoke = (action: () => Promise<unknown>, targetWindowId?: string): void =>
    onInvoke(targetWindowId, action);
  return (
    <Surface className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5" variant="inset">
      <button
        className="min-w-0 text-left"
        disabled={busy || !live}
        type="button"
        onClick={() => invoke(() => window.rionStudio.showGameWindowTab(tab.id))}
      >
        <span className="block truncate text-body font-medium">{tab.name}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {tab.tabType === "workspace" ? t("gameWindows.tab.workspace") : t("gameWindows.tab.role")}
          {tab.roleIds.length > 1 ? ` · ${tab.roleIds.length}` : ""}
        </span>
      </button>
      <div className="flex items-center gap-1">
        <select
          aria-label={t("gameWindows.moveTab")}
          className="glass-control h-8 max-w-40 rounded-md px-2 text-xs"
          defaultValue=""
          disabled={busy || !live}
          onChange={(event) => {
            const target = event.currentTarget.value;
            event.currentTarget.value = "";
            if (target === "new") {
              invoke(() => window.rionStudio.moveGameWindowTabToNewWindow(tab.id), "new");
            } else if (target) {
              invoke(() => window.rionStudio.moveGameWindowTab(tab.id, target), target);
            }
          }}
        >
          <option value="">{t("gameWindows.moveTab")}</option>
          <option value="new">{t("gameWindows.moveTabNew")}</option>
          {gameWindows.filter((item) => item.id !== gameWindow.id).map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <Button
          aria-label={tab.audioMuted ? t("gameWindows.unmute") : t("gameWindows.mute")}
          disabled={busy || !live}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => invoke(() => window.rionStudio.setGameWindowTabMuted(tab.id, !tab.audioMuted))}
        >
          {tab.audioMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </Button>
        <Button
          aria-label={tab.hidden ? t("gameWindows.showTab") : t("gameWindows.hideTab")}
          disabled={busy || !live}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => invoke(() => window.rionStudio.setGameWindowTabHidden(tab.id, !tab.hidden))}
        >
          {tab.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </Button>
        <Button
          aria-label={t("gameWindows.stopTab")}
          disabled={busy || !live}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => invoke(() => window.rionStudio.stopGameWindowTab(tab.id))}
        >
          <Square size={14} />
        </Button>
      </div>
    </Surface>
  );
}
