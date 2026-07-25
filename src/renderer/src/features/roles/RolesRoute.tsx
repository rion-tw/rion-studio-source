import {
  AlertCircle,
  Copy,
  Eraser,
  FileWarning,
  Globe2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Upload,
  RotateCcw,
  ArrowRightLeft
} from "lucide-react";
import {
  type DragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type RefCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { Button } from "../../components/ui/button";
import { Card, CardTitle } from "../../components/ui/card";
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
import {
  getBrowserEngineStatusTitle,
  getResolvedBrowserEngineLabel
} from "../../app/browserEnginePresentation";
import { moveItemById } from "../../app/reorderItems";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import { type Language, type TranslationKey, type Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Game, Role, RoleStatus } from "../../../../shared/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { AppStats, SidebarFilter } from "../../app/types";
import { createRoleCardStyle } from "./roleCardStyle";
import { useListSelection } from "../../hooks/useListSelection";

const filterLabelKeys: Record<SidebarFilter, TranslationKey> = {
  all: "roles.filter.all",
  running: "roles.filter.running",
  stopped: "roles.filter.stopped",
};

const filterOrder: SidebarFilter[] = ["all", "running", "stopped"];

interface RolesViewProps {
  activeFilter: SidebarFilter;
  busyRoleIds: ReadonlySet<string>;
  filteredRoles: Role[];
  games: Game[];
  isChromeProfileImportOpen?: boolean;
  isReordering: boolean;
  language?: Language;
  roleStats: AppStats;
  roles: Role[];
  scrollPositionRef: MutableRefObject<number>;
  query: string;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onClearQuery: () => void;
  onCaptureExternalDiagnostics?: (roleId: string) => void;
  onBrowserSessionMigration?: (role: Role) => void;
  onClearBrowserData: (role: Role) => void;
  onCopy: (role: Role) => void;
  onDelete: (role: Role) => void;
  onDeleteMany: (roles: Role[]) => Promise<boolean>;
  onEdit: (role: Role) => void;
  onFilterChange: (filter: SidebarFilter) => void;
  onLaunch: (roleId: string) => void;
  onOpenChromeProfileImport?: () => void;
  onRecoverExternalRole?: (roleId: string) => void;
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
  isChromeProfileImportOpen = false,
  isReordering,
  roleStats,
  roles,
  scrollPositionRef,
  query,
  statusByRole,
  t,
  onClearQuery,
  onCaptureExternalDiagnostics = () => undefined,
  onBrowserSessionMigration = () => undefined,
  onClearBrowserData,
  onCopy,
  onDelete,
  onDeleteMany,
  onEdit,
  onFilterChange,
  onLaunch,
  onOpenChromeProfileImport = () => undefined,
  onRecoverExternalRole = () => undefined,
  onNewRole,
  onQueryChange,
  onReorder,
  onStop
}: RolesViewProps): JSX.Element {
  const [draggedRoleId, setDraggedRoleId] = useState<string | null>(null);
  const [dropTargetRoleId, setDropTargetRoleId] = useState<string | null>(null);
  const [gameFilterId, setGameFilterId] = useState("all");
  const pageRef = useRef<HTMLElement | null>(null);
  const visibleRoles = gameFilterId === "all" ? filteredRoles : filteredRoles.filter((role) => role.gameId === gameFilterId);
  const selection = useListSelection({
    orderedIds: visibleRoles.map((role) => role.id),
    scrollContainerRef: pageRef
  });
  const gameById = new Map(games.map((game) => [game.id, game]));
  const canReorder = activeFilter === "all" && gameFilterId === "all" && query.trim() === "" && !isReordering && !selection.hasSelection && roles.length > 1;
  const filterCounts: Record<SidebarFilter, number> = {
    all: roleStats.total,
    running: roleStats.running,
    stopped: roleStats.stopped,
  };

  function clearDragState(): void {
    setDraggedRoleId(null);
    setDropTargetRoleId(null);
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, roleId: string): void {
    if (!canReorder) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-rion-role-order", roleId);
    setDraggedRoleId(roleId);
    setDropTargetRoleId(null);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, roleId: string): void {
    if (!draggedRoleId || draggedRoleId === roleId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetRoleId(roleId);
  }

  function handleDrop(event: DragEvent<HTMLElement>, roleId: string): void {
    event.preventDefault();

    if (draggedRoleId && draggedRoleId !== roleId) {
      const nextRoles = moveItemById(roles, draggedRoleId, roleId);
      onReorder(nextRoles.map((role) => role.id));
    }

    clearDragState();
  }

  async function handleDeleteSelected(): Promise<void> {
    const selectedRoles = visibleRoles.filter((role) => selection.selectedIds.has(role.id));
    const completed = await onDeleteMany(selectedRoles);
    if (completed) {
      selection.clearSelection();
    }
  }

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
          onSecondaryAction={onOpenChromeProfileImport}
          secondaryActionDisabled={isChromeProfileImportOpen || games.length === 0}
          secondaryActionLabel={t("roles.importChromeProfiles")}
        />
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
              className="w-full sm:w-44 lg:w-48"
              placeholder={t("roles.searchPlaceholder")}
              value={query}
              onChange={onQueryChange}
            />
            <Button
              className="flex-1 gap-1.5 px-2.5 sm:flex-none"
              type="button"
              variant="outline"
              disabled={isChromeProfileImportOpen || games.length === 0}
              onClick={onOpenChromeProfileImport}
            >
              <Upload size={14} />
              {t("roles.importChromeProfiles")}
            </Button>
            <Button
              className="flex-1 gap-1.5 px-2.5 sm:flex-none"
              type="button"
              variant="outline"
              onClick={onNewRole}
            >
              <Plus size={14} />
              {t("roles.newRole")}
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

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <RoleFilterTabs
          activeFilter={activeFilter}
          counts={filterCounts}
          t={t}
          onFilterChange={onFilterChange}
        />
        <div className="flex items-center gap-2"><Select value={gameFilterId} onValueChange={setGameFilterId}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("roles.gameFilter.all")}</SelectItem>{games.map((game) => <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>)}</SelectContent></Select><p className="text-[11px] font-medium text-muted-foreground">
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
        <div className="grid auto-rows-fr grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
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
                isDragging={draggedRoleId === role.id}
                isDropTarget={dropTargetRoleId === role.id}
                isBusy={isBusy}
                isSelected={selection.isSelected(role.id)}
                selectionRef={selection.registerItem(role.id)}
                t={t}
                onCopy={() => onCopy(role)}
                onBrowserSessionMigration={() => onBrowserSessionMigration(role)}
                onClearBrowserData={() => onClearBrowserData(role)}
                onCaptureExternalDiagnostics={() => onCaptureExternalDiagnostics(role.id)}
                onDelete={() => onDelete(role)}
                onEdit={() => onEdit(role)}
                onLaunch={() => onLaunch(role.id)}
                onRecoverExternalRole={() => onRecoverExternalRole(role.id)}
                onDragEnd={clearDragState}
                onDragOver={(event) => handleDragOver(event, role.id)}
                onDragStart={(event) => handleDragStart(event, role.id)}
                onDrop={(event) => handleDrop(event, role.id)}
                onStop={() => onStop(role.id)}
                onSelectionClick={(event) => selection.handleItemClick(event, role.id)}
              />
            );
          })}
          <CreateItemCard className="aspect-[4/5]" label={t("roles.newRole")} onClick={onNewRole} />
        </div>
      )}
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
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
  onBrowserSessionMigration: () => void;
  onClearBrowserData: () => void;
  onCaptureExternalDiagnostics: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onLaunch: () => void;
  onRecoverExternalRole: () => void;
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
  onBrowserSessionMigration,
  onClearBrowserData,
  onCaptureExternalDiagnostics,
  onDelete,
  onEdit,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onLaunch,
  onRecoverExternalRole,
  onStop,
  onSelectionClick,
  role,
  status,
  selectionRef,
  t
}: RoleCardProps): JSX.Element {
  const isActive = Boolean(status);
  const isExternalCompatibilitySession = status?.runtimeMode === "external" && status.state === "running";
  const isPageUnresponsive = isExternalCompatibilitySession && status.pageHealth === "unresponsive";
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
    <Card
      ref={selectionRef}
      className={cn(
        "role-cover-card group relative aspect-[4/5] overflow-hidden transition-[box-shadow,opacity] duration-150",
        isDragging && "opacity-45",
        isDropTarget && "ring-2 ring-primary/70 ring-offset-2 ring-offset-background"
      )}
      data-selection-id={role.id}
      style={cardStyle}
      onClickCapture={onSelectionClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className="absolute inset-0 bg-cover bg-center transition-transform duration-300 ease-out group-hover:scale-[1.03]"
        style={{ backgroundImage: `url("${coverImageUrl}")` }}
      />

      <SelectionCardOverlay isSelected={isSelected} />

      <div className="pointer-events-none absolute right-3 top-3 z-30 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <RoleActionMenu
          canReorder={canReorder}
          isDragging={isDragging}
          isBusy={isBusy}
          isOnCover
          roleSessionMigrationLabel={
            role.browserEnginePin === "electron"
              ? t("role.migrateToSystem")
              : role.browserEnginePin === "system"
                ? t("role.rollbackToElectron")
                : undefined
          }
          t={t}
          onCopy={onCopy}
          onBrowserSessionMigration={onBrowserSessionMigration}
          onClearBrowserData={onClearBrowserData}
          onDelete={onDelete}
          onEdit={onEdit}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
        />
      </div>

      {canUsePrimaryOverlayAction ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <Button
            className={cn(
              "pointer-events-auto size-16 rounded-full p-0 shadow-lg transition-[opacity,transform,background-color] duration-150",
              isActive
                ? "opacity-100"
                : "opacity-0 group-hover:scale-105 group-hover:opacity-100 group-focus-within:scale-105 group-focus-within:opacity-100",
              "border border-white/35 bg-black/35 text-white backdrop-blur-md hover:bg-black/50 hover:text-white"
            )}
            type="button"
            variant="secondary"
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

      <div className="relative z-10 flex h-full flex-col justify-end p-3">
        <div className="relative isolate grid gap-2">
          {isExternalCompatibilitySession ? (
            <div className={cn(
              "flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-medium backdrop-blur-md",
              isPageUnresponsive
                ? "border-warning-foreground/35 bg-warning/20 text-white"
                : "border-white/20 bg-black/20 text-white/85"
            )}>
              {isPageUnresponsive ? <AlertCircle aria-hidden="true" size={13} /> : null}
              <span className="min-w-0 flex-1">
                {isPageUnresponsive ? t("roles.externalUnresponsive") : t("roles.externalDiagnosticsReady")}
              </span>
              <Button
                className="h-6 gap-1 rounded-full px-1.5 text-[10px] text-white shadow-none hover:text-white"
                type="button"
                variant="secondary"
                size="sm"
                title={t("roles.reportGameFreeze")}
                onClick={onCaptureExternalDiagnostics}
              >
                <FileWarning aria-hidden="true" size={12} />
                {t("roles.reportShort")}
              </Button>
              {isPageUnresponsive ? (
                <Button
                  className="h-6 gap-1 rounded-full px-1.5 text-[10px] text-white shadow-none hover:text-white"
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRecoverExternalRole}
                >
                  <RotateCcw aria-hidden="true" size={12} />
                  {t("roles.recoverExternal")}
                </Button>
              ) : null}
            </div>
          ) : null}

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
                  className="size-8 shrink-0 rounded-sm object-cover shadow-sm ring-1 ring-white/45"
                  src={gameIconUrl}
                  alt=""
                  aria-hidden="true"
                />
              ) : null}
              <div className="grid min-w-0 gap-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <CardTitle className="role-cover-title min-w-0 flex-1 truncate text-white">
                    {role.name}
                  </CardTitle>
                  {status?.resolvedEngine ? (
                    <span
                      className="shrink-0 rounded-full border border-white/25 bg-black/25 px-1.5 py-0.5 text-[9px] font-semibold text-white/85 backdrop-blur-sm"
                      title={getBrowserEngineStatusTitle(status, t)}
                    >
                      {getResolvedBrowserEngineLabel(status.resolvedEngine, t)}
                    </span>
                  ) : null}
                  {role.browserEnginePin === "electron" ? (
                    <span className="shrink-0 rounded-full border border-white/25 bg-black/25 px-1.5 py-0.5 text-[9px] font-semibold text-white/85 backdrop-blur-sm">
                      {t("role.legacyElectron")}
                    </span>
                  ) : null}
                </div>
                <p className="min-w-0 truncate text-[10px] font-medium leading-3 text-white/78">
                  {game?.name ?? role.launchUrl}
                </p>
              </div>
            </div>
            {null}
          </div>
        </div>
      </div>
    </Card>
  );
}

interface RoleActionMenuProps {
  canReorder: boolean;
  isBusy: boolean;
  isDragging: boolean;
  isOnCover?: boolean;
  roleSessionMigrationLabel?: string;
  onCopy: () => void;
  onBrowserSessionMigration: () => void;
  onClearBrowserData: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  t: Translator;
}

function RoleActionMenu({
  canReorder,
  isBusy,
  isDragging,
  isOnCover = false,
  roleSessionMigrationLabel,
  onCopy,
  onBrowserSessionMigration,
  onClearBrowserData,
  onDelete,
  onEdit,
  onDragEnd,
  onDragStart,
  t
}: RoleActionMenuProps): JSX.Element {
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

  function handleBrowserSessionMigration(): void {
    setIsOpen(false);
    onBrowserSessionMigration();
  }

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
          isDragging && "cursor-grabbing",
          isOnCover && "role-cover-menu-control text-white hover:text-white"
        )}
        type="button"
        variant="ghost"
        size="icon"
        title={t(canReorder ? "role.actionsAndReorder" : "role.actions")}
        aria-label={t(canReorder ? "role.actionsAndReorder" : "role.actions")}
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
          className="absolute right-0 top-8 z-20 min-w-44 overflow-hidden text-popover-foreground"
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
          {roleSessionMigrationLabel ? (
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              type="button"
              role="menuitem"
              onClick={handleBrowserSessionMigration}
              disabled={isBusy}
            >
              <ArrowRightLeft size={14} />
              <span>{roleSessionMigrationLabel}</span>
            </button>
          ) : null}
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

export default RolesView;
