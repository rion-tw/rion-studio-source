import {
  Copy,
  LayoutDashboard,
  Loader2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  ZoomIn
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type RefCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Card, CardTitle } from "../../components/ui/card";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { EmptyState } from "../../components/EmptyState";
import { SelectionActionBar, SelectionMarquee, SelectionToggle } from "../../components/ListSelection";
import { SearchField } from "../../components/SearchField";
import { moveItemById } from "../../app/reorderItems";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  Game,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  Role,
  RoleStatus,
  WorkspaceDisplayInfo,
  WorkspaceLayoutTemplate
} from "../../../../shared/types";
import { getWorkspaceTargetDisplayPresentation } from "./workspaceDisplayUtils";
import { createWorkspaceSlotBackground, getWorkspaceSplits } from "./workspaceLayoutUtils";
import { workspaceTemplateIcons, workspaceTemplateLabelKeys } from "./workspaceConstants";
import { useListSelection } from "../../hooks/useListSelection";

interface LaunchWorkspacesViewProps {
  busyWorkspaceIds: ReadonlySet<string>;
  games: Game[];
  isReordering: boolean;
  query: string;
  roles: Role[];
  scrollPositionRef: MutableRefObject<number>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaces: LaunchWorkspace[];
  workspaceDisplays: WorkspaceDisplayInfo[];
  onCopyWorkspace: (workspace: LaunchWorkspace) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: (workspace: LaunchWorkspace) => void;
  onDeleteWorkspaces: (workspaces: LaunchWorkspace[]) => Promise<boolean>;
  onEditWorkspace: (workspace: LaunchWorkspace) => void;
  onLaunchWorkspace: (workspace: LaunchWorkspace) => void;
  onQueryChange: (query: string) => void;
  onReorderWorkspaces: (orderedIds: string[]) => void;
  onStopWorkspace: (workspace: LaunchWorkspace) => void;
}

function LaunchWorkspacesView({
  busyWorkspaceIds,
  games,
  isReordering,
  query,
  roles,
  scrollPositionRef,
  statusByRole,
  t,
  workspaces,
  workspaceDisplays,
  onCopyWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  onDeleteWorkspaces,
  onEditWorkspace,
  onLaunchWorkspace,
  onQueryChange,
  onReorderWorkspaces,
  onStopWorkspace
}: LaunchWorkspacesViewProps): JSX.Element {
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const gameNameById = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropTargetWorkspaceId, setDropTargetWorkspaceId] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const filteredWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return workspaces;
    }

    return workspaces.filter((workspace) => {
      const assignedRoleNames = workspace.slots
        .map((slot) => (slot.roleId ? roleById.get(slot.roleId)?.name : ""))
        .filter(Boolean);

      return [workspace.name, t(workspaceTemplateLabelKeys[workspace.template]), ...assignedRoleNames]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [query, roleById, t, workspaces]);
  const selection = useListSelection({
    orderedIds: filteredWorkspaces.map((workspace) => workspace.id),
    scrollContainerRef: pageRef
  });
  const canReorder = query.trim() === "" && !isReordering && !selection.hasSelection && workspaces.length > 1;

  function clearDragState(): void {
    setDraggedWorkspaceId(null);
    setDropTargetWorkspaceId(null);
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, workspaceId: string): void {
    if (!canReorder) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-rion-workspace-order", workspaceId);
    setDraggedWorkspaceId(workspaceId);
    setDropTargetWorkspaceId(null);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, workspaceId: string): void {
    if (!draggedWorkspaceId || draggedWorkspaceId === workspaceId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetWorkspaceId(workspaceId);
  }

  function handleDrop(event: DragEvent<HTMLElement>, workspaceId: string): void {
    event.preventDefault();

    if (draggedWorkspaceId && draggedWorkspaceId !== workspaceId) {
      const nextWorkspaces = moveItemById(workspaces, draggedWorkspaceId, workspaceId);
      onReorderWorkspaces(nextWorkspaces.map((workspace) => workspace.id));
    }

    clearDragState();
  }

  async function handleDeleteSelected(): Promise<void> {
    const selectedWorkspaces = filteredWorkspaces.filter((workspace) => selection.selectedIds.has(workspace.id));
    const completed = await onDeleteWorkspaces(selectedWorkspaces);
    if (completed) {
      selection.clearSelection();
    }
  }

  if (workspaces.length === 0) {
    return (
      <PageFrame containerRef={pageRef} contentClassName="grid min-h-full place-items-center" scrollPositionRef={scrollPositionRef}>
        <EmptyState
          className="min-h-0"
          icon={LayoutDashboard}
          title={t("workspaces.empty.title")}
          description={t("workspaces.empty.description")}
          actionLabel={t("workspaces.empty.action")}
          onAction={onCreateWorkspace}
        />
      </PageFrame>
    );
  }

  return (
    <PageFrame containerRef={pageRef} scrollPositionRef={scrollPositionRef} {...selection.collectionProps}>
      <PageHeader
        kicker={t("app.navigation.play")}
        title={t("workspaces.title")}
        description={t("workspaces.description")}
        actions={
          <>
            <SearchField
              className="w-full sm:w-44 lg:w-48"
              placeholder={t("workspaces.searchPlaceholder")}
              value={query}
              onChange={onQueryChange}
            />
            <Button
              className="flex-1 gap-1.5 px-2.5 sm:flex-none"
              type="button"
              variant="outline"
              onClick={onCreateWorkspace}
            >
              <Plus size={14} />
              {t("workspaces.newWorkspace")}
            </Button>
          </>
        }
      />

      {selection.hasSelection ? (
        <SelectionActionBar
          isBusy={[...selection.selectedIds].some((id) => busyWorkspaceIds.has(id))}
          selectedCount={selection.selectedIds.size}
          t={t}
          totalCount={filteredWorkspaces.length}
          onClear={selection.clearSelection}
          onDelete={() => void handleDeleteSelected()}
          onSelectAll={selection.selectAll}
        />
      ) : null}

      {filteredWorkspaces.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("workspaces.noMatches.title")}
          description={t("workspaces.noMatches.description")}
          actionLabel={t("workspaces.noMatches.action")}
          onAction={() => onQueryChange("")}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredWorkspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              busyWorkspaceIds={busyWorkspaceIds}
              canReorder={canReorder}
              isDragging={draggedWorkspaceId === workspace.id}
              isDropTarget={dropTargetWorkspaceId === workspace.id}
              isSelected={selection.isSelected(workspace.id)}
              gameNameById={gameNameById}
              roleById={roleById}
              statusByRole={statusByRole}
              t={t}
              workspace={workspace}
              workspaceDisplays={workspaceDisplays}
              selectionRef={selection.registerItem(workspace.id)}
              onCopy={() => onCopyWorkspace(workspace)}
              onDelete={() => onDeleteWorkspace(workspace)}
              onEdit={() => onEditWorkspace(workspace)}
              onLaunch={() => onLaunchWorkspace(workspace)}
              onDragEnd={clearDragState}
              onDragOver={(event) => handleDragOver(event, workspace.id)}
              onDragStart={(event) => handleDragStart(event, workspace.id)}
              onDrop={(event) => handleDrop(event, workspace.id)}
              onStop={() => onStopWorkspace(workspace)}
              onSelectionClick={(event) => selection.handleItemClick(event, workspace.id)}
              onToggleSelection={() => selection.toggleSelection(workspace.id)}
            />
          ))}
        </div>
      )}
      <SelectionMarquee rect={selection.selectionRect} />
    </PageFrame>
  );
}

interface WorkspaceCardProps {
  busyWorkspaceIds: ReadonlySet<string>;
  gameNameById: Map<string, string>;
  canReorder: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  isSelected: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onLaunch: () => void;
  onStop: () => void;
  onSelectionClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onToggleSelection: () => void;
  roleById: Map<string, Role>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  selectionRef: RefCallback<HTMLElement>;
  workspace: LaunchWorkspace;
  workspaceDisplays: WorkspaceDisplayInfo[];
}

function WorkspaceCard({
  busyWorkspaceIds,
  gameNameById,
  canReorder,
  isDragging,
  isDropTarget,
  isSelected,
  onCopy,
  onDelete,
  onEdit,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onLaunch,
  onStop,
  onSelectionClick,
  onToggleSelection,
  roleById,
  statusByRole,
  t,
  selectionRef,
  workspace,
  workspaceDisplays
}: WorkspaceCardProps): JSX.Element {
  const assignedCount = workspace.slots.filter((slot) => slot.roleId).length;
  const runningCount = workspace.slots.filter((slot) => slot.roleId && statusByRole.has(slot.roleId)).length;
  const isRunning = runningCount > 0;
  const isBusy = busyWorkspaceIds.has(workspace.id);
  const LayoutIcon = workspaceTemplateIcons[workspace.template];
  const layoutTitle = t(workspaceTemplateLabelKeys[workspace.template]);
  const primaryActionLabel = isRunning ? t("workspaces.stop") : t("workspaces.launch");
  const zoomTitle = `${t("workspaces.browserZoom")}: ${workspace.browserZoomPercent}%`;
  const targetDisplay = getWorkspaceTargetDisplayPresentation(workspace.targetDisplayId, workspaceDisplays, t);

  return (
    <Card
      ref={selectionRef}
      className={cn(
        "group relative overflow-visible glass-panel-strong transition-[box-shadow,opacity] duration-150",
        isDragging && "opacity-45",
        (isDropTarget || isSelected) && "ring-2 ring-blue-500/70 ring-offset-2 ring-offset-background"
      )}
      data-selection-id={workspace.id}
      onClickCapture={onSelectionClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <SelectionToggle
        className="absolute left-3 top-3 z-30"
        isSelected={isSelected}
        label={t(isSelected ? "selection.deselectItem" : "selection.selectItem").replace("{name}", workspace.name)}
        onToggle={onToggleSelection}
      />
      <div className="relative overflow-hidden rounded-t-lg">
        <WorkspaceLayoutPreview
          className="aspect-[4/3] p-2"
          gameNameById={gameNameById}
          roleById={roleById}
          slots={workspace.slots}
          t={t}
          template={workspace.template}
        />

        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <Button
            aria-label={primaryActionLabel}
            className={cn(
              "pointer-events-auto size-16 rounded-full border border-white/35 bg-black/35 p-0 text-white shadow-lg backdrop-blur-md",
              "transition-[opacity,transform,background-color] duration-150 hover:bg-black/50 hover:text-white",
              isRunning
                ? "opacity-100"
                : "opacity-0 group-hover:scale-105 group-hover:opacity-100 group-focus-within:scale-105 group-focus-within:opacity-100"
            )}
            disabled={isBusy || assignedCount === 0}
            title={primaryActionLabel}
            type="button"
            variant="secondary"
            onClick={isRunning ? onStop : onLaunch}
          >
            {isBusy ? (
              <Loader2 className="spin" size={30} />
            ) : isRunning ? (
              <Square size={30} fill="currentColor" />
            ) : (
              <Play className="ml-0.5" size={34} fill="currentColor" />
            )}
          </Button>
        </div>
      </div>

      <div className="pointer-events-none absolute right-3 top-3 z-30 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <WorkspaceActionMenu
          canReorder={canReorder}
          isDragging={isDragging}
          isBusy={isBusy}
          t={t}
          onCopy={onCopy}
          onDelete={onDelete}
          onEdit={onEdit}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
        />
      </div>

      <div className="glass-divider border-t p-3.5">
        <CardTitle className="min-w-0 truncate">
          <button
            className="block max-w-full truncate rounded-sm text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            type="button"
            onClick={onEdit}
          >
            {workspace.name}
          </button>
        </CardTitle>

        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <Badge
            aria-label={layoutTitle}
            className="min-w-0 max-w-[45%] gap-1.5"
            title={layoutTitle}
            variant="secondary"
          >
            <LayoutIcon className="shrink-0" size={12} aria-hidden="true" />
            <span className="min-w-0 truncate">{layoutTitle}</span>
          </Badge>
          <Badge
            aria-label={zoomTitle}
            className="shrink-0 gap-1.5"
            title={zoomTitle}
            variant="secondary"
          >
            <ZoomIn size={12} aria-hidden="true" />
            <span>{workspace.browserZoomPercent}%</span>
          </Badge>
          {workspace.targetDisplayId !== undefined ? (
            <Badge
              aria-label={targetDisplay.title}
              className="min-w-0 max-w-full gap-1.5"
              title={targetDisplay.title}
              variant={targetDisplay.isUnavailable ? "warning" : "secondary"}
            >
              <Monitor className="shrink-0" size={12} aria-hidden="true" />
              <span className="min-w-0 truncate">{targetDisplay.label}</span>
            </Badge>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

interface WorkspaceLayoutPreviewProps {
  className?: string;
  gameNameById: Map<string, string>;
  roleById: Map<string, Role>;
  slots: LaunchWorkspaceSlot[];
  t: Translator;
  template: WorkspaceLayoutTemplate;
}

function WorkspaceLayoutPreview({
  className,
  gameNameById,
  roleById,
  slots,
  t,
  template
}: WorkspaceLayoutPreviewProps): JSX.Element {
  const splits = getWorkspaceSplits(template, slots);
  const splitX = splits.vertical[0] ?? 1;
  const splitX2 = splits.vertical[1] ?? 1;
  const splitY = splits.horizontal[0] ?? 1;

  function renderSlot(slot: LaunchWorkspaceSlot | undefined, index: number): JSX.Element | null {
    if (!slot) {
      return null;
    }

    const role = slot.roleId ? roleById.get(slot.roleId) : undefined;

    return (
      <WorkspaceLayoutPreviewSlot
        key={slot.id}
        index={index}
        launchGameName={role ? gameNameById.get(role.gameId) : undefined}
        role={role}
        t={t}
      />
    );
  }

  function renderSplitRow(topSlotIndex: number, bottomSlotIndex: number): JSX.Element {
    return (
      <div className="flex h-full min-h-0 min-w-0 gap-1">
        <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX)}>
          {renderSlot(slots[topSlotIndex], topSlotIndex)}
        </div>
        <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitX)}>
          {renderSlot(slots[bottomSlotIndex], bottomSlotIndex)}
        </div>
      </div>
    );
  }

  function renderGridRow(startSlotIndex: number, slotCount: number): JSX.Element {
    return (
      <div className="flex h-full min-h-0 min-w-0 gap-1">
        {slots.slice(startSlotIndex, startSlotIndex + slotCount).map((slot, offset) => (
          <div key={slot.id} className="min-h-0 min-w-0" style={createPreviewFlexStyle(slot.rect.width)}>
            {renderSlot(slot, startSlotIndex + offset)}
          </div>
        ))}
      </div>
    );
  }

  function renderLayout(): JSX.Element {
    switch (template) {
      case "single":
        return <div className="flex h-full min-h-0">{renderSlot(slots[0], 0)}</div>;
      case "two_columns":
        return (
          <div className="flex h-full min-h-0 gap-1">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitX)}>
              {renderSlot(slots[1], 1)}
            </div>
          </div>
        );
      case "main_left_stack_right":
        return (
          <div className="flex h-full min-h-0 gap-1">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col gap-1" style={createPreviewFlexStyle(1 - splitX)}>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
                {renderSlot(slots[1], 1)}
              </div>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
                {renderSlot(slots[2], 2)}
              </div>
            </div>
          </div>
        );
      case "main_right_stack_left":
        return (
          <div className="flex h-full min-h-0 gap-1">
            <div className="flex min-h-0 min-w-0 flex-col gap-1" style={createPreviewFlexStyle(splitX)}>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
                {renderSlot(slots[1], 1)}
              </div>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
                {renderSlot(slots[2], 2)}
              </div>
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
          </div>
        );
      case "main_center_side_stacks":
        return (
          <div className="flex h-full min-h-0 gap-1">
            <div className="flex min-h-0 min-w-0 flex-col gap-1" style={createPreviewFlexStyle(splitX)}>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
                {renderSlot(slots[1], 1)}
              </div>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
                {renderSlot(slots[2], 2)}
              </div>
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX2 - splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col gap-1" style={createPreviewFlexStyle(1 - splitX2)}>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
                {renderSlot(slots[3], 3)}
              </div>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
                {renderSlot(slots[4], 4)}
              </div>
            </div>
          </div>
        );
      case "quad":
        return (
          <div className="flex h-full min-h-0 flex-col gap-1">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
              {renderSplitRow(0, 1)}
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
              {renderSplitRow(2, 3)}
            </div>
          </div>
        );
      case "three_top_two_bottom":
      case "two_top_three_bottom": {
        const topColumnCount = template === "three_top_two_bottom" ? 3 : 2;
        const bottomColumnCount = 5 - topColumnCount;
        return (
          <div className="flex h-full min-h-0 flex-col gap-1">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
              {renderGridRow(0, topColumnCount)}
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
              {renderGridRow(topColumnCount, bottomColumnCount)}
            </div>
          </div>
        );
      }
      case "six_grid":
      case "eight_grid": {
        const columnCount = template === "eight_grid" ? 4 : 3;
        return (
          <div className="flex h-full min-h-0 flex-col gap-1">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
              {renderGridRow(0, columnCount)}
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
              {renderGridRow(columnCount, columnCount)}
            </div>
          </div>
        );
      }
      case "three_columns":
      case "four_columns":
        return (
          <div className="flex h-full min-h-0 gap-1">
            {slots.map((slot, index) => (
              <div key={slot.id} className="min-h-0 min-w-0" style={createPreviewFlexStyle(slot.rect.width)}>
                {renderSlot(slot, index)}
              </div>
            ))}
          </div>
        );
    }
  }

  return (
    <div className={cn("relative bg-background/30", className)}>
      {renderLayout()}
    </div>
  );
}

interface WorkspaceLayoutPreviewSlotProps {
  index: number;
  launchGameName?: string;
  role: Role | undefined;
  t: Translator;
}

function WorkspaceLayoutPreviewSlot({ index, launchGameName, role, t }: WorkspaceLayoutPreviewSlotProps): JSX.Element {
  const resolvedLaunchGameName = launchGameName ?? role?.launchUrl ?? "";
  const backgroundStyle = createWorkspaceSlotBackground(role);
  const style = {
    "--workspace-slot-caption-bottom-left-radius": "0px",
    "--workspace-slot-caption-bottom-right-radius": "0px"
  } as CSSProperties & Record<"--workspace-slot-caption-bottom-left-radius" | "--workspace-slot-caption-bottom-right-radius", string>;

  return (
    <div
      className={cn(
        "relative isolate h-full min-h-0 w-full min-w-0 overflow-hidden",
        role ? "shadow-sm ring-1 ring-inset ring-border/60" : "border border-dashed border-muted-foreground/35 bg-muted/30"
      )}
      style={style}
    >
      {role ? (
        <div
          className="absolute inset-0 bg-cover bg-center transition-transform duration-300 ease-out group-hover:scale-[1.03]"
          style={backgroundStyle}
          aria-hidden="true"
        />
      ) : null}
      <div className="workspace-slot-caption workspace-slot-caption--compact">
        <p className="workspace-slot-caption-title gap-1.5 text-[11px] font-semibold leading-4">
          {role ? (
            <span className="workspace-role-chip-text">
              <span className="min-w-0 truncate">{role.name}</span>
              <span className="workspace-role-game-label min-w-0 truncate">{resolvedLaunchGameName}</span>
            </span>
          ) : (
            t("workspaces.emptySlot")
          )}
        </p>
      </div>
      {!role ? (
        <div className="absolute left-2 top-2 bg-background/55 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {index + 1}
        </div>
      ) : null}
    </div>
  );
}

function createPreviewFlexStyle(weight: number): CSSProperties {
  return {
    flexBasis: 0,
    flexGrow: Math.max(weight, 0.001)
  };
}

interface WorkspaceActionMenuProps {
  canReorder: boolean;
  isDragging: boolean;
  isBusy: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  t: Translator;
}

function WorkspaceActionMenu({
  canReorder,
  isBusy,
  isDragging,
  onCopy,
  onDelete,
  onDragEnd,
  onDragStart,
  onEdit,
  t
}: WorkspaceActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const didDragRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (menuRef.current?.contains(event.target as Node)) {
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

  function handleButtonDragStart(event: DragEvent<HTMLButtonElement>): void {
    didDragRef.current = true;
    setIsOpen(false);
    onDragStart(event);
  }

  function handleButtonDragEnd(): void {
    onDragEnd();
    window.setTimeout(() => {
      didDragRef.current = false;
    }, 0);
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        className={cn(
          "h-7 w-7",
          canReorder && "cursor-grab active:cursor-grabbing",
          isDragging && "cursor-grabbing"
        )}
        type="button"
        variant="secondary"
        size="icon"
        title={t(canReorder ? "workspaces.actionsAndReorder" : "workspaces.actions")}
        aria-label={t(canReorder ? "workspaces.actionsAndReorder" : "workspaces.actions")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        draggable={canReorder}
        onClick={() => {
          if (!didDragRef.current) {
            setIsOpen((current) => !current);
          }
        }}
        onDragEnd={handleButtonDragEnd}
        onDragStart={handleButtonDragStart}
      >
        <MoreHorizontal size={14} />
      </Button>

      {isOpen ? (
        <Surface
          className="absolute right-0 top-8 z-20 min-w-32 overflow-hidden text-popover-foreground"
          padding="xs"
          variant="popover"
          role="menu"
        >
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground"
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onEdit();
            }}
          >
            <Pencil size={14} />
            <span>{t("workspaces.edit")}</span>
          </button>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onCopy();
            }}
            disabled={isBusy}
          >
            <Copy size={14} />
            <span>{t("workspaces.copy")}</span>
          </button>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onDelete();
            }}
            disabled={isBusy}
          >
            <Trash2 size={14} />
            <span>{t("workspaces.delete")}</span>
          </button>
        </Surface>
      ) : null}
    </div>
  );
}

export default LaunchWorkspacesView;
