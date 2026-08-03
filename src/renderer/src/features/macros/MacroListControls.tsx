// Focused implementation extracted from MacrosRoute.tsx.
import { ArrowDown, ArrowUp, CircleAlert, Copy, Loader2, MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";

import { type CSSProperties, type JSX, useEffect, useLayoutEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";

import { RoleRunDot } from "../../components/RoleRunDot";

import { Badge } from "../../components/ui/badge";

import { Button } from "../../components/ui/button";

import { Surface } from "../../components/ui/patterns";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";

import { type MacroListSortKey, type MacroListSortState } from "./macroListUtils";

import { createMacroRunKey } from "./macroUtils";

interface MacroSortHeaderProps {
  label: string;
  onSort: (key: MacroListSortKey) => void;
  sort: MacroListSortState;
  sortKey: MacroListSortKey;
  t: Translator;
}

export function MacroFailureMessage({
  macro,
  macroStatusByRun,
  roleById,
  t
}: {
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  roleById: Map<string, Role>;
  t: Translator;
}): JSX.Element | null {
  const failed = macro.roleIds
    .map((roleId) => macroStatusByRun.get(createMacroRunKey(roleId, macro.id)))
    .find((status) => status?.state === "failed");
  if (!failed) return null;
  const roleName = roleById.get(failed.roleId)?.name ?? failed.roleId;
  const message = failed.error ?? t("macros.status.failed");

  return (
    <span
      className="mt-0.5 flex max-w-full items-center gap-1 text-caption text-destructive"
      title={`${roleName}: ${message}`}
    >
      <CircleAlert aria-hidden="true" className="shrink-0" size={12} />
      <span className="truncate">{t("macros.status.failed")}: {message}</span>
    </span>
  );
}

export function MacroSortHeader({ label, onSort, sort, sortKey, t }: MacroSortHeaderProps): JSX.Element {
  const isActive = sort.key === sortKey;
  const DirectionIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const directionLabel = t(sort.direction === "asc" ? "macros.sortAscending" : "macros.sortDescending");

  return (
    <th
      className="px-4 py-1"
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        className="-mx-1 inline-flex h-[var(--control-height)] max-w-full items-center gap-1 rounded-sm px-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
        type="button"
        title={t("macros.sortBy").replace("{column}", label)}
        onClick={() => onSort(sortKey)}
      >
        <span className="min-w-0 truncate">{label}</span>
        {isActive ? (
          <>
            <DirectionIcon className="shrink-0" size={12} aria-hidden="true" />
            <span className="sr-only">{directionLabel}</span>
          </>
        ) : null}
      </button>
    </th>
  );
}

interface MacroRoleBadgeProps {
  macro: Macro;
  roleById: Map<string, Role>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

const MAX_VISIBLE_MACRO_ROLES = 4;

export function MacroRoleBadge({ macro, roleById, statusByRole, t }: MacroRoleBadgeProps): JSX.Element {
  if (macro.roleIds.length === 0) {
    return <span className="leading-5 text-muted-foreground">{t("macros.noRoles")}</span>;
  }

  const visibleRoleIds = macro.roleIds.slice(0, MAX_VISIBLE_MACRO_ROLES);
  const remainingRoleCount = macro.roleIds.length - visibleRoleIds.length;

  return (
    <div className="flex max-w-[260px] flex-wrap gap-1.5">
      {visibleRoleIds.map((roleId) => {
        const role = roleById.get(roleId);
        const browserStatus = statusByRole.get(roleId);
        const isBrowserRunning = browserStatus?.state === "running";

        return (
          <Badge key={roleId} variant="outline" className="max-w-[126px] justify-start gap-1.5">
            <RoleRunDot
              className={cn(!isBrowserRunning && "opacity-45")}
              isActive={isBrowserRunning}
              label={t(isBrowserRunning ? "role.statusDot.active" : "role.statusDot.inactive")}
            />
            <span className="min-w-0 truncate">{role?.name ?? t("macros.unknownRole")}</span>
          </Badge>
        );
      })}
      {remainingRoleCount > 0 ? (
        <span className="self-center leading-5 text-muted-foreground">
          {t("macros.roles.more").replace("{count}", String(remainingRoleCount))}
        </span>
      ) : null}
    </div>
  );
}

type MacroRunDisabledReason =
  | "noRoles"
  | "unassignedDependency"
  | "macroDisabled"
  | "rolesNotRunning"
  | "automationUnavailable";

interface MacroListRunActionState {
  canStart: boolean;
  canStop: boolean;
  disabled: boolean;
  disabledReason?: MacroRunDisabledReason;
  isBusy: boolean;
  isRunning: boolean;
  isStopping: boolean;
  kind: "start" | "stop";
}

export function createMacroListRunActionState({
  busyMacroIds,
  busyRunKeys,
  hasUnassignedDependency,
  macro,
  macroStatusByRun,
  statusByRole
}: {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  hasUnassignedDependency: boolean;
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  statusByRole: Map<string, RoleStatus>;
}): MacroListRunActionState {
  const assignedStatuses = macro.roleIds
    .map((roleId) => macroStatusByRun.get(createMacroRunKey(roleId, macro.id)))
    .filter((status): status is MacroRunStatus => Boolean(status));
  const isRunning = assignedStatuses.some((status) => status.state === "running");
  const isStopping = assignedStatuses.some((status) => status.state === "stopping");
  const hasRunningBrowser = macro.roleIds.some(
    (roleId) => statusByRole.get(roleId)?.state === "running"
  );
  const hasRunnableRole = macro.roleIds.some(
    (roleId) =>
      statusByRole.get(roleId)?.state === "running" &&
      statusByRole.get(roleId)?.automationState !== "unavailable" &&
      statusByRole.get(roleId)?.pageHealth !== "unresponsive"
  );
  const isBusy = busyMacroIds.has(macro.id) || busyRunKeys.has(macro.id) || isStopping;
  const disabledReason = !isRunning && macro.roleIds.length === 0
    ? "noRoles"
    : !isRunning && hasUnassignedDependency
      ? "unassignedDependency"
      : !isRunning && !macro.enabled
        ? "macroDisabled"
        : !isRunning && !hasRunningBrowser
          ? "rolesNotRunning"
          : !isRunning && !hasRunnableRole
            ? "automationUnavailable"
            : undefined;
  const kind = isRunning || isStopping ? "stop" : "start";
  const disabled = isBusy || Boolean(disabledReason);

  return {
    canStart: kind === "start" && !disabled,
    canStop: kind === "stop" && !disabled,
    disabled,
    disabledReason,
    isBusy,
    isRunning,
    isStopping,
    kind
  };
}

export function MacroRunButton({
  macro,
  onStartMacro,
  onStopMacro,
  runState,
  t
}: {
  macro: Macro;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  runState: MacroListRunActionState;
  t: Translator;
}): JSX.Element {
  const runLabel = t(runState.kind === "stop" ? "macros.stopShort" : "macros.startShort");
  const title = runState.disabledReason === "noRoles"
    ? t("macros.assignRoleFirst")
    : runState.disabledReason === "unassignedDependency"
      ? t("macros.assignCalledMacroRoleFirst")
      : runState.disabledReason === "macroDisabled"
        ? t("macros.disabledHint")
        : runState.disabledReason === "rolesNotRunning"
          ? t("macros.launchRoleFirst")
          : runState.disabledReason === "automationUnavailable"
            ? t("macros.automationUnavailable")
            : runLabel;

  function handleRun(): void {
    if (runState.disabled) {
      return;
    }
    if (runState.kind === "stop") {
      onStopMacro(macro.id);
    } else {
      onStartMacro(macro.id);
    }
  }

  return (
    <Button
      className={cn("h-7 w-7 shrink-0", runState.isRunning && "text-activity hover:text-activity")}
      type="button"
      variant="ghost"
      size="icon"
      title={title}
      aria-label={runLabel}
      onClick={handleRun}
      disabled={runState.disabled}
    >
      {runState.isBusy ? (
        <Loader2 className="spin" size={14} />
      ) : runState.isRunning ? (
        <Pause size={14} fill="currentColor" />
      ) : (
        <Play size={14} fill="currentColor" />
      )}
    </Button>
  );
}

interface MacroActionMenuProps {
  busyMacroIds: ReadonlySet<string>;
  isActive: boolean;
  macro: Macro;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  t: Translator;
}

interface MacroActionMenuPosition {
  left: number;
  top: number;
}

export function MacroActionMenu({
  busyMacroIds,
  isActive,
  macro,
  onCopy,
  onDelete,
  onEdit,
  t
}: MacroActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MacroActionMenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isDeleteBusy = busyMacroIds.has(macro.id);

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

      setMenuPosition((current) =>
        current?.left === left && current.top === top
          ? current
          : { left, top }
      );
    }

    let frameId: number | undefined;
    function scheduleMenuPositionUpdate(): void {
      if (frameId !== undefined) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        updateMenuPosition();
      });
    }

    updateMenuPosition();
    scheduleMenuPositionUpdate();

    window.addEventListener("resize", scheduleMenuPositionUpdate);
    window.addEventListener("scroll", scheduleMenuPositionUpdate, {
      capture: true,
      passive: true
    });

    return () => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", scheduleMenuPositionUpdate);
      window.removeEventListener("scroll", scheduleMenuPositionUpdate, true);
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

  function handleEdit(): void {
    setIsOpen(false);
    onEdit();
  }

  function handleCopy(): void {
    setIsOpen(false);
    onCopy();
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
            className="z-[var(--layer-popover)] min-w-32 overflow-hidden text-popover-foreground"
            padding="xs"
            variant="popover"
            role="menu"
            style={menuStyle}
          >
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground"
              type="button"
              role="menuitem"
              onClick={handleEdit}
              disabled={isActive}
            >
              <Pencil size={14} />
              <span>{t("macros.edit")}</span>
            </button>
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              type="button"
              role="menuitem"
              onClick={handleCopy}
              disabled={isDeleteBusy}
            >
              <Copy size={14} />
              <span>{t("macros.copy")}</span>
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
    <div className="relative flex shrink-0 items-center">
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
