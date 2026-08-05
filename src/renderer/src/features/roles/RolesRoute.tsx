import {
  Copy,
  Eraser,
  Globe2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Upload
} from "lucide-react";
import {
  lazy,
  Suspense,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { Button } from "../../components/ui/button";
import { Card, CardTitle } from "../../components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "../../components/ui/context-menu";
import { PageFrame, PageHeader, SegmentedControl, Surface } from "../../components/ui/patterns";
import { EmptyState } from "../../components/EmptyState";
import { CreateItemCard } from "../../components/CreateListItem";
import {
  SelectionActionBar,
  SelectionCardOverlay,
  SelectionMarquee
} from "../../components/ListSelection";
import { SearchField } from "../../components/SearchField";
import { getGameIconUrl } from "../../app/gamePresentation";
import { moveItemById } from "../../app/reorderItems";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import { type Language, type TranslationKey, type Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Game, Role, RoleStatus } from "../../../../shared/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { AppStats, SidebarFilter } from "../../app/types";
import { createRoleCardStyle } from "./roleCardStyle";
import { useListSelection } from "../../hooks/useListSelection";
import { getPointerDragTargetId, usePointerDrag } from "../../hooks/usePointerDrag";

const filterLabelKeys: Record<SidebarFilter, TranslationKey> = {
  all: "roles.filter.all",
  running: "roles.filter.running",
  stopped: "roles.filter.stopped",
};

const filterOrder: SidebarFilter[] = ["all", "running", "stopped"];

const LazyChromeProfileImportFlow = lazy(() =>
  import("../settings/ChromeProfileImportFlow").then(({ ChromeProfileImportFlow }) => ({
    default: ChromeProfileImportFlow
  }))
);

interface RolesViewProps {
  activeFilter: SidebarFilter;
  busyRoleIds: ReadonlySet<string>;
  filteredRoles: Role[];
  games: Game[];
  isReordering: boolean;
  language?: Language;
  roleStats: AppStats;
  roles: Role[];
  scrollPositionRef: MutableRefObject<number>;
  query: string;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onError: (error: unknown) => void;
  onClearQuery: () => void;
  onClearBrowserData: (role: Role) => void;
  onCopy: (role: Role) => void;
  onDelete: (role: Role) => void;
  onDeleteMany: (roles: Role[]) => Promise<boolean>;
  onEdit: (role: Role) => void;
  onFilterChange: (filter: SidebarFilter) => void;
  onLaunch: (roleId: string) => void;
  onNewRole: () => void;
  onQueryChange: (query: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onStop: (roleId: string) => void;
}

function RolesView({
  activeFilter,
  busyRoleIds,
  filteredRoles,
  games,
  isReordering,
  roleStats,
  roles,
  scrollPositionRef,
  query,
  statusByRole,
  t,
  onClearQuery,
  onClearBrowserData,
  onCopy,
  onDelete,
  onDeleteMany,
  onEdit,
  onError,
  onFilterChange,
  onLaunch,
  onNewRole,
  onQueryChange,
  onReorder,
  onStop
}: RolesViewProps): JSX.Element {
  const [gameFilterId, setGameFilterId] = useState("all");
  const [chromeImportOpen, setChromeImportOpen] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);
  const visibleRoles = gameFilterId === "all" ? filteredRoles : filteredRoles.filter((role) => role.gameId === gameFilterId);
  const selection = useListSelection({
    orderedIds: visibleRoles.map((role) => role.id),
    scrollContainerRef: pageRef
  });
  const gameById = new Map(games.map((game) => [game.id, game]));
  const canReorder = activeFilter === "all" && gameFilterId === "all" && query.trim() === "" && !isReordering && !selection.hasSelection && roles.length > 1;
  const roleDrag = usePointerDrag<string>({
    disabled: !canReorder,
    getScrollContainer: () => pageRef.current,
    getTargetId: (clientX, clientY) =>
      getPointerDragTargetId(clientX, clientY, "data-role-reorder-id"),
    onDrop: (sourceRoleId, targetRoleId) => {
      if (sourceRoleId === targetRoleId) {
        return;
      }
      const nextRoles = moveItemById(roles, sourceRoleId, targetRoleId);
      onReorder(nextRoles.map((role) => role.id));
    }
  });
  const filterCounts: Record<SidebarFilter, number> = {
    all: roleStats.total,
    running: roleStats.running,
    stopped: roleStats.stopped,
  };

  async function handleDeleteSelected(): Promise<void> {
    const selectedRoles = visibleRoles.filter((role) => selection.selectedIds.has(role.id));
    const completed = await onDeleteMany(selectedRoles);
    if (completed) {
      selection.clearSelection();
    }
  }

  const chromeImportFlow = chromeImportOpen ? (
    <Suspense fallback={null}>
      <LazyChromeProfileImportFlow
        games={games}
        onClose={() => setChromeImportOpen(false)}
        onError={onError}
        openOnMount
        roles={roles}
        showTrigger={false}
        t={t}
      />
    </Suspense>
  ) : null;

  if (roles.length === 0) {
    return (
      <PageFrame containerRef={pageRef} contentClassName="grid min-h-full place-items-center" scrollPositionRef={scrollPositionRef}>
        <EmptyState
          className="min-h-0"
          icon={Globe2}
          title={t("roles.empty.title")}
          description={t("roles.empty.description")}
          actionLabel={t("roles.empty.action")}
          onAction={onNewRole}
          onSecondaryAction={() => setChromeImportOpen(true)}
          secondaryActionLabel={t("roles.chromeImport")}
        />
        {chromeImportFlow}
      </PageFrame>
    );
  }

  return (
    <PageFrame containerRef={pageRef} scrollPositionRef={scrollPositionRef} {...selection.collectionProps}>
      <PageHeader
        kicker={t("app.navigation.play")}
        title={t("roles.title")}
        description={t("roles.description")}
        actions={
          <>
            <SearchField
              className="page-header-control page-header-search"
              placeholder={t("roles.searchPlaceholder")}
              value={query}
              onChange={onQueryChange}
            />
            <Button
              className="page-header-control gap-1.5 px-2.5"
              type="button"
              variant="outline"
              onClick={onNewRole}
            >
              <Plus size={14} />
              {t("roles.newRole")}
            </Button>
            <Button
              className="page-header-control gap-1.5 px-2.5"
              type="button"
              variant="outline"
              onClick={() => setChromeImportOpen(true)}
            >
              <Upload size={14} />
              {t("roles.chromeImport")}
            </Button>
          </>
        }
      />

      {selection.hasSelection ? (
        <SelectionActionBar
          isBusy={[...selection.selectedIds].some((id) => busyRoleIds.has(id))}
          selectedCount={selection.selectedIds.size}
          t={t}
          totalCount={visibleRoles.length}
          onClear={selection.clearSelection}
          onDelete={() => void handleDeleteSelected()}
          onSelectAll={selection.selectAll}
        />
      ) : null}

      <div className="list-toolbar gap-2">
        <RoleFilterTabs
          activeFilter={activeFilter}
          counts={filterCounts}
          t={t}
          onFilterChange={onFilterChange}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-2"><Select value={gameFilterId} onValueChange={setGameFilterId}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("roles.gameFilter.all")}</SelectItem>{games.map((game) => <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>)}</SelectContent></Select><p className="text-caption font-medium text-muted-foreground">
          {t("roles.visibleCount")
            .replace("{visible}", String(visibleRoles.length))
            .replace("{total}", String(roles.length))}
        </p></div>
      </div>

      {visibleRoles.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("roles.noMatches.title")}
          description={t("roles.noMatches.description")}
          actionLabel={t("roles.noMatches.action")}
          onAction={onClearQuery}
        />
      ) : (
        <div className="collection-grid collection-grid-roles auto-rows-fr gap-4">
          {visibleRoles.map((role) => {
            const status = statusByRole.get(role.id);
            const isBusy =
              busyRoleIds.has(role.id) ||
              status?.state === "launching" ||
              status?.state === "stopping";

            return (
              <RoleCard
                key={role.id}
                game={gameById.get(role.gameId)}
                role={role}
                status={status}
                canReorder={canReorder}
                isDragging={roleDrag.activePayload === role.id}
                isDropTarget={roleDrag.targetId === role.id && roleDrag.activePayload !== role.id}
                isBusy={isBusy}
                isSelected={selection.isSelected(role.id)}
                selectionRef={selection.registerItem(role.id)}
                t={t}
                onCopy={() => onCopy(role)}
                onClearBrowserData={() => onClearBrowserData(role)}
                onDelete={() => onDelete(role)}
                onEdit={() => onEdit(role)}
                onLaunch={() => onLaunch(role.id)}
                onReorderPointerDown={(event) => roleDrag.start(event, role.id)}
                onStop={() => onStop(role.id)}
                onSelectionClick={(event) => selection.handleItemClick(event, role.id)}
              />
            );
          })}
          <CreateItemCard className="aspect-[4/5]" label={t("roles.newRole")} onClick={onNewRole} />
        </div>
      )}
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
      {chromeImportFlow}
    </PageFrame>
  );
}

interface RoleFilterTabsProps {
  activeFilter: SidebarFilter;
  counts: Record<SidebarFilter, number>;
  t: Translator;
  onFilterChange: (filter: SidebarFilter) => void;
}

function RoleFilterTabs({ activeFilter, counts, t, onFilterChange }: RoleFilterTabsProps): JSX.Element {
  return (
    <SegmentedControl<SidebarFilter>
      className="w-full grid-cols-2 sm:w-[420px] sm:shrink-0 sm:grid-cols-4"
      items={filterOrder.map((filter) => ({
        value: filter,
        label: t(filterLabelKeys[filter]),
        count: counts[filter]
      }))}
      value={activeFilter}
      onValueChange={onFilterChange}
    />
  );
}

interface RoleCardProps {
  game?: Game;
  canReorder: boolean;
  isBusy: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  isSelected: boolean;
  onCopy: () => void;
  onClearBrowserData: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onReorderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onLaunch: () => void;
  onStop: () => void;
  onSelectionClick: (event: ReactMouseEvent<HTMLElement>) => void;
  role: Role;
  status?: RoleStatus;
  selectionRef: RefCallback<HTMLElement>;
  t: Translator;
}

function RoleCard({
  game,
  canReorder,
  isBusy,
  isDragging,
  isDropTarget,
  isSelected,
  onCopy,
  onClearBrowserData,
  onDelete,
  onEdit,
  onReorderPointerDown,
  onLaunch,
  onStop,
  onSelectionClick,
  role,
  status,
  selectionRef,
  t
}: RoleCardProps): JSX.Element {
  const isActive = Boolean(status);
  const coverImageUrl = role.coverImageDataUrl ?? roleCoverPlaceholderUrl;
  const canUsePrimaryOverlayAction = true;
  const hasBottomAction = false;
  const primaryActionLabel = isActive ? t("role.stop") : t("role.launch");
  const cardStyle = createRoleCardStyle({
    color: role.coverImageDominantColor ?? DEFAULT_ROLE_COVER_COLOR,
    hasCoverImage: true,
    isActive
  });
  const gameIconUrl = getGameIconUrl(game);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={isDragging}>
        <Card
          ref={selectionRef}
          className={cn(
            "role-cover-card group relative aspect-[4/5] overflow-hidden transition-[box-shadow,opacity] duration-150 [contain:paint]",
            isDragging && "opacity-45",
            isDropTarget && "ring-2 ring-activity/70 ring-offset-2 ring-offset-background"
          )}
          data-selection-id={role.id}
          data-role-reorder-id={role.id}
          style={cardStyle}
          onClickCapture={onSelectionClick}
        >
      <img
        alt=""
        aria-hidden="true"
        className="absolute inset-0 size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
        decoding="async"
        draggable={false}
        loading="lazy"
        src={coverImageUrl}
      />

      <SelectionCardOverlay isSelected={isSelected} />

      <div
        className="pointer-events-none absolute right-3 top-3 z-[var(--layer-tooltip)] opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        data-role-action-layer
      >
        <RoleActionMenu
          canReorder={canReorder}
          isDragging={isDragging}
          isBusy={isBusy}
          isOnCover
          t={t}
          onCopy={onCopy}
          onClearBrowserData={onClearBrowserData}
          onDelete={onDelete}
          onEdit={onEdit}
          onReorderPointerDown={onReorderPointerDown}
        />
      </div>

      {canUsePrimaryOverlayAction ? (
        <div
          className="pointer-events-none absolute inset-0 z-[var(--layer-popover)] grid place-items-center"
          data-role-primary-action-layer
        >
          <Button
            className={cn(
              "pointer-events-auto size-16 rounded-full p-0 shadow-lg transition-[opacity,transform,background-color] duration-150",
              isActive
                ? "opacity-100"
                : "opacity-0 group-hover:scale-105 group-hover:opacity-100 group-focus-within:scale-105 group-focus-within:opacity-100",
              "text-on-media hover:text-on-media"
            )}
            type="button"
            variant="media"
            title={primaryActionLabel}
            aria-label={primaryActionLabel}
            onClick={isActive ? onStop : onLaunch}
            disabled={isBusy}
          >
            {isBusy ? (
              <Loader2 className="spin" size={30} />
            ) : isActive ? (
              <Square size={30} fill="currentColor" />
            ) : (
              <Play className="ml-0.5" size={34} fill="currentColor" />
            )}
          </Button>
        </div>
      ) : null}

      <div className="relative z-[var(--layer-selection)] flex h-full flex-col justify-end p-3">
        <div className="relative isolate grid gap-2">
          <div
            className={cn(
              "grid items-center gap-2 pt-1",
              hasBottomAction ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1",
              "role-cover-actions"
            )}
          >
            <div className="flex min-w-0 items-center gap-3 pl-1">
              {gameIconUrl ? (
                <img
                  className="size-8 shrink-0 rounded-xs object-cover shadow-sm ring-1 ring-on-media/45"
                  src={gameIconUrl}
                  alt=""
                  aria-hidden="true"
                  decoding="async"
                  draggable={false}
                  loading="lazy"
                />
              ) : null}
              <div className="grid min-w-0 gap-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <CardTitle className="role-cover-title min-w-0 flex-1 truncate text-on-media">
                    {role.name}
                  </CardTitle>
                </div>
                <p className="min-w-0 truncate text-micro font-medium text-on-media-muted">
                  {game?.name ?? role.launchUrl}
                </p>
              </div>
            </div>
            {null}
          </div>
        </div>
      </div>
        </Card>
      </ContextMenuTrigger>
      <RoleContextMenuContent
        isBusy={isBusy}
        t={t}
        onCopy={onCopy}
        onClearBrowserData={onClearBrowserData}
        onDelete={onDelete}
        onEdit={onEdit}
      />
    </ContextMenu>
  );
}

interface RoleActionMenuProps {
  canReorder: boolean;
  isBusy: boolean;
  isDragging: boolean;
  isOnCover?: boolean;
  onCopy: () => void;
  onClearBrowserData: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onReorderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  t: Translator;
}

function RoleActionMenu({
  canReorder,
  isBusy,
  isDragging,
  isOnCover = false,
  onCopy,
  onClearBrowserData,
  onDelete,
  onEdit,
  onReorderPointerDown,
  t
}: RoleActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isDragging) {
      setIsOpen(false);
    }
  }, [isDragging]);

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

  function handleClearBrowserData(): void {
    setIsOpen(false);
    onClearBrowserData();
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        className={cn(
          "h-7 w-7 touch-none",
          canReorder && "cursor-grab active:cursor-grabbing",
          isDragging && "cursor-grabbing",
          isOnCover && "role-cover-menu-control text-on-media hover:text-on-media"
        )}
        type="button"
        variant="ghost"
        size="icon"
        title={t(canReorder ? "role.actionsAndReorder" : "role.actions")}
        aria-label={t(canReorder ? "role.actionsAndReorder" : "role.actions")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        onPointerDown={canReorder ? onReorderPointerDown : undefined}
      >
        <MoreHorizontal size={14} />
      </Button>

      {isOpen ? (
        <Surface
          className="absolute right-0 top-8 z-[var(--layer-popover)] min-w-44 overflow-hidden text-popover-foreground"
          padding="xs"
          variant="popover"
          role="menu"
        >
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground"
            type="button"
            role="menuitem"
            onClick={handleEdit}
          >
            <Pencil size={14} />
            <span>{t("role.edit")}</span>
          </button>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={handleCopy}
            disabled={isBusy}
          >
            <Copy size={14} />
            <span>{t("role.copy")}</span>
          </button>
          <div className="my-1 border-t border-border/60" role="separator" />
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={handleClearBrowserData}
            disabled={isBusy}
          >
            <Eraser size={14} />
            <span>{t("role.clearSavedData")}</span>
          </button>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={handleDelete}
            disabled={isBusy}
          >
            <Trash2 size={14} />
            <span>{t("role.delete")}</span>
          </button>
        </Surface>
      ) : null}
    </div>
  );
}

function RoleContextMenuContent({
  isBusy,
  t,
  onCopy,
  onClearBrowserData,
  onDelete,
  onEdit
}: Omit<RoleActionMenuProps, "canReorder" | "isDragging" | "isOnCover" | "onReorderPointerDown">): JSX.Element {
  return (
    <ContextMenuContent className="min-w-44">
      <ContextMenuItem className="gap-1.5" onSelect={onEdit}>
        <Pencil size={14} />
        <span>{t("role.edit")}</span>
      </ContextMenuItem>
      <ContextMenuItem className="gap-1.5" disabled={isBusy} onSelect={onCopy}>
        <Copy size={14} />
        <span>{t("role.copy")}</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem className="gap-1.5 text-destructive" disabled={isBusy} onSelect={onClearBrowserData}>
        <Eraser size={14} />
        <span>{t("role.clearSavedData")}</span>
      </ContextMenuItem>
      <ContextMenuItem className="gap-1.5 text-destructive" disabled={isBusy} onSelect={onDelete}>
        <Trash2 size={14} />
        <span>{t("role.delete")}</span>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export default RolesView;
