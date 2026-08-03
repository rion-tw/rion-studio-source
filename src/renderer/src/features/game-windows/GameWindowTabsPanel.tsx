import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { type JSX } from "react";

import type { EmbeddedRuntimeState, GameWindow, GameWindowTab } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import { useBusyIds } from "../../hooks/useBusyIds";
import type { Translator } from "../../i18n";

const tabBusyKey = (tabId: string): string => `tab:${tabId}`;
const windowBusyKey = (windowId: string): string => `window:${windowId}`;

interface GameWindowTabsPanelProps {
  className?: string;
  gameWindow: GameWindow;
  onAdd: () => void;
  onError: (error: unknown) => void;
  runtime: EmbeddedRuntimeState;
  showHeader?: boolean;
  t: Translator;
}

export function GameWindowTabsPanel({
  className,
  gameWindow,
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
          {gameWindow.tabs.map((tab, index) => (
            <GameWindowTabRow
              key={tab.id}
              busy={busyIds.has(windowBusyKey(gameWindow.id)) || busyIds.has(tabBusyKey(tab.id))}
              index={index}
              runtime={runtime}
              tab={tab}
              tabs={gameWindow.tabs}
              t={t}
              onInvoke={(action) => void run([
                tabBusyKey(tab.id),
                windowBusyKey(gameWindow.id)
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
  index,
  onInvoke,
  runtime,
  tab,
  tabs,
  t
}: {
  busy: boolean;
  index: number;
  onInvoke: (action: () => Promise<unknown>) => void;
  runtime: EmbeddedRuntimeState;
  tab: GameWindowTab;
  tabs: GameWindowTab[];
  t: Translator;
}): JSX.Element {
  const live = runtime.tabs.find((item) => item.id === tab.id);
  const canMove = !busy && Boolean(live);
  const beforeTabIdForMoveDown = tabs[index + 2]?.id;

  return (
    <Surface className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5" variant="inset">
      <button
        className="min-w-0 text-left disabled:cursor-default"
        disabled={busy || !live}
        type="button"
        onClick={() => onInvoke(() => window.rionStudio.showGameWindowTab(tab.id))}
      >
        <span className="block truncate text-body font-medium">{tab.name}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {tab.tabType === "workspace" ? t("gameWindows.tab.workspace") : t("gameWindows.tab.role")}
          {tab.roleIds.length > 1 ? ` · ${t("gameWindows.add.roleCount").replace("{count}", String(tab.roleIds.length))}` : ""}
          {!live ? ` · ${t("gameWindows.tabs.saved")}` : ""}
        </span>
      </button>
      <div className="flex items-center gap-0.5">
        <Button
          aria-label={t("gameWindows.tabs.moveUp")}
          disabled={!canMove || index === 0}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onInvoke(() => window.rionStudio.reorderGameWindowTab(tab.id, tabs[index - 1]?.id))}
        >
          <ChevronUp size={15} />
        </Button>
        <Button
          aria-label={t("gameWindows.tabs.moveDown")}
          disabled={!canMove || index === tabs.length - 1}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onInvoke(() => window.rionStudio.reorderGameWindowTab(tab.id, beforeTabIdForMoveDown))}
        >
          <ChevronDown size={15} />
        </Button>
        <Button
          aria-label={t("gameWindows.tabs.close")}
          disabled={busy || !live}
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => onInvoke(() => window.rionStudio.stopGameWindowTab(tab.id))}
        >
          <Trash2 size={15} />
        </Button>
      </div>
    </Surface>
  );
}
