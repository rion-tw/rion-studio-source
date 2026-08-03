import { BriefcaseBusiness, LayoutDashboard, Loader2, Search, Users, X } from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";

import type {
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  GameWindowTab,
  LaunchWorkspace,
  Role
} from "../../../../shared/types";
import { useConfirmation } from "../../components/confirmation";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SegmentedControl, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";

type PickerKind = "role" | "workspace";
type PickerMode = "runtime" | "saved";

interface GameWindowContentPickerProps {
  gameWindows: GameWindow[];
  games: Game[];
  mode?: PickerMode;
  onClose: () => void;
  onAddSavedTab?: (tab: GameWindowTab) => void;
  onError: (error: unknown) => void;
  open: boolean;
  roles: Role[];
  runtime: EmbeddedRuntimeState;
  t: Translator;
  targetWindow: GameWindow;
  workspaces: LaunchWorkspace[];
}

export function GameWindowContentPicker({
  gameWindows,
  games,
  mode = "runtime",
  onClose,
  onAddSavedTab,
  onError,
  open,
  roles,
  runtime,
  t,
  targetWindow,
  workspaces
}: GameWindowContentPickerProps): JSX.Element {
  const confirm = useConfirmation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busyId, setBusyId] = useState<string>();
  const [kind, setKind] = useState<PickerKind>("role");
  const [query, setQuery] = useState("");
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const gameById = useMemo(() => new Map(games.map((game) => [game.id, game])), [games]);
  const windowById = useMemo(
    () => new Map(gameWindows.map((gameWindow) => [gameWindow.id, gameWindow])),
    [gameWindows]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const savedMode = mode === "saved";
  const visibleRoles = roles.filter((role) => matchesQuery([
    role.name,
    gameById.get(role.gameId)?.name ?? ""
  ], normalizedQuery));
  const visibleWorkspaces = workspaces.filter((workspace) => matchesQuery([
    workspace.name,
    ...workspace.slots.flatMap((slot) => slot.roleId ? [roleById.get(slot.roleId)?.name ?? ""] : [])
  ], normalizedQuery));

  useEffect(() => {
    if (!open) return;
    setBusyId(undefined);
    setKind("role");
    setQuery("");
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function run(itemId: string, action: () => Promise<boolean>): Promise<void> {
    if (busyId) return;
    setBusyId(itemId);
    try {
      if (await action()) onClose();
    } catch (error) {
      onError(error);
    } finally {
      setBusyId(undefined);
    }
  }

  async function addRole(role: Role): Promise<boolean> {
    if (savedMode) {
      onAddSavedTab?.(savedRoleTab(role));
      return true;
    }
    const ownTab = runtime.tabs.find((tab) => tab.type === "role" && tab.sourceId === role.id);
    if (ownTab) {
      if (ownTab.windowId === targetWindow.id) {
        await window.rionStudio.showGameWindowTab(ownTab.id);
      } else {
        await window.rionStudio.moveGameWindowTab(ownTab.id, targetWindow.id);
      }
      return true;
    }
    await window.rionStudio.launchRole(role.id, { windowId: targetWindow.id });
    return true;
  }

  async function addWorkspace(workspace: LaunchWorkspace): Promise<boolean> {
    if (savedMode) {
      onAddSavedTab?.(savedWorkspaceTab(workspace));
      return true;
    }
    const liveTab = runtime.tabs.find((tab) => tab.type === "workspace" && tab.sourceId === workspace.id);
    if (liveTab) {
      if (liveTab.windowId === targetWindow.id) {
        await window.rionStudio.showGameWindowTab(liveTab.id);
      } else {
        await window.rionStudio.moveGameWindowTab(liveTab.id, targetWindow.id);
      }
      return true;
    }
    let result = await window.rionStudio.launchWorkspace(workspace.id, { windowId: targetWindow.id });
    if (result.kind === "conflict") {
      const conflictSummary = result.conflicts
        .map((conflict) => `${conflict.windowName}: ${conflict.roleNames.join(", ")}`)
        .join("; ");
      const accepted = await confirm({
        title: t("workspaces.launchConflict.title"),
        description: t("workspaces.launchConflict.description").replace("{conflicts}", conflictSummary),
        cancelLabel: t("confirm.cancel"),
        confirmLabel: t("workspaces.launchConflict.confirm"),
        tone: "destructive"
      });
      if (!accepted) return false;
      result = await window.rionStudio.launchWorkspace(workspace.id, {
        windowId: targetWindow.id,
        stopConflicts: true
      });
    }
    return result.kind === "launched";
  }

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="game-window-content-picker-description"
      aria-labelledby="game-window-content-picker-title"
      className="app-dialog m-auto w-[min(680px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      onCancel={(event) => {
        event.preventDefault();
        if (!busyId) onClose();
      }}
      onClose={onClose}
    >
      <Surface className="grid max-h-[min(720px,calc(100vh-2rem))] grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-4 overflow-hidden p-5" radius="lg" variant="modal">
        <header className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <h2 id="game-window-content-picker-title" className="text-title font-semibold">
              {t("gameWindows.add.title").replace("{name}", targetWindow.name)}
            </h2>
            <p id="game-window-content-picker-description" className="text-control text-muted-foreground">
              {savedMode ? t("gameWindows.add.savedDescription") : t("gameWindows.add.description")}
            </p>
          </div>
          <Button aria-label={t("common.close")} disabled={Boolean(busyId)} size="icon" type="button" variant="ghost" onClick={onClose}>
            <X size={16} />
          </Button>
        </header>

        <SegmentedControl<PickerKind>
          className="grid-cols-2"
          disabled={Boolean(busyId)}
          items={[
            { value: "role", label: t("gameWindows.add.roles"), icon: Users, count: roles.length },
            { value: "workspace", label: t("gameWindows.add.workspaces"), icon: LayoutDashboard, count: workspaces.length }
          ]}
          value={kind}
          onValueChange={setKind}
        />

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
          <Input
            autoFocus
            aria-label={t("gameWindows.add.search")}
            className="pl-8"
            disabled={Boolean(busyId)}
            placeholder={t("gameWindows.add.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          {kind === "role" ? (
            <div className="grid gap-2">
              {visibleRoles.length === 0 ? <PickerEmpty t={t} /> : visibleRoles.map((role) => {
                const ownTab = runtime.tabs.find((tab) => tab.type === "role" && tab.sourceId === role.id);
                const workspaceTab = runtime.tabs.find((tab) => tab.type === "workspace" && tab.roleIds.includes(role.id));
                const savedConflict = targetWindow.tabs.some((tab) => tab.roleIds.includes(role.id));
                const disabled = savedMode ? savedConflict : Boolean(workspaceTab);
                return (
                  <PickerRow
                    key={role.id}
                    actionLabel={savedMode ? t("gameWindows.add.saveAction") : pickerActionLabel(ownTab?.windowId, targetWindow.id, t)}
                    busy={busyId === role.id}
                    description={workspaceTab
                      ? t("gameWindows.add.roleInWorkspace").replace("{name}", workspaceTab.name)
                      : pickerLocation(ownTab?.windowId, targetWindow.id, windowById, t)}
                    disabled={disabled || Boolean(busyId)}
                    icon={<BriefcaseBusiness size={16} />}
                    metadata={gameById.get(role.gameId)?.name ?? role.launchUrl}
                    name={role.name}
                    onClick={() => void run(role.id, () => addRole(role))}
                  />
                );
              })}
            </div>
          ) : (
            <div className="grid gap-2">
              {visibleWorkspaces.length === 0 ? <PickerEmpty t={t} /> : visibleWorkspaces.map((workspace) => {
                const liveTab = runtime.tabs.find((tab) => tab.type === "workspace" && tab.sourceId === workspace.id);
                const roleCount = workspace.slots.filter((slot) => slot.roleId).length;
                const workspaceRoleIds = workspace.slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []);
                const savedConflict = targetWindow.tabs.some((tab) =>
                  tab.sourceId === workspace.id
                  || tab.roleIds.some((roleId) => workspaceRoleIds.includes(roleId))
                );
                return (
                  <PickerRow
                    key={workspace.id}
                    actionLabel={savedMode ? t("gameWindows.add.saveAction") : pickerActionLabel(liveTab?.windowId, targetWindow.id, t)}
                    busy={busyId === workspace.id}
                    description={pickerLocation(liveTab?.windowId, targetWindow.id, windowById, t)}
                    disabled={roleCount === 0 || Boolean(busyId) || (savedMode && savedConflict)}
                    icon={<LayoutDashboard size={16} />}
                    metadata={t("gameWindows.add.roleCount").replace("{count}", String(roleCount))}
                    name={workspace.name}
                    onClick={() => void run(workspace.id, () => addWorkspace(workspace))}
                  />
                );
              })}
            </div>
          )}
        </div>
      </Surface>
    </dialog>
  );
}

function savedRoleTab(role: Role): GameWindowTab {
  return {
    id: crypto.randomUUID(),
    tabType: "role",
    sourceId: role.id,
    name: role.name,
    roleIds: [role.id],
    hidden: false,
    audioMuted: false,
    roleViews: []
  };
}

function savedWorkspaceTab(workspace: LaunchWorkspace): GameWindowTab {
  return {
    id: crypto.randomUUID(),
    tabType: "workspace",
    sourceId: workspace.id,
    name: workspace.name,
    roleIds: workspace.slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []),
    hidden: false,
    audioMuted: false,
    roleViews: []
  };
}

function PickerRow({
  actionLabel,
  busy,
  description,
  disabled,
  icon,
  metadata,
  name,
  onClick
}: {
  actionLabel: string;
  busy: boolean;
  description: string;
  disabled: boolean;
  icon: JSX.Element;
  metadata: string;
  name: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Surface className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5" variant="inset">
      <span className="grid size-8 place-items-center rounded-sm bg-background/45 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-body font-semibold">{name}</p>
        <p className="truncate text-caption text-muted-foreground">{metadata} · {description}</p>
      </div>
      <Button className="min-w-20" disabled={disabled} size="sm" type="button" variant="outline" onClick={onClick}>
        {busy ? <Loader2 className="spin" size={14} /> : null}
        {actionLabel}
      </Button>
    </Surface>
  );
}

function PickerEmpty({ t }: { t: Translator }): JSX.Element {
  return (
    <div className="grid min-h-44 place-items-center text-center text-muted-foreground">
      <div><Search className="mx-auto mb-2" size={20} /><p className="text-control">{t("gameWindows.add.noMatches")}</p></div>
    </div>
  );
}

function matchesQuery(values: string[], query: string): boolean {
  return !query || values.some((value) => value.toLocaleLowerCase().includes(query));
}

function pickerActionLabel(windowId: string | undefined, targetWindowId: string, t: Translator): string {
  if (!windowId) return t("gameWindows.add.addAction");
  return windowId === targetWindowId ? t("gameWindows.add.showAction") : t("gameWindows.add.moveAction");
}

function pickerLocation(
  windowId: string | undefined,
  targetWindowId: string,
  windowById: Map<string, GameWindow>,
  t: Translator
): string {
  if (!windowId) return t("gameWindows.add.stopped");
  if (windowId === targetWindowId) return t("gameWindows.add.inThisWindow");
  const name = windowById.get(windowId)?.name ?? t("gameWindows.add.otherWindow");
  return t("gameWindows.add.inOtherWindow").replace("{name}", name);
}
