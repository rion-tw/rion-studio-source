import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Keyboard,
  Pause,
  Play,
  Plus,
  Search,
  ToggleLeft,
  ToggleRight
} from "lucide-react";
import {
  type JSX,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { EmptyState } from "../../components/EmptyState";
import {
  SelectionActionBar,
  SelectionGroupOutlines,
  SelectionMarquee
} from "../../components/ListSelection";
import { SearchField } from "../../components/SearchField";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { useListSelection } from "../../hooks/useListSelection";
import type { Translator } from "../../i18n";
import { findUnassignedMacroDependency } from "../../../../shared/macroDependencies";
import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";
import {
  createMacroListRunActionState,
  type MacroListRunActionState,
  MacroRoleBadge,
  MacroSortHeader
} from "./MacroListControls";
import { MacroListRow } from "./MacroListRow";
import {
  getMacroListGroups,
  getMacroListItems,
  type MacroListGroup,
  type MacroListSortKey,
  type MacroListSortState,
  type MacroListViewMode
} from "./macroListUtils";
import { isMacroRunActive } from "./macroUtils";

const ALL_ROLES_SELECT_VALUE = "__all_roles__";

interface MacrosRouteProps {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  collapsedGroupKeys?: ReadonlySet<string>;
  focusedMacroId?: string | null;
  isFocusBlocked?: boolean;
  macroStatusByRun: Map<string, MacroRunStatus>;
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  query: string;
  roleFilterId: string;
  scrollPositionRef: MutableRefObject<number>;
  sort: MacroListSortState;
  viewMode?: MacroListViewMode;
  onCopyMacro: (macro: Macro) => void;
  onDeleteMacro: (macro: Macro) => void;
  onDeleteMacros: (macros: Macro[]) => Promise<boolean>;
  onEditMacro: (macro: Macro) => void;
  onNewMacro: (roleIds?: readonly string[]) => void;
  onQueryChange: (query: string) => void;
  onRoleFilterChange: (roleId: string) => void;
  onSetMacroEnabled?: (macro: Macro, enabled: boolean) => void;
  onSetMacrosEnabled?: (macros: Macro[], enabled: boolean) => Promise<void>;
  onSortChange: (sort: MacroListSortState) => void;
  onStartMacro: (macroId: string) => void;
  onStartMacros?: (macros: Macro[]) => Promise<unknown>;
  onStopMacro: (macroId: string) => void;
  onStopMacros?: (macros: Macro[]) => Promise<void>;
  onToggleGroup?: (groupKey: string) => void;
  onViewModeChange?: (viewMode: MacroListViewMode) => void;
  onMacroFocused?: () => void;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

function MacrosRoute({
  busyMacroIds,
  busyRunKeys,
  collapsedGroupKeys = new Set(),
  focusedMacroId,
  isFocusBlocked = false,
  macroStatusByRun,
  macroStatuses,
  macros,
  query,
  roleFilterId,
  scrollPositionRef,
  sort,
  viewMode = "grouped",
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
  onToggleGroup,
  onViewModeChange,
  onMacroFocused,
  roles,
  statusByRole,
  t
}: MacrosRouteProps): JSX.Element {
  const pageRef = useRef<HTMLElement | null>(null);
  const [macroListContainer, setMacroListContainer] = useState<HTMLDivElement | null>(null);
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
  const listOptions = useMemo(
    () => ({ macros, query, roleFilterId, roles, sort, t }),
    [macros, query, roleFilterId, roles, sort, t]
  );
  const filteredMacros = useMemo(() => getMacroListItems(listOptions), [listOptions]);
  const groups = useMemo(() => getMacroListGroups(listOptions), [listOptions]);
  const forceGroupsExpanded = query.trim().length > 0 || roleFilterId.length > 0;
  const visibleMacros = useMemo(
    () => viewMode === "flat"
      ? filteredMacros
      : groups.flatMap((group) =>
          !forceGroupsExpanded && collapsedGroupKeys.has(group.key) ? [] : group.macros
        ),
    [collapsedGroupKeys, filteredMacros, forceGroupsExpanded, groups, viewMode]
  );
  const visibleMacroIds = useMemo(() => visibleMacros.map((macro) => macro.id), [visibleMacros]);

  useEffect(() => {
    if (!focusedMacroId || isFocusBlocked) return;
    const row = pageRef.current?.querySelector<HTMLElement>(
      `[data-macro-id="${CSS.escape(focusedMacroId)}"]`
    );
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
    onMacroFocused?.();
  }, [focusedMacroId, isFocusBlocked, onMacroFocused, visibleMacroIds]);
  const selection = useListSelection({
    orderedIds: visibleMacroIds,
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
        ? { direction: sort.direction === "asc" ? "desc" : "asc", key }
        : { direction: "asc", key }
    );
  }

  async function handleDeleteSelected(): Promise<void> {
    const completed = await onDeleteMacros(selectedMacros);
    if (completed) selection.clearSelection();
  }

  async function handleStartSelected(): Promise<void> {
    if (onStartMacros) await onStartMacros(startableMacros);
    else startableMacros.forEach((macro) => onStartMacro(macro.id));
  }

  async function handleStopSelected(): Promise<void> {
    if (onStopMacros) await onStopMacros(stoppableMacros);
    else stoppableMacros.forEach((macro) => onStopMacro(macro.id));
  }

  async function handleEnableSelected(): Promise<void> {
    if (onSetMacrosEnabled) await onSetMacrosEnabled(enableableMacros, true);
    else enableableMacros.forEach((macro) => onSetMacroEnabled?.(macro, true));
  }

  async function handleDisableSelected(): Promise<void> {
    if (onSetMacrosEnabled) await onSetMacrosEnabled(disableableMacros, false);
    else disableableMacros.forEach((macro) => onSetMacroEnabled?.(macro, false));
  }

  function handleNewMacro(): void {
    onNewMacro(roleFilterId ? [roleFilterId] : undefined);
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
              value={viewMode}
              onValueChange={(value) => onViewModeChange?.(value as MacroListViewMode)}
            >
              <SelectTrigger className="macro-view-select page-header-control page-header-select" aria-label={t("macros.view.label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="grouped">{t("macros.view.grouped")}</SelectItem>
                <SelectItem value="flat">{t("macros.view.flat")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={roleFilterId || ALL_ROLES_SELECT_VALUE} onValueChange={(value) => onRoleFilterChange(value === ALL_ROLES_SELECT_VALUE ? "" : value)}>
              <SelectTrigger className="page-header-control page-header-select" aria-label={t("macros.filterRole")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ROLES_SELECT_VALUE}>{t("macros.filterAllRoles")}</SelectItem>
                {roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button className="page-header-control gap-1.5 px-2.5" type="button" variant="outline" onClick={handleNewMacro}>
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
              <Button type="button" size="sm" variant="ghost" disabled={isSelectionBusy || startableMacros.length === 0} onClick={() => void handleStartSelected()}>
                <Play size={14} fill="currentColor" />
                {t("macros.bulk.runCount").replace("{count}", String(startableMacros.length))}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={isSelectionBusy || stoppableMacros.length === 0} onClick={() => void handleStopSelected()}>
                <Pause size={14} fill="currentColor" />
                {t("macros.bulk.stopCount").replace("{count}", String(stoppableMacros.length))}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={isSelectionBusy || enableableMacros.length === 0} onClick={() => void handleEnableSelected()}>
                <ToggleRight size={14} />
                {t("macros.bulk.enableCount").replace("{count}", String(enableableMacros.length))}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={isSelectionBusy || disableableMacros.length === 0} onClick={() => void handleDisableSelected()}>
                <ToggleLeft size={14} />
                {t("macros.bulk.disableCount").replace("{count}", String(disableableMacros.length))}
              </Button>
            </>
          }
          isBusy={isSelectionBusy}
          selectedCount={selection.selectedIds.size}
          t={t}
          totalCount={visibleMacroIds.length}
          onClear={selection.clearSelection}
          onDelete={() => void handleDeleteSelected()}
          onSelectAll={selection.selectAll}
        />
      ) : null}

      <MacroListToolbar
        macroCount={macros.length}
        runningCount={runningCount}
        t={t}
      />

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
        <div ref={setMacroListContainer} className="relative grid gap-2" data-macro-list-view={viewMode}>
          <Surface className="macro-list-surface w-full overflow-hidden" variant="panel">
            <table className="macro-list-table w-full table-fixed border-collapse text-left text-body">
              <MacroListTableHeader
                showExecutionRoles={viewMode === "flat"}
                sort={sort}
                t={t}
                onSort={handleSortChange}
              />
              {viewMode === "grouped" ? groups.map((group) => (
                <MacroGroup
                  key={group.key}
                  busyMacroIds={busyMacroIds}
                  forceExpanded={forceGroupsExpanded}
                  group={group}
                  isCollapsed={collapsedGroupKeys.has(group.key)}
                  macroNameById={macroNameById}
                  macroStatusByRun={macroStatusByRun}
                  roleById={roleById}
                  runStateByMacroId={runStateByMacroId}
                  selection={selection}
                  statusByRole={statusByRole}
                  t={t}
                  onCopyMacro={onCopyMacro}
                  onDeleteMacro={onDeleteMacro}
                  onEditMacro={onEditMacro}
                  onNewMacro={() => onNewMacro(group.roleIds)}
                  onSetMacroEnabled={onSetMacroEnabled}
                  onStartMacro={onStartMacro}
                  onStopMacro={onStopMacro}
                  onToggle={() => onToggleGroup?.(group.key)}
                />
              )) : (
                <tbody className="divide-y divide-border/45">
                {filteredMacros.map((macro) => (
                  <MacroRowFromState
                    key={macro.id}
                    busyMacroIds={busyMacroIds}
                    macro={macro}
                    macroNameById={macroNameById}
                    macroStatusByRun={macroStatusByRun}
                    roleById={roleById}
                    runState={runStateByMacroId.get(macro.id)!}
                    selection={selection}
                    showExecutionRoles
                    statusByRole={statusByRole}
                    t={t}
                    onCopyMacro={onCopyMacro}
                    onDeleteMacro={onDeleteMacro}
                    onEditMacro={onEditMacro}
                    onSetMacroEnabled={onSetMacroEnabled}
                    onStartMacro={onStartMacro}
                    onStopMacro={onStopMacro}
                  />
                ))}
                </tbody>
              )}
            </table>
          </Surface>
          <Button className="w-fit gap-1.5 border-dashed bg-transparent px-2.5 text-muted-foreground shadow-none hover:text-foreground" type="button" variant="outline" onClick={handleNewMacro}>
            <Plus aria-hidden="true" size={14} />
            <span>{t("macros.newMacro")}</span>
          </Button>
        </div>
      )}
      <SelectionGroupOutlines container={macroListContainer} orderedIds={visibleMacroIds} selectedIds={selection.selectedIds} />
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
    </PageFrame>
  );
}

interface MacroSelectionApi {
  handleItemClick: ReturnType<typeof useListSelection>["handleItemClick"];
  isSelected: ReturnType<typeof useListSelection>["isSelected"];
  registerItem: ReturnType<typeof useListSelection>["registerItem"];
  selectIds: ReturnType<typeof useListSelection>["selectIds"];
}

function MacroListTableHeader({
  showExecutionRoles,
  sort,
  t,
  onSort
}: {
  showExecutionRoles: boolean;
  sort: MacroListSortState;
  t: Translator;
  onSort: (key: MacroListSortKey) => void;
}): JSX.Element {
  return (
    <thead className="glass-divider border-b text-caption uppercase tracking-normal text-muted-foreground">
      <tr>
        <MacroSortHeader
          className="macro-list-column-name"
          label={t("macros.column.name")}
          sort={sort}
          sortKey="name"
          t={t}
          onSort={onSort}
        />
        {showExecutionRoles ? (
          <MacroSortHeader
            className="macro-list-column-roles"
            label={t("macros.column.roles")}
            sort={sort}
            sortKey="roles"
            t={t}
            onSort={onSort}
          />
        ) : null}
        <MacroSortHeader
          className="macro-list-column-shortcut"
          label={t("macros.column.shortcut")}
          sort={sort}
          sortKey="shortcut"
          t={t}
          onSort={onSort}
        />
        <MacroSortHeader
          className="macro-list-column-repeat"
          label={t("macros.column.repeat")}
          sort={sort}
          sortKey="repeat"
          t={t}
          onSort={onSort}
        />
        <MacroSortHeader
          className="macro-list-column-steps"
          label={t("macros.column.steps")}
          sort={sort}
          sortKey="steps"
          t={t}
          onSort={onSort}
        />
        <th className="macro-list-column-actions w-10 px-2 py-2" scope="col" aria-label={t("macros.actions")} />
      </tr>
    </thead>
  );
}

function MacroGroup({
  busyMacroIds,
  forceExpanded,
  group,
  isCollapsed,
  macroNameById,
  macroStatusByRun,
  roleById,
  runStateByMacroId,
  selection,
  statusByRole,
  t,
  onCopyMacro,
  onDeleteMacro,
  onEditMacro,
  onNewMacro,
  onSetMacroEnabled,
  onStartMacro,
  onStopMacro,
  onToggle
}: {
  busyMacroIds: ReadonlySet<string>;
  forceExpanded: boolean;
  group: MacroListGroup;
  isCollapsed: boolean;
  macroNameById: Map<string, string>;
  macroStatusByRun: Map<string, MacroRunStatus>;
  roleById: Map<string, Role>;
  runStateByMacroId: Map<string, MacroListRunActionState>;
  selection: MacroSelectionApi;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onCopyMacro: (macro: Macro) => void;
  onDeleteMacro: (macro: Macro) => void;
  onEditMacro: (macro: Macro) => void;
  onNewMacro: () => void;
  onSetMacroEnabled?: (macro: Macro, enabled: boolean) => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  onToggle: () => void;
}): JSX.Element {
  const expanded = forceExpanded || !isCollapsed;
  const runningCount = group.macros.filter((macro) => runStateByMacroId.get(macro.id)?.isRunning).length;
  const contentId = `macro-group-${encodeURIComponent(group.key)}`;

  return (
    <tbody id={contentId} className="macro-list-group" data-macro-group={group.key}>
      <tr className="macro-list-group-heading border-t border-border/70">
        <td className="p-0" colSpan={5}>
          <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {group.roleIds.length === 0 ? (
                <Badge variant="warning" className="gap-1.5">
                  <CircleAlert aria-hidden="true" size={12} />
                  {t("macros.group.unassigned")}
                </Badge>
              ) : (
                <MacroRoleBadge macro={group.macros[0]} roleIds={group.roleIds} roleById={roleById} statusByRole={statusByRole} t={t} />
              )}
              {runningCount > 0 ? <Badge variant="activity">{t("macros.group.runningCount").replace("{count}", String(runningCount))}</Badge> : null}
            </div>
            <Button className="shrink-0" type="button" size="sm" variant="ghost" onClick={() => selection.selectIds(group.macros.map((macro) => macro.id))}>
              {t("macros.group.selectCount").replace("{count}", String(group.macros.length))}
            </Button>
            <Button
              className="shrink-0"
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("macros.newMacro")}
              title={t("macros.newMacro")}
              onClick={onNewMacro}
            >
              <Plus aria-hidden="true" size={14} />
            </Button>
            <Button
              className="shrink-0"
              type="button"
              size="icon"
              variant="ghost"
              aria-controls={contentId}
              aria-expanded={expanded}
              aria-label={t(expanded ? "macros.group.collapse" : "macros.group.expand")}
              disabled={forceExpanded}
              onClick={onToggle}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </Button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <>
          {group.macros.map((macro) => (
            <MacroRowFromState
              key={macro.id}
              busyMacroIds={busyMacroIds}
              macro={macro}
              macroNameById={macroNameById}
              macroStatusByRun={macroStatusByRun}
              roleById={roleById}
              runState={runStateByMacroId.get(macro.id)!}
              selection={selection}
              showExecutionRoles={false}
              statusByRole={statusByRole}
              t={t}
              onCopyMacro={onCopyMacro}
              onDeleteMacro={onDeleteMacro}
              onEditMacro={onEditMacro}
              onSetMacroEnabled={onSetMacroEnabled}
              onStartMacro={onStartMacro}
              onStopMacro={onStopMacro}
            />
          ))}
        </>
      ) : null}
    </tbody>
  );
}

function MacroRowFromState({
  busyMacroIds,
  macro,
  macroNameById,
  macroStatusByRun,
  roleById,
  runState,
  selection,
  showExecutionRoles,
  statusByRole,
  t,
  onCopyMacro,
  onDeleteMacro,
  onEditMacro,
  onSetMacroEnabled,
  onStartMacro,
  onStopMacro
}: {
  busyMacroIds: ReadonlySet<string>;
  macro: Macro;
  macroNameById: Map<string, string>;
  macroStatusByRun: Map<string, MacroRunStatus>;
  roleById: Map<string, Role>;
  runState: MacroListRunActionState;
  selection: MacroSelectionApi;
  showExecutionRoles: boolean;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onCopyMacro: (macro: Macro) => void;
  onDeleteMacro: (macro: Macro) => void;
  onEditMacro: (macro: Macro) => void;
  onSetMacroEnabled?: (macro: Macro, enabled: boolean) => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
}): JSX.Element {
  return (
    <MacroListRow
      busyMacroIds={busyMacroIds}
      isSelected={selection.isSelected(macro.id)}
      macro={macro}
      macroNameById={macroNameById}
      macroStatusByRun={macroStatusByRun}
      roleById={roleById}
      runState={runState}
      selectionRef={selection.registerItem(macro.id)}
      showExecutionRoles={showExecutionRoles}
      statusByRole={statusByRole}
      t={t}
      onCopy={() => onCopyMacro(macro)}
      onDelete={() => onDeleteMacro(macro)}
      onEdit={() => onEditMacro(macro)}
      onSelectionClick={(event) => selection.handleItemClick(event, macro.id)}
      onSetEnabled={onSetMacroEnabled ? (enabled) => onSetMacroEnabled(macro, enabled) : undefined}
      onStartMacro={onStartMacro}
      onStopMacro={onStopMacro}
    />
  );
}

function MacroListToolbar({
  macroCount,
  runningCount,
  t
}: {
  macroCount: number;
  runningCount: number;
  t: Translator;
}): JSX.Element {
  return (
    <div className="list-toolbar gap-2">
      <div className="flex min-w-0 flex-wrap gap-2 text-caption text-muted-foreground">
        <Badge variant="secondary">{t("macros.count").replace("{count}", String(macroCount))}</Badge>
        <Badge variant="secondary">{t("macros.runningCount").replace("{count}", String(runningCount))}</Badge>
      </div>
    </div>
  );
}

export default MacrosRoute;
