import { Check, Monitor, Save } from "lucide-react";
import { type FormEvent, type JSX, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import type {
  DisplayInfo,
  DisplayTarget,
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  GameWindowPlacement,
  GameWindowTab,
  LaunchWorkspace,
  PixelBounds,
  Role
} from "../../../../shared/types";
import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { FormField, Surface } from "../../components/ui/patterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import { GameWindowContentPicker } from "./GameWindowContentPicker";
import { GameWindowSavedTabsEditor } from "./GameWindowSavedTabsEditor";

interface GameWindowEditorRouteProps {
  displays: DisplayInfo[];
  gameWindows: GameWindow[];
  games: Game[];
  isSaving: boolean;
  onError: (error: unknown) => void;
  roles: Role[];
  runtime: EmbeddedRuntimeState;
  t: Translator;
  workspaces: LaunchWorkspace[];
  onSave: (input: {
    id?: string;
    name: string;
    targetDisplay: DisplayTarget;
    placement: GameWindowPlacement;
    tabs: GameWindowTab[];
    activeTabId?: string;
  }) => Promise<GameWindow | undefined>;
}

export default function GameWindowEditorRoute(props: GameWindowEditorRouteProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const selected = id ? props.gameWindows.find((item) => item.id === id) : undefined;
  if (id && !selected) {
    return (
      <EditorNotFound
        title={props.t("editor.notFound.title")}
        description={props.t("gameWindows.notFound")}
        actionLabel={props.t("gameWindows.back")}
        onAction={() => navigate("/game-windows", { replace: true })}
      />
    );
  }
  const primary = props.displays.find((display) => display.isPrimary) ?? props.displays[0];
  const initial = selected
    ? {
        id: selected.id,
        name: selected.name,
        targetDisplay: selected.targetDisplay,
        placement: selected.placement,
        tabs: selected.tabs,
        activeTabId: selected.activeTabId
      }
    : primary
      ? createNewForm(props.gameWindows, primary, props.t)
      : undefined;
  if (!initial) {
    return (
      <EditorNotFound
        title={props.t("gameWindows.displayUnavailable")}
        description={props.t("gameWindows.noDisplays")}
        actionLabel={props.t("gameWindows.back")}
        onAction={() => navigate("/game-windows", { replace: true })}
      />
    );
  }
  return <GameWindowEditor key={id ?? "new"} {...props} initial={initial} selected={selected} />;
}

function GameWindowEditor({
  displays,
  initial,
  isSaving,
  onError,
  roles,
  runtime,
  t,
  onSave,
  selected,
  games,
  gameWindows,
  workspaces
}: GameWindowEditorRouteProps & {
  initial: {
    id?: string;
    name: string;
    targetDisplay: DisplayTarget;
    placement: GameWindowPlacement;
    tabs: GameWindowTab[];
    activeTabId?: string;
  };
  selected?: GameWindow;
}): JSX.Element {
  const navigate = useNavigate();
  const initialRef = useRef(initial);
  const [form, setForm] = useState(initial);
  const [addOpen, setAddOpen] = useState(false);
  const isDirty = JSON.stringify(initialRef.current) !== JSON.stringify(form);
  const allowNavigation = useUnsavedChangesGuard(isDirty, useMemo(() => ({
    title: t("confirm.unsaved.title"),
    description: t("confirm.unsaved.description"),
    cancelLabel: t("confirm.unsaved.continue"),
    confirmLabel: t("confirm.unsaved.discard"),
    tone: "destructive" as const
  }), [t]), isSaving);
  const targetAvailable = displays.some((display) => display.id === form.targetDisplay.id);
  const live = selected && runtime.windows.some((window) => window.windowId === selected.id);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const saved = await onSave(form);
    if (saved) {
      allowNavigation();
      navigate(form.id ? "/game-windows" : `/game-windows/${saved.id}/edit`, { replace: true });
    }
  }

  return (
    <EditorPage
      backActionLabel={t("editor.back")}
      backLabel={t("gameWindows.back")}
      canSubmit={form.name.trim().length > 0 && targetAvailable}
      description={form.id ? t("gameWindows.form.editDescription") : t("gameWindows.form.newDescription")}
      isSaving={isSaving}
      onCancel={() => navigate("/game-windows", { replace: true })}
      onSubmit={(event) => void submit(event)}
      onTitleChange={(name) => setForm((current) => ({ ...current, name }))}
      saveIcon={form.id ? <Save size={16} /> : <Check size={16} />}
      saveLabel={form.id ? t("gameWindows.form.save") : t("gameWindows.form.create")}
      title={form.name}
      titleAriaLabel={t("gameWindows.form.name")}
      titlePlaceholder={t("gameWindows.form.namePlaceholder")}
    >
      <Surface className="grid gap-4 p-4" variant="inset">
        <FormField
          htmlFor="game-window-display"
          label={t("gameWindows.form.display")}
          description={t("gameWindows.form.displayDescription")}
        >
          <Select
            value={targetAvailable ? String(form.targetDisplay.id) : "unavailable"}
            disabled={isSaving}
            onValueChange={(value) => {
              const display = displays.find((item) => item.id === Number(value));
              if (!display) return;
              setForm((current) => ({
                ...current,
                targetDisplay: displayTarget(display),
                placement: {
                  ...current.placement,
                  normalBounds: mapBounds(
                    current.placement.normalBounds,
                    current.placement.savedWorkArea,
                    display.workArea
                  ),
                  savedWorkArea: display.workArea
                }
              }));
            }}
          >
            <SelectTrigger id="game-window-display">
              <Monitor size={15} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!targetAvailable ? (
                <SelectItem value="unavailable" disabled>{t("gameWindows.displayUnavailable")}</SelectItem>
              ) : null}
              {displays.map((display) => (
                <SelectItem key={display.id} value={String(display.id)}>
                  {display.label}{display.isPrimary ? ` · ${t("gameWindows.primaryDisplay")}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </Surface>
      {selected ? (
        <Surface className="p-4">
          {live ? (
            <p className="mb-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-caption text-muted-foreground">
              {t("gameWindows.tabs.liveConfigNotice")}
            </p>
          ) : null}
          <GameWindowSavedTabsEditor
            tabs={form.tabs}
            t={t}
            onAdd={() => setAddOpen(true)}
            onChange={(tabs) => setForm((current) => ({
              ...current,
              tabs,
              activeTabId: current.activeTabId && tabs.some((tab) => tab.id === current.activeTabId)
                ? current.activeTabId
                : tabs.find((tab) => !tab.hidden)?.id
            }))}
          />
        </Surface>
      ) : (
        <Surface className="grid min-h-28 place-items-center px-4 py-5 text-center" variant="inset">
          <div>
            <p className="text-control font-semibold">{t("gameWindows.tabs.createFirstTitle")}</p>
            <p className="mt-1 text-caption text-muted-foreground">{t("gameWindows.tabs.createFirstDescription")}</p>
          </div>
        </Surface>
      )}
      {selected && addOpen ? (
        <GameWindowContentPicker
          gameWindows={gameWindows}
          games={games}
          open
          mode="saved"
          roles={roles}
          runtime={runtime}
          t={t}
          targetWindow={{ ...selected, tabs: form.tabs, activeTabId: form.activeTabId }}
          workspaces={workspaces}
          onAddSavedTab={(tab) => setForm((current) => ({
            ...current,
            tabs: [...current.tabs, tab],
            activeTabId: current.activeTabId ?? tab.id
          }))}
          onClose={() => setAddOpen(false)}
          onError={onError}
        />
      ) : null}
    </EditorPage>
  );
}

function createNewForm(gameWindows: GameWindow[], display: DisplayInfo, t: Translator) {
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
      presentation: "normal" as const
    },
    tabs: []
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
