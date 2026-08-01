import { Keyboard, Pause, Play, Plus, Search, ToggleLeft, ToggleRight } from "lucide-react";

import { type JSX, type MutableRefObject, useEffect, useMemo, useRef } from "react";

import { EmptyState } from "../../components/EmptyState";

import { SelectionActionBar, SelectionMarquee, SelectionToggle } from "../../components/ListSelection";

import { SearchField } from "../../components/SearchField";

import { Badge } from "../../components/ui/badge";

import { Button } from "../../components/ui/button";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import { Switch } from "../../components/ui/switch";

import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import { useListSelection } from "../../hooks/useListSelection";

import { findUnassignedMacroDependency } from "../../../../shared/macroDependencies";

import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";

import { getMacroListItems, type MacroListSortKey, type MacroListSortState } from "./macroListUtils";

import { formatMacroActivationMode, formatMacroRepeat, formatMacroShortcut, summarizeMacroSteps } from "./macroUtils";

import { MacroActionMenu, MacroFailureMessage, MacroRoleBadge, MacroRunButton, MacroSortHeader, createMacroListRunActionState } from "./MacroListControls";

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
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const macroNameById = useMemo(
    () => new Map(macros.map((macro) => [macro.id, macro.name])),
    [macros]
  );
  const runningCount = new Set(
    macroStatuses.filter((status) => status.state === "running").map((status) => status.macroId)
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
  const selection = useListSelection({
    orderedIds: filteredMacros.map((macro) => macro.id),
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
            <div className="overflow-auto">
              <table className="mac-list-table w-full min-w-[900px] border-collapse text-left">
              <thead className="glass-divider border-b text-caption uppercase tracking-normal text-muted-foreground">
                <tr>
                  <th className="w-9 px-2 py-1" aria-hidden="true" />
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
                    label={t("macros.column.activation")}
                    sort={sort}
                    sortKey="activation"
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
                  <th className="w-24 px-4 py-1" aria-label={t("macros.actions")} />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/45 text-body">
                {filteredMacros.map((macro, index) => {
                  const runState = runStateByMacroId.get(macro.id)!;
                  const isActive = runState.isRunning || runState.isStopping;
                  const isSelected = selection.isSelected(macro.id);
                  const isPreviousSelected = index > 0 && selection.isSelected(filteredMacros[index - 1].id);
                  const isNextSelected = index < filteredMacros.length - 1 && selection.isSelected(filteredMacros[index + 1].id);
                  const isSelectionGroupStart = isSelected && !isPreviousSelected;
                  const isSelectionGroupEnd = isSelected && !isNextSelected;
                  const rowTone = isActive
                    ? "bg-activity/[0.08]"
                    : macro.roleIds.length === 0
                      ? "bg-warning/35"
                      : isSelected
                        ? "bg-activity/10"
                        : undefined;

                  return (
                    <tr
                      key={macro.id}
                      ref={selection.registerItem(macro.id)}
                      className={cn(
                        "group align-middle transition-[background-color,box-shadow,opacity]",
                        rowTone,
                        isSelected && [
                          "[&>td:first-child]:border-l [&>td:first-child]:border-l-activity/80",
                          "[&>td:last-child]:border-r [&>td:last-child]:border-r-activity/80"
                        ],
                        isSelectionGroupStart && "[&>td]:border-t [&>td]:border-t-activity/80",
                        isSelectionGroupEnd && "[&>td]:border-b [&>td]:border-b-activity/80",
                        !macro.enabled && "opacity-[0.55]"
                      )}
                      data-macro-active={isActive ? "true" : undefined}
                      data-macro-disabled={!macro.enabled ? "true" : undefined}
                      data-macro-unassigned={macro.roleIds.length === 0 ? "true" : undefined}
                      data-selection-group-start={isSelectionGroupStart ? "true" : undefined}
                      data-selection-group-end={isSelectionGroupEnd ? "true" : undefined}
                      data-selection-id={macro.id}
                      onClickCapture={(event) => selection.handleItemClick(event, macro.id)}
                    >
                    <td className="relative w-9 p-0">
                      <div className="absolute inset-0 grid place-items-center" data-macro-selection-control>
                        <SelectionToggle
                          alwaysVisible
                          isSelected={selection.isSelected(macro.id)}
                          label={t(selection.isSelected(macro.id) ? "selection.deselectItem" : "selection.selectItem")
                            .replace("{name}", macro.name)}
                          onToggle={() => selection.toggleSelection(macro.id)}
                        />
                      </div>
                    </td>
                    <td className="relative max-w-[240px] px-4 py-2 align-middle">
                      <div className="min-w-0 pl-9" data-macro-name-control>
                        <div
                          className="absolute inset-y-0 left-4 flex items-center"
                          data-macro-run-control
                        >
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
                    <td className="px-4 py-2 align-middle text-muted-foreground">
                      <span className="block">
                        {macro.trigger ? formatMacroShortcut(macro.trigger, t) : t("macros.noShortcutShort")}
                      </span>
                    </td>
                    <td className="px-4 py-2 align-middle text-muted-foreground">
                      {formatMacroActivationMode(macro.activationMode, t)}
                    </td>
                    <td className="px-4 py-2 align-middle text-muted-foreground">
                      {formatMacroRepeat(macro.repeat, t)}
                    </td>
                    <td className="max-w-[320px] px-4 py-2 align-middle text-muted-foreground">
                      {summarizeMacroSteps(macro.steps, t, macroNameById)}
                    </td>
                    <td className="relative w-24 p-0">
                      <div className="absolute inset-0 flex items-center justify-end gap-2 px-3" data-macro-actions-control>
                        {onSetMacroEnabled ? (
                          <div className="grid place-items-center" data-macro-enabled-control>
                            <Switch
                              checked={macro.enabled}
                              disabled={busyMacroIds.has(macro.id)}
                              title={t(macro.enabled ? "macros.disable" : "macros.enable")}
                              aria-label={t(macro.enabled ? "macros.disableNamed" : "macros.enableNamed")
                                .replace("{name}", macro.name)}
                              onCheckedChange={(enabled) => onSetMacroEnabled?.(macro, enabled)}
                            />
                          </div>
                        ) : null}
                        <MacroActionMenu
                          busyMacroIds={busyMacroIds}
                          macro={macro}
                          isActive={isActive}
                          onCopy={() => onCopyMacro(macro)}
                          onDelete={() => onDeleteMacro(macro)}
                          onEdit={() => onEditMacro(macro)}
                          t={t}
                        />
                      </div>
                    </td>
                    </tr>
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
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
    </PageFrame>
  );
}

export default MacrosRoute;
