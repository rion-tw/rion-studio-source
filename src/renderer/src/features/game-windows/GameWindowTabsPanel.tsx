import {
  Eye,
  EyeOff,
  MoreHorizontal,
  Plus,
  Square,
  Volume2,
  VolumeX
} from "lucide-react";
import { type JSX } from "react";

import type { EmbeddedRuntimeState, GameWindow, GameWindowTab } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { useBusyIds } from "../../hooks/useBusyIds";

const tabBusyKey = (tabId: string): string => `tab:${tabId}`;
const windowBusyKey = (windowId: string): string => `window:${windowId}`;
const NEW_WINDOW_BUSY_KEY = "window:new";

interface GameWindowTabsPanelProps {
  className?: string;
  gameWindow: GameWindow;
  gameWindows: GameWindow[];
  onAdd: () => void;
  onError: (error: unknown) => void;
  runtime: EmbeddedRuntimeState;
  showHeader?: boolean;
  t: Translator;
}

export function GameWindowTabsPanel({
  className,
  gameWindow,
  gameWindows,
  onAdd,
  onError,
  runtime,
  showHeader = false,
  t
}: GameWindowTabsPanelProps): JSX.Element {
  const { beginBusyMany, busyIds } = useBusyIds();

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

  return (
    <section className={className}>
      {showHeader ? (
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <div>
            <h2 className="text-control font-semibold">{t("gameWindows.tabs.title")}</h2>
            <p className="text-caption text-muted-foreground">
              {t("gameWindows.tabCount").replace("{count}", String(gameWindow.tabs.length))}
            </p>
          </div>
          <Button size="sm" type="button" variant="outline" onClick={onAdd}>
            <Plus size={14} />
            {t("gameWindows.add.button")}
          </Button>
        </div>
      ) : null}

      {gameWindow.tabs.length === 0 ? (
        <Surface className="grid min-h-28 place-items-center px-4 py-5 text-center" variant="inset">
          <div>
            <p className="text-control font-medium text-muted-foreground">{t("gameWindows.emptyWindow")}</p>
            <Button className="mt-3" size="sm" type="button" variant="outline" onClick={onAdd}>
              <Plus size={14} />
              {t("gameWindows.add.button")}
            </Button>
          </div>
        </Surface>
      ) : (
        <div className="grid gap-2">
          {gameWindow.tabs.map((tab) => (
            <GameWindowTabRow
              key={tab.id}
              busy={busyIds.has(tabBusyKey(tab.id))}
              gameWindow={gameWindow}
              gameWindows={gameWindows}
              runtime={runtime}
              tab={tab}
              t={t}
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
    </section>
  );
}

function GameWindowTabRow({
  busy,
  gameWindow,
  gameWindows,
  onInvoke,
  runtime,
  tab,
  t
}: {
  busy: boolean;
  gameWindow: GameWindow;
  gameWindows: GameWindow[];
  onInvoke: (targetWindowId: string | undefined, action: () => Promise<unknown>) => void;
  runtime: EmbeddedRuntimeState;
  tab: GameWindowTab;
  t: Translator;
}): JSX.Element {
  const live = runtime.tabs.find((item) => item.id === tab.id);
  const invoke = (action: () => Promise<unknown>, targetWindowId?: string): void =>
    onInvoke(targetWindowId, action);
  return (
    <Surface className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5" variant="inset">
      <button
        className="min-w-0 text-left disabled:cursor-default"
        disabled={busy || !live}
        type="button"
        onClick={() => invoke(() => window.rionStudio.showGameWindowTab(tab.id))}
      >
        <span className="block truncate text-body font-medium">{tab.name}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {tab.tabType === "workspace" ? t("gameWindows.tab.workspace") : t("gameWindows.tab.role")}
          {tab.roleIds.length > 1 ? ` · ${t("gameWindows.add.roleCount").replace("{count}", String(tab.roleIds.length))}` : ""}
          {!live ? ` · ${t("gameWindows.tabs.saved")}` : ""}
        </span>
      </button>
      <div className="flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={t("gameWindows.moveTab")} disabled={busy || !live} size="icon" type="button" variant="ghost">
              <MoreHorizontal size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => invoke(() => window.rionStudio.moveGameWindowTabToNewWindow(tab.id), "new")}>
              {t("gameWindows.moveTabNew")}
            </DropdownMenuItem>
            {gameWindows.filter((item) => item.id !== gameWindow.id).map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => invoke(() => window.rionStudio.moveGameWindowTab(tab.id, item.id), item.id)}>
                {t("gameWindows.moveTabTo").replace("{name}", item.name)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
