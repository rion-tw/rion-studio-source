import { Keyboard, Pause, Play, Plus, Pointer, Repeat1, Search, Timer, ToggleLeft, ToggleRight } from "lucide-react";

import { type JSX, type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../../components/EmptyState";

import { SelectionActionBar, SelectionGroupOutlines, SelectionMarquee } from "../../components/ListSelection";

import { SearchField } from "../../components/SearchField";

import { Badge } from "../../components/ui/badge";

import { Button } from "../../components/ui/button";

import { ContextMenu, ContextMenuTrigger } from "../../components/ui/context-menu";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import { useListSelection } from "../../hooks/useListSelection";

import { findUnassignedMacroDependency } from "../../../../shared/macroDependencies";

import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";

import { getMacroListItems, type MacroListSortKey, type MacroListSortState } from "./macroListUtils";

import { formatMacroActivationMode, formatMacroIntervalPreset, formatMacroRepeat, formatMacroShortcut, isMacroRunActive, summarizeMacroSteps } from "./macroUtils";

import { MacroActionMenu, MacroContextMenuContent, MacroFailureMessage, MacroRoleBadge, MacroRunButton, MacroSortHeader, createMacroListRunActionState } from "./MacroListControls";

const ALL_ROLES_SELECT_VALUE = "__all_roles__";
const MACRO_LIST_INDICATOR_CLASS = "inline-flex h-5 items-center gap-1.5 whitespace-nowrap text-muted-foreground";

function MacroShortcutIndicator({ macro, t }: { macro: Macro; t: Translator }): JSX.Element | null {
  if (!macro.trigger) {
    return null;
  }

  const isWhileHeld = macro.activationMode === "while_held";
  const activationLabel = formatMacroActivationMode(macro.activationMode, t);
  const shortcutLabel = formatMacroShortcut(macro.trigger, t);

  return (
    <span className={MACRO_LIST_INDICATOR_CLASS} data-macro-shortcut-indicator>
      <span aria-label={activationLabel} className="inline-flex shrink-0" role="img" title={activationLabel}>
        {isWhileHeld ? <Pointer aria-hidden="true" size={14} /> : <ToggleRight aria-hidden="true" size={14} />}
      </span>
      <span className="text-body leading-5">{shortcutLabel}</span>
    </span>
  );
}

function MacroRepeatIndicator({ macro, t }: { macro: Macro; t: Translator }): JSX.Element {
  const label = formatMacroRepeat(macro.repeat, t);
  const delayLabel = macro.repeat.type === "loop"
    ? macro.repeat.intervalMs === 0
      ? t("macroForm.intervalMilliseconds").replace("{value}", "0")
      : formatMacroIntervalPreset(macro.repeat.intervalMs, t)
    : undefined;

  return (
    <span
      aria-label={label}
      className={MACRO_LIST_INDICATOR_CLASS}
      data-macro-repeat-indicator
      role="img"
      title={label}
    >
      {macro.repeat.type === "loop" ? (
        <>
          <Timer aria-hidden="true" size={14} />
          <span aria-hidden="true" className="text-body leading-5 tabular-nums">{delayLabel}</span>
        </>
      ) : (
        <>
          <Repeat1 aria-hidden="true" size={14} />
          <span aria-hidden="true" className="text-body leading-5">{label}</span>
        </>
      )}
    </span>
  );
}

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
  onDeleteMacros: (macros: Macro[]) => Promise<boolean>;
  onEditMacro: (macro: Macro) => void;
  onNewMacro: (roleId?: string) => void;
  onQueryChange: (query: string) => void;
  onRoleFilterChange: (roleId: string) => void;
  onSetMacroEnabled?: (macro: Macro, enabled: boolean) => void;
  onSetMacrosEnabled?: (macros: Macro[], enabled: boolean) => Promise<void>;
  onSortChange: (sort: MacroListSortState) => void;
  onStartMacro: (macroId: string) => void;
  onStartMacros?: (macros: Macro[]) => Promise<void>;
  onStopMacro: (macroId: string) => void;
  onStopMacros?: (macros: Macro[]) => Promise<void>;
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
  onDeleteMacros,
  onEditMacro,
  onNewMacro,
  onQueryChange,
  onRoleFilterChange,
  onSetMacroEnabled,
  onSetMacrosEnabled,
  onSortChange,
  onStartMacro,
  onStartMacros,
  onStopMacro,
  onStopMacros,
  roles,
  statusByRole,
  t
}: MacrosRouteProps): JSX.Element {
  const pageRef = useRef<HTMLElement | null>(null);
  const [macroListScrollContainer, setMacroListScrollContainer] = useState<HTMLDivElement | null>(null);
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const macroNameById = useMemo(
    () => new Map(macros.map((macro) => [macro.id, macro.name])),
    [macros]
  );
  const runningCount = new Set(
    macroStatuses.filter(isMacroRunActive).map((status) => status.macroId)
  ).size;
  const unassignedWorkflowMacroIds = useMemo(
    () => new Set(
      macros
        .filter((macro) => findUnassignedMacroDependency(macros, macro.id))
        .map((macro) => macro.id)
    ),
    [macros]
  );
  const runStateByMacroId = useMemo(
    () => new Map(macros.map((macro) => [
      macro.id,
      createMacroListRunActionState({
        busyMacroIds,
        busyRunKeys,
        hasUnassignedDependency: unassignedWorkflowMacroIds.has(macro.id),
        macro,
        macroStatusByRun,
        statusByRole
      })
    ])),
    [busyMacroIds, busyRunKeys, macroStatusByRun, macros, statusByRole, unassignedWorkflowMacroIds]
  );
  const filteredMacros = useMemo(
    () => getMacroListItems({ macros, query, roleFilterId, roles, sort, t }),
    [macros, query, roleFilterId, roles, sort, t]
  );
  const filteredMacroIds = useMemo(() => filteredMacros.map((macro) => macro.id), [filteredMacros]);
  const selection = useListSelection({
    orderedIds: filteredMacroIds,
    scrollContainerRef: pageRef
  });
  const selectedMacros = filteredMacros.filter((macro) => selection.selectedIds.has(macro.id));
  const startableMacros = selectedMacros.filter(
    (macro) => runStateByMacroId.get(macro.id)?.canStart
  );
  const stoppableMacros = selectedMacros.filter(
    (macro) => runStateByMacroId.get(macro.id)?.canStop
  );
  const enableableMacros = selectedMacros.filter(
    (macro) => !macro.enabled && !busyMacroIds.has(macro.id) && !busyRunKeys.has(macro.id)
  );
  const disableableMacros = selectedMacros.filter(
    (macro) => macro.enabled && !busyMacroIds.has(macro.id) && !busyRunKeys.has(macro.id)
  );
  const isSelectionBusy = selectedMacros.some(
    (macro) => busyMacroIds.has(macro.id) || busyRunKeys.has(macro.id)
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

  async function handleDeleteSelected(): Promise<void> {
    const completed = await onDeleteMacros(selectedMacros);
    if (completed) {
      selection.clearSelection();
    }
  }

  function handleNewMacro(): void {
    onNewMacro(roleFilterId || undefined);
  }

  async function handleStartSelected(): Promise<void> {
    if (onStartMacros) {
      await onStartMacros(startableMacros);
      return;
    }
    startableMacros.forEach((macro) => onStartMacro(macro.id));
  }

  async function handleStopSelected(): Promise<void> {
    if (onStopMacros) {
      await onStopMacros(stoppableMacros);
      return;
    }
    stoppableMacros.forEach((macro) => onStopMacro(macro.id));
  }

  async function handleEnableSelected(): Promise<void> {
    if (onSetMacrosEnabled) {
      await onSetMacrosEnabled(enableableMacros, true);
      return;
    }
    enableableMacros.forEach((macro) => onSetMacroEnabled?.(macro, true));
  }

  async function handleDisableSelected(): Promise<void> {
    if (onSetMacrosEnabled) {
      await onSetMacrosEnabled(disableableMacros, false);
      return;
    }
    disableableMacros.forEach((macro) => onSetMacroEnabled?.(macro, false));
  }

  if (macros.length === 0) {
    return (
      <PageFrame containerRef={pageRef} contentClassName="grid min-h-full place-items-center" scrollPositionRef={scrollPositionRef}>
        <EmptyState
          className="min-h-0"
          icon={Keyboard}
          title={t("macros.empty.title")}
          description={t("macros.empty.description")}
          actionLabel={t("macros.empty.action")}
          onAction={handleNewMacro}
        />
      </PageFrame>
    );
  }

  return (
    <PageFrame containerRef={pageRef} scrollPositionRef={scrollPositionRef} {...selection.collectionProps}>
      <PageHeader
        kicker={t("app.navigation.play")}
        title={t("macros.title")}
        description={t("macros.description")}
        actions={
          <>
            <SearchField
              className="page-header-control page-header-search"
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
              <SelectTrigger className="page-header-control page-header-select" aria-label={t("macros.filterRole")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ROLES_SELECT_VALUE}>{t("macros.filterAllRoles")}</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="page-header-control gap-1.5 px-2.5"
              type="button"
              variant="outline"
              onClick={handleNewMacro}
            >
              <Plus size={14} />
              {t("macros.newMacro")}
            </Button>
          </>
        }
      />

      {selection.hasSelection ? (
        <SelectionActionBar
          actions={
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSelectionBusy || startableMacros.length === 0}
                onClick={() => void handleStartSelected()}
              >
                <Play size={14} fill="currentColor" />
                {t("macros.bulk.runCount").replace("{count}", String(startableMacros.length))}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSelectionBusy || stoppableMacros.length === 0}
                onClick={() => void handleStopSelected()}
              >
                <Pause size={14} fill="currentColor" />
                {t("macros.bulk.stopCount").replace("{count}", String(stoppableMacros.length))}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSelectionBusy || enableableMacros.length === 0}
                onClick={() => void handleEnableSelected()}
              >
                <ToggleRight size={14} />
                {t("macros.bulk.enableCount").replace("{count}", String(enableableMacros.length))}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSelectionBusy || disableableMacros.length === 0}
                onClick={() => void handleDisableSelected()}
              >
                <ToggleLeft size={14} />
                {t("macros.bulk.disableCount").replace("{count}", String(disableableMacros.length))}
              </Button>
            </>
          }
          isBusy={isSelectionBusy}
          selectedCount={selection.selectedIds.size}
          t={t}
          totalCount={filteredMacros.length}
          onClear={selection.clearSelection}
          onDelete={() => void handleDeleteSelected()}
          onSelectAll={selection.selectAll}
        />
      ) : null}

      <div className="list-toolbar gap-2">
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
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
        <div className="grid justify-items-start gap-2">
          <Surface className="mac-list-surface w-full overflow-hidden" variant="panel">
            <div ref={setMacroListScrollContainer} className="relative overflow-auto">
              <table className="mac-list-table w-full min-w-[900px] border-collapse text-left">
              <thead className="glass-divider border-b text-caption uppercase tracking-normal text-muted-foreground">
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
                  <th className="w-12 px-2 py-1" aria-label={t("macros.actions")} />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/45 text-body">
                {filteredMacros.map((macro) => {
                  const runState = runStateByMacroId.get(macro.id)!;
                  const isActive = runState.isRunning || runState.isStopping;
                  const isSelected = selection.isSelected(macro.id);
                  const rowTone = isActive
                    ? "bg-activity/[0.08]"
                    : macro.roleIds.length === 0
                      ? "bg-warning/35"
                      : isSelected
                        ? "bg-activity/10"
                        : undefined;

                  return (
                    <ContextMenu key={macro.id}>
                      <ContextMenuTrigger asChild>
                        <tr
                          ref={selection.registerItem(macro.id)}
                          className={cn(
                            "group align-middle transition-[background-color,box-shadow,opacity]",
                            rowTone,
                            !macro.enabled && "opacity-[0.55]"
                          )}
                          data-macro-active={isActive ? "true" : undefined}
                          data-macro-disabled={!macro.enabled ? "true" : undefined}
                          data-macro-unassigned={macro.roleIds.length === 0 ? "true" : undefined}
                          data-selection-id={macro.id}
                          onClickCapture={(event) => selection.handleItemClick(event, macro.id)}
                        >
                    <td className="relative max-w-[240px] px-4 py-2 align-middle">
                      <div className="min-w-0 pl-6" data-macro-name-control>
                        <div className="absolute inset-y-0 left-4 -ml-1.5 flex items-center" data-macro-run-control>
                          <MacroRunButton
                            macro={macro}
                            runState={runState}
                            t={t}
                            onStartMacro={onStartMacro}
                            onStopMacro={onStopMacro}
                          />
                        </div>
                        <div className="min-w-0">
                          <button
                            className={cn(
                              "-mx-1 block max-w-full rounded-sm px-1 text-left font-semibold leading-5 transition-colors hover:text-activity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed",
                              macro.enabled ? "text-foreground" : "text-muted-foreground"
                            )}
                            type="button"
                            title={t("macros.edit")}
                            disabled={isActive}
                            onClick={() => onEditMacro(macro)}
                          >
                            <span className="block truncate">{macro.name}</span>
                          </button>
                          <MacroFailureMessage
                            macro={macro}
                            macroStatusByRun={macroStatusByRun}
                            roleById={roleById}
                            t={t}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[240px] px-4 py-2 align-middle">
                      <MacroRoleBadge
                        macro={macro}
                        roleById={roleById}
                        statusByRole={statusByRole}
                        t={t}
                      />
                    </td>
                    <td className="max-w-[220px] px-4 py-2 align-middle">
                      {macro.trigger ? (
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <MacroShortcutIndicator macro={macro} t={t} />
                          {macro.shortcutSourceScope.type === "selected_roles" ? (
                            <MacroRoleBadge
                              macro={macro}
                              roleIds={macro.shortcutSourceScope.roleIds}
                              roleById={roleById}
                              statusByRole={statusByRole}
                              t={t}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 align-middle text-muted-foreground">
                      <MacroRepeatIndicator macro={macro} t={t} />
                    </td>
                    <td className="max-w-[320px] px-4 py-2 align-middle text-muted-foreground">
                      {summarizeMacroSteps(macro.steps, t, macroNameById)}
                    </td>
                    <td className="relative w-12 p-0">
                      <div className="absolute inset-0 grid place-items-center px-2" data-macro-actions-control>
                        <MacroActionMenu
                          busyMacroIds={busyMacroIds}
                          macro={macro}
                          isActive={isActive}
                          onCopy={() => onCopyMacro(macro)}
                          onDelete={() => onDeleteMacro(macro)}
                          onEdit={() => onEditMacro(macro)}
                          onSetEnabled={onSetMacroEnabled
                            ? (enabled) => onSetMacroEnabled(macro, enabled)
                            : undefined}
                          t={t}
                        />
                      </div>
                    </td>
                        </tr>
                      </ContextMenuTrigger>
                      <MacroContextMenuContent
                        busyMacroIds={busyMacroIds}
                        macro={macro}
                        isActive={isActive}
                        onCopy={() => onCopyMacro(macro)}
                        onDelete={() => onDeleteMacro(macro)}
                        onEdit={() => onEditMacro(macro)}
                        onSetEnabled={onSetMacroEnabled
                          ? (enabled) => onSetMacroEnabled(macro, enabled)
                          : undefined}
                        t={t}
                      />
                    </ContextMenu>
                  );
                })}
                </tbody>
              </table>
            </div>
          </Surface>
          <Button
            className="gap-1.5 border-dashed bg-transparent px-2.5 text-muted-foreground shadow-none hover:text-foreground"
            type="button"
            variant="outline"
            onClick={handleNewMacro}
          >
            <Plus aria-hidden="true" size={14} />
            <span>{t("macros.newMacro")}</span>
          </Button>
        </div>
      )}
      <SelectionGroupOutlines
        container={macroListScrollContainer}
        orderedIds={filteredMacroIds}
        selectedIds={selection.selectedIds}
      />
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
    </PageFrame>
  );
}

export default MacrosRoute;
