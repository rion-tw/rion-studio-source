import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { type JSX } from "react";

import type { GameWindowTab } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";

interface GameWindowSavedTabsEditorProps {
  onAdd: () => void;
  onChange: (tabs: GameWindowTab[]) => void;
  t: Translator;
  tabs: GameWindowTab[];
}

export function GameWindowSavedTabsEditor({
  onAdd,
  onChange,
  t,
  tabs
}: GameWindowSavedTabsEditorProps): JSX.Element {
  function move(index: number, offset: -1 | 1): void {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= tabs.length) return;
    const next = [...tabs];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  }

  function remove(index: number): void {
    onChange(tabs.filter((_, candidate) => candidate !== index));
  }

  return (
    <section className="grid gap-3">
      <div className="flex items-start justify-between gap-3 px-1">
        <div>
          <h2 className="text-control font-semibold">{t("gameWindows.tabs.title")}</h2>
          <p className="text-caption text-muted-foreground">
            {t("gameWindows.tabs.editDescription")}
          </p>
        </div>
        <Button size="sm" type="button" variant="outline" onClick={onAdd}>
          <Plus size={14} />
          {t("gameWindows.add.button")}
        </Button>
      </div>

      {tabs.length === 0 ? (
        <Surface className="grid min-h-28 place-items-center px-4 py-5 text-center" variant="inset">
          <div>
            <p className="text-control font-medium text-muted-foreground">
              {t("gameWindows.emptyWindow")}
            </p>
            <Button className="mt-3" size="sm" type="button" variant="outline" onClick={onAdd}>
              <Plus size={14} />
              {t("gameWindows.add.button")}
            </Button>
          </div>
        </Surface>
      ) : (
        <div className="grid gap-2">
          {tabs.map((tab, index) => (
            <Surface
              key={tab.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5"
              variant="inset"
            >
              <div className="min-w-0">
                <p className="truncate text-body font-medium">{tab.name}</p>
                <p className="truncate text-caption text-muted-foreground">
                  {tab.tabType === "workspace"
                    ? t("gameWindows.tab.workspace")
                    : t("gameWindows.tab.role")}
                  {tab.roleIds.length > 1
                    ? ` · ${t("gameWindows.add.roleCount").replace("{count}", String(tab.roleIds.length))}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  aria-label={t("gameWindows.tabs.moveUp")}
                  disabled={index === 0}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp size={15} />
                </Button>
                <Button
                  aria-label={t("gameWindows.tabs.moveDown")}
                  disabled={index === tabs.length - 1}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown size={15} />
                </Button>
                <Button
                  aria-label={t("gameWindows.tabs.remove")}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => remove(index)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </section>
  );
}
