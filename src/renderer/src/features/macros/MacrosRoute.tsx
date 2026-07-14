import {
  ArrowDown,
  ArrowUp,
  Copy,
  Keyboard,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2
} from "lucide-react";
import { type CSSProperties, type JSX, type MutableRefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { EmptyState } from "../../components/EmptyState";
import { RoleRunDot } from "../../components/RoleRunDot";
import { SearchField } from "../../components/SearchField";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";
import {
  getMacroListItems,
  type MacroListSortKey,
  type MacroListSortState
} from "./macroListUtils";
import {
  createMacroRunKey,
  formatMacroRepeat,
  formatMacroShortcut,
  summarizeMacroSteps
} from "./macroUtils";

const ALL_ROLES_SELECT_VALUE = "__all_roles__";

interface MacrosRouteProps {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  macroStatusByRun: Map<string, MacroRunStatus>;
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  query: string;
  roleFilterId: string;
  scrollPositionRef: MutableRefObject<number>;
  sort: MacroListSortState;
  onCopyMacro: (macro: Macro) => void;
  onDeleteMacro: (macro: Macro) => void;
  onEditMacro: (macro: Macro) => void;
  onNewMacro: () => void;
  onQueryChange: (query: string) => void;
  onRoleFilterChange: (roleId: string) => void;
  onSortChange: (sort: MacroListSortState) => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

function MacrosRoute({
  busyMacroIds,
  busyRunKeys,
  macroStatusByRun,
  macroStatuses,
  macros,
  query,
  roleFilterId,
  scrollPositionRef,
  sort,
  onCopyMacro,
  onDeleteMacro,
  onEditMacro,
  onNewMacro,
  onQueryChange,
  onRoleFilterChange,
  onSortChange,
  onStartMacro,
  onStopMacro,
  roles,
  statusByRole,
  t
}: MacrosRouteProps): JSX.Element {
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const runningCount = new Set(
    macroStatuses.filter((status) => status.state === "running").map((status) => status.macroId)
  ).size;
  const activeMacroIds = new Set(
    macroStatuses
      .filter((status) => status.state === "running" || status.state === "stopping")
      .map((status) => status.macroId)
  );
  const filteredMacros = useMemo(
    () => getMacroListItems({ macros, query, roleFilterId, roles, sort, t }),
    [macros, query, roleFilterId, roles, sort, t]
  );

  useEffect(() => {
    if (roleFilterId && !roles.some((role) => role.id === roleFilterId)) {
      onRoleFilterChange("");
    }
  }, [onRoleFilterChange, roleFilterId, roles]);

  function handleSortChange(key: MacroListSortKey): void {
    onSortChange(
      sort.key === key
        ? {
            direction: sort.direction === "asc" ? "desc" : "asc",
            key
          }
        : {
            direction: "asc",
            key
          }
    );
  }

  if (macros.length === 0) {
    return (
      <PageFrame contentClassName="grid min-h-full place-items-center" scrollPositionRef={scrollPositionRef}>
        <EmptyState
          className="min-h-0"
          icon={Keyboard}
          title={t("macros.empty.title")}
          description={t("macros.empty.description")}
          actionLabel={t("macros.empty.action")}
          onAction={onNewMacro}
        />
      </PageFrame>
    );
  }

  return (
    <PageFrame scrollPositionRef={scrollPositionRef}>
      <PageHeader
        kicker={t("app.navigation.play")}
        title={t("macros.title")}
        description={t("macros.description")}
        actions={
          <>
            <SearchField
              className="w-full sm:w-44 lg:w-48"
              placeholder={t("macros.searchPlaceholder")}
              value={query}
              onChange={onQueryChange}
            />
            <Select
              value={roleFilterId || ALL_ROLES_SELECT_VALUE}
              onValueChange={(value) =>
                onRoleFilterChange(value === ALL_ROLES_SELECT_VALUE ? "" : value)
              }
            >
              <SelectTrigger className="w-full sm:w-40 lg:w-44" aria-label={t("macros.filterRole")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ROLES_SELECT_VALUE}>{t("macros.filterAllRoles")}</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="flex-1 gap-1.5 px-2.5 sm:flex-none"
              type="button"
              variant="outline"
              onClick={onNewMacro}
            >
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

      {filteredMacros.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("macros.noMatches.title")}
          description={t("macros.noMatches.description")}
          actionLabel={t("macros.noMatches.action")}
          onAction={() => {
            onQueryChange("");
            onRoleFilterChange("");
          }}
        />
      ) : (
        <Surface className="mac-list-surface overflow-hidden" variant="panel">
          <div className="overflow-auto">
            <table className="mac-list-table w-full min-w-[900px] border-collapse text-left">
              <thead className="glass-divider border-b text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
                <tr>
                  <MacroSortHeader
                    label={t("macros.column.name")}
                    sort={sort}
                    sortKey="name"
                    t={t}
                    onSort={handleSortChange}
                  />
                  <MacroSortHeader
                    label={t("macros.column.roles")}
                    sort={sort}
                    sortKey="roles"
                    t={t}
                    onSort={handleSortChange}
                  />
                  <MacroSortHeader
                    label={t("macros.column.shortcut")}
                    sort={sort}
                    sortKey="shortcut"
                    t={t}
                    onSort={handleSortChange}
                  />
                  <MacroSortHeader
                    label={t("macros.column.repeat")}
                    sort={sort}
                    sortKey="repeat"
                    t={t}
                    onSort={handleSortChange}
                  />
                  <MacroSortHeader
                    label={t("macros.column.steps")}
                    sort={sort}
                    sortKey="steps"
                    t={t}
                    onSort={handleSortChange}
                  />
                  <th className="w-20 px-4 py-1.5" aria-label={t("macros.actions")} />
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
                        disabled={activeMacroIds.has(macro.id)}
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
                          busyMacroIds={busyMacroIds}
                          busyRunKeys={busyRunKeys}
                          macro={macro}
                          macroStatusByRun={macroStatusByRun}
                          onCopy={() => onCopyMacro(macro)}
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

interface MacroSortHeaderProps {
  label: string;
  onSort: (key: MacroListSortKey) => void;
  sort: MacroListSortState;
  sortKey: MacroListSortKey;
  t: Translator;
}

function MacroSortHeader({ label, onSort, sort, sortKey, t }: MacroSortHeaderProps): JSX.Element {
  const isActive = sort.key === sortKey;
  const DirectionIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const directionLabel = t(sort.direction === "asc" ? "macros.sortAscending" : "macros.sortDescending");

  return (
    <th
      className="px-4 py-1.5"
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        className="-mx-1 inline-flex h-6 max-w-full items-center gap-1 rounded-sm px-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
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
        const isRunning = macroStatus?.state === "running" || macroStatus?.state === "stopping";
        const isFailed = macroStatus?.state === "failed";
        const isCancelled = macroStatus?.state === "cancelled";

        return (
          <Badge key={roleId} variant="outline" className="max-w-[126px] justify-start gap-1.5">
            <RoleRunDot
              className={cn(!isBrowserRunning && "opacity-45")}
              isActive={Boolean(isRunning)}
              label={t(
                isRunning
                  ? "macros.status.running"
                  : isFailed
                    ? "macros.status.failed"
                    : isCancelled
                      ? "macros.status.cancelled"
                      : "macros.status.ready"
              )}
            />
            <span className="min-w-0 truncate">{role?.name ?? t("macros.unknownRole")}</span>
          </Badge>
        );
      })}
    </div>
  );
}

interface MacroActionMenuProps {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  onCopy: () => void;
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
  busyMacroIds,
  busyRunKeys,
  macro,
  macroStatusByRun,
  onCopy,
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
  const hasRunningBrowser = macro.roleIds.some(
    (roleId) => statusByRole.get(roleId)?.state === "running"
  );
  const hasRunnableRole = macro.roleIds.some(
    (roleId) =>
      statusByRole.get(roleId)?.state === "running" &&
      statusByRole.get(roleId)?.automationState !== "unavailable"
  );
  const isRunning = macroRunStatuses.some((status) => status.state === "running");
  const isStopping = macroRunStatuses.some((status) => status.state === "stopping");
  const isRunBusy = busyRunKeys.has(macro.id) || isStopping;
  const isDeleteBusy = busyMacroIds.has(macro.id);
  const runLabel = t(isRunning || isStopping ? "macros.stopShort" : "macros.startShort");
  const isRunDisabled = isRunBusy || (!isRunning && !hasRunnableRole);

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
            className="z-50 min-w-32 overflow-hidden text-popover-foreground"
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
              disabled={isRunning || isStopping}
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
    <div className="relative flex shrink-0 items-center gap-0.5">
      <Button
        className={cn("h-7 w-7", isRunning && "text-primary hover:text-primary")}
        type="button"
        variant="ghost"
        size="icon"
        title={
          !isRunning && !hasRunningBrowser
            ? t("macros.launchRoleFirst")
            : !isRunning && !hasRunnableRole
              ? t("macros.automationUnavailable")
              : runLabel
        }
        aria-label={runLabel}
        onClick={handleRun}
        disabled={isRunDisabled}
      >
        {isRunBusy ? (
          <Loader2 className="spin" size={14} />
        ) : isRunning ? (
          <Pause size={14} fill="currentColor" />
        ) : (
          <Play size={14} fill="currentColor" />
        )}
      </Button>
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
