import { Keyboard, Loader2, MoreHorizontal, Pencil, Play, Plus, Search, Square, Trash2 } from "lucide-react";
import { type CSSProperties, type JSX, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { EmptyState } from "../../components/EmptyState";
import { RoleRunDot } from "../../components/RoleRunDot";
import { SearchField } from "../../components/SearchField";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";
import {
  createMacroRunKey,
  formatMacroRepeat,
  formatMacroShortcut,
  summarizeMacroSteps
} from "./macroUtils";

interface MacrosRouteProps {
  busyMacroId: string | null;
  busyRunKey: string | null;
  macroStatusByRun: Map<string, MacroRunStatus>;
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  onDeleteMacro: (macro: Macro) => void;
  onEditMacro: (macro: Macro) => void;
  onNewMacro: () => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

function MacrosRoute({
  busyMacroId,
  busyRunKey,
  macroStatusByRun,
  macroStatuses,
  macros,
  onDeleteMacro,
  onEditMacro,
  onNewMacro,
  onStartMacro,
  onStopMacro,
  roles,
  statusByRole,
  t
}: MacrosRouteProps): JSX.Element {
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const runningCount = macroStatuses.filter((status) => status.state === "running").length;
  const [query, setQuery] = useState("");
  const filteredMacros = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return macros;
    }

    return macros.filter((macro) => {
      const roleNames = macro.roleIds.map((roleId) => roleById.get(roleId)?.name ?? t("macros.unknownRole"));

      return [
        macro.name,
        ...roleNames,
        formatMacroShortcut(macro.trigger, t),
        formatMacroRepeat(macro.repeat, t),
        summarizeMacroSteps(macro.steps, t)
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [macros, query, roleById, t]);

  return (
    <PageFrame>
      <PageHeader
        kicker={t("macros.kicker")}
        title={t("macros.title")}
        description={t("macros.description")}
        actions={
          <>
            <SearchField
              className="w-full sm:w-44 lg:w-48"
              placeholder={t("macros.searchPlaceholder")}
              value={query}
              onChange={setQuery}
            />
            <Button className="w-full gap-1.5 sm:w-auto" type="button" variant="outline" size="sm" onClick={onNewMacro}>
              <Plus size={14} />
              {t("macros.newMacro")}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2 text-xs font-semibold text-muted-foreground">
          <Badge variant="secondary">{t("macros.count").replace("{count}", String(macros.length))}</Badge>
          <Badge variant="secondary">{t("macros.runningCount").replace("{count}", String(runningCount))}</Badge>
        </div>
      </div>

      {macros.length === 0 ? (
        <EmptyState
          icon={Keyboard}
          title={t("macros.empty.title")}
          description={t("macros.empty.description")}
          actionLabel={t("macros.empty.action")}
          onAction={onNewMacro}
        />
      ) : filteredMacros.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("macros.noMatches.title")}
          description={t("macros.noMatches.description")}
          actionLabel={t("macros.noMatches.action")}
          onAction={() => setQuery("")}
        />
      ) : (
        <Surface className="mac-list-surface overflow-hidden" variant="panel">
          <div className="overflow-auto">
            <table className="mac-list-table w-full min-w-[900px] border-collapse text-left">
              <thead className="glass-divider border-b text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5">{t("macros.column.name")}</th>
                  <th className="px-4 py-2.5">{t("macros.column.roles")}</th>
                  <th className="px-4 py-2.5">{t("macros.column.shortcut")}</th>
                  <th className="px-4 py-2.5">{t("macros.column.repeat")}</th>
                  <th className="px-4 py-2.5">{t("macros.column.steps")}</th>
                  <th className="w-12 px-4 py-2.5" aria-label={t("macros.actions")} />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/45 text-[13px] leading-5">
                {filteredMacros.map((macro) => (
                  <tr key={macro.id} className="align-baseline">
                    <td className="max-w-[240px] px-4 py-2.5 align-baseline">
                      <button
                        className="-mx-1 block max-w-full rounded-sm px-1 text-left font-semibold leading-5 text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
                        type="button"
                        title={t("macros.edit")}
                        onClick={() => onEditMacro(macro)}
                      >
                        <span className="block truncate">{macro.name}</span>
                      </button>
                    </td>
                    <td className="max-w-[240px] px-4 py-2.5 align-baseline">
                      <MacroRoleBadge
                        macro={macro}
                        macroStatusByRun={macroStatusByRun}
                        roleById={roleById}
                        statusByRole={statusByRole}
                        t={t}
                      />
                    </td>
                    <td className="px-4 py-2.5 align-baseline font-semibold text-muted-foreground">
                      {formatMacroShortcut(macro.trigger, t)}
                    </td>
                    <td className="px-4 py-2.5 align-baseline font-semibold text-muted-foreground">
                      {formatMacroRepeat(macro.repeat, t)}
                    </td>
                    <td className="max-w-[320px] px-4 py-2.5 align-baseline font-medium text-muted-foreground">
                      {summarizeMacroSteps(macro.steps, t)}
                    </td>
                    <td className="px-4 py-2.5 align-baseline">
                      <div className="-my-1 flex justify-end">
                        <MacroActionMenu
                          busyMacroId={busyMacroId}
                          busyRunKey={busyRunKey}
                          macro={macro}
                          macroStatusByRun={macroStatusByRun}
                          onDelete={() => onDeleteMacro(macro)}
                          onEdit={() => onEditMacro(macro)}
                          onStartMacro={onStartMacro}
                          onStopMacro={onStopMacro}
                          statusByRole={statusByRole}
                          t={t}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </PageFrame>
  );
}

interface MacroRoleBadgeProps {
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  roleById: Map<string, Role>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

function MacroRoleBadge({ macro, macroStatusByRun, roleById, statusByRole, t }: MacroRoleBadgeProps): JSX.Element {
  if (macro.roleIds.length === 0) {
    return <span className="font-medium leading-5 text-muted-foreground">{t("macros.noRoles")}</span>;
  }

  return (
    <div className="flex max-w-[260px] flex-wrap gap-1.5">
      {macro.roleIds.map((roleId) => {
        const role = roleById.get(roleId);
        const runKey = createMacroRunKey(roleId, macro.id);
        const macroStatus = macroStatusByRun.get(runKey);
        const browserStatus = statusByRole.get(roleId);
        const isBrowserRunning = browserStatus?.state === "running";
        const isRunning = macroStatus?.state === "running";

        return (
          <Badge key={roleId} variant="outline" className="max-w-[126px] justify-start gap-1.5">
            <RoleRunDot
              className={cn(!isBrowserRunning && "opacity-45")}
              isActive={Boolean(isRunning)}
              label={t(isRunning ? "macros.status.running" : "macros.status.ready")}
            />
            <span className="min-w-0 truncate">{role?.name ?? t("macros.unknownRole")}</span>
          </Badge>
        );
      })}
    </div>
  );
}

interface MacroActionMenuProps {
  busyMacroId: string | null;
  busyRunKey: string | null;
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  onDelete: () => void;
  onEdit: () => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

interface MacroActionMenuPosition {
  left: number;
  top: number;
}

function MacroActionMenu({
  busyMacroId,
  busyRunKey,
  macro,
  macroStatusByRun,
  onDelete,
  onEdit,
  onStartMacro,
  onStopMacro,
  statusByRole,
  t
}: MacroActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MacroActionMenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const assignedRunKeys = macro.roleIds.map((roleId) => createMacroRunKey(roleId, macro.id));
  const macroRunStatuses = assignedRunKeys
    .map((runKey) => macroStatusByRun.get(runKey))
    .filter((status): status is MacroRunStatus => Boolean(status));
  const areBrowsersRunning =
    macro.roleIds.length > 0 && macro.roleIds.every((roleId) => statusByRole.get(roleId)?.state === "running");
  const isRunning = macroRunStatuses.some((status) => status.state === "running");
  const isStopping = macroRunStatuses.some((status) => status.state === "stopping");
  const isRunBusy = busyRunKey === macro.id || isStopping;
  const isDeleteBusy = busyMacroId === macro.id;
  const runLabel = t(isRunning || isStopping ? "macros.stopShort" : "macros.startShort");
  const isRunDisabled = isRunBusy || (!isRunning && !areBrowsersRunning);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    function updateMenuPosition(): void {
      const triggerBounds = triggerRef.current?.getBoundingClientRect();

      if (!triggerBounds) {
        return;
      }

      const viewportPadding = 8;
      const menuGap = 4;
      const menuWidth = menuRef.current?.offsetWidth ?? 128;
      const menuHeight = menuRef.current?.offsetHeight ?? 92;
      const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
      const left = Math.min(Math.max(viewportPadding, triggerBounds.right - menuWidth), maxLeft);
      const belowTop = triggerBounds.bottom + menuGap;
      const top =
        belowTop + menuHeight <= window.innerHeight - viewportPadding
          ? belowTop
          : Math.max(viewportPadding, triggerBounds.top - menuHeight - menuGap);

      setMenuPosition({ left, top });
    }

    updateMenuPosition();
    const frameId = window.requestAnimationFrame(updateMenuPosition);

    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node;

      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }

      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function handleRun(): void {
    if (isRunDisabled) {
      return;
    }

    setIsOpen(false);

    if (isRunning || isStopping) {
      onStopMacro(macro.id);
      return;
    }

    onStartMacro(macro.id);
  }

  function handleEdit(): void {
    setIsOpen(false);
    onEdit();
  }

  function handleDelete(): void {
    setIsOpen(false);
    onDelete();
  }

  const menuStyle: CSSProperties | undefined = menuPosition
    ? {
        left: menuPosition.left,
        position: "fixed",
        top: menuPosition.top
      }
    : undefined;

  const menu =
    isOpen && menuPosition
      ? createPortal(
          <Surface
            ref={menuRef}
            className="z-50 min-w-32 overflow-hidden text-popover-foreground"
            padding="xs"
            variant="popover"
            role="menu"
            style={menuStyle}
          >
            <button
              className={cn(
                "flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                isRunning || isStopping
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-foreground hover:bg-accent/45 hover:text-accent-foreground"
              )}
              type="button"
              role="menuitem"
              title={!areBrowsersRunning && !isRunning ? t("macros.launchRoleFirst") : runLabel}
              onClick={handleRun}
              disabled={isRunDisabled}
            >
              {isRunBusy ? (
                <Loader2 className="spin" size={14} />
              ) : isRunning || isStopping ? (
                <Square size={14} />
              ) : (
                <Play size={14} />
              )}
              <span>{runLabel}</span>
            </button>
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground"
              type="button"
              role="menuitem"
              onClick={handleEdit}
            >
              <Pencil size={14} />
              <span>{t("macros.edit")}</span>
            </button>
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
              type="button"
              role="menuitem"
              onClick={handleDelete}
              disabled={isDeleteBusy}
            >
              {isDeleteBusy ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
              <span>{t("macros.delete")}</span>
            </button>
          </Surface>,
          document.body
        )
      : null;

  return (
    <div className="relative shrink-0">
      <Button
        ref={triggerRef}
        className="h-7 w-7"
        type="button"
        variant="ghost"
        size="icon"
        title={t("macros.actions")}
        aria-label={t("macros.actions")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <MoreHorizontal size={14} />
      </Button>
      {menu}
    </div>
  );
}

export default MacrosRoute;
