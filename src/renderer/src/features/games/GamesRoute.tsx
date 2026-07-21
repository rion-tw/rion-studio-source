import {
  Gamepad2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";

import { getGameCoverUrl, getGameIconUrl, sortGames } from "../../app/gamePresentation";
import { EmptyState } from "../../components/EmptyState";
import { CreateItemCard } from "../../components/CreateListItem";
import {
  SelectionActionBar,
  SelectionCardOverlay,
  SelectionMarquee
} from "../../components/ListSelection";
import { SearchField } from "../../components/SearchField";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { useListSelection } from "../../hooks/useListSelection";
import type { Game, GameCompatibilityReport, GameCompatibilityRunStatus, Role, RoleStatus } from "../../../../shared/types";

interface GamesRouteProps {
  games: Game[];
  reports: GameCompatibilityReport[];
  roles: Role[];
  runStatuses: GameCompatibilityRunStatus[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  isDeleting?: boolean;
  onDelete: (game: Game) => void;
  onDeleteMany: (games: Game[]) => Promise<boolean>;
  onEdit: (game: Game) => void;
  onNewGame: () => void;
  onNewRole: (gameId: string) => void;
  onRunCheck: (gameId: string) => void;
}

function GamesRoute({
  games,
  reports,
  roles,
  runStatuses,
  statusByRole,
  t,
  isDeleting = false,
  onDelete,
  onDeleteMany,
  onEdit,
  onNewGame,
  onNewRole,
  onRunCheck
}: GamesRouteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const pageRef = useRef<HTMLElement | null>(null);
  const filteredGames = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return sortGames(games).filter((game) => !normalized || [game.name, game.defaultLaunchUrl]
      .join(" ").toLocaleLowerCase().includes(normalized));
  }, [games, query]);
  const selection = useListSelection({
    orderedIds: filteredGames.map((game) => game.id),
    scrollContainerRef: pageRef
  });

  async function handleDeleteSelected(): Promise<void> {
    const selectedGames = filteredGames.filter((game) => selection.selectedIds.has(game.id));
    const completed = await onDeleteMany(selectedGames);
    if (completed) {
      selection.clearSelection();
    }
  }

  return (
    <PageFrame containerRef={pageRef} {...selection.collectionProps}>
      <PageHeader
        kicker={t("app.navigation.play")}
        title={t("games.title")}
        description={t("games.description")}
        actions={<>
          <SearchField value={query} onChange={setQuery} placeholder={t("games.search")} />
          <Button type="button" variant="outline" onClick={onNewGame}><Plus size={15} />{t("games.new")}</Button>
        </>}
      />
      {selection.hasSelection ? (
        <SelectionActionBar
          isBusy={isDeleting}
          selectedCount={selection.selectedIds.size}
          t={t}
          totalCount={filteredGames.length}
          onClear={selection.clearSelection}
          onDelete={() => void handleDeleteSelected()}
          onSelectAll={selection.selectAll}
        />
      ) : null}
      {games.length === 0 ? (
        <EmptyState icon={Gamepad2} title={t("games.empty.title")} description={t("games.empty.description")} actionLabel={t("games.new")} onAction={onNewGame} />
      ) : filteredGames.length === 0 ? (
        <EmptyState icon={Search} title={t("games.noMatches.title")} description={t("games.noMatches.description")} />
      ) : (
        <div className="grid auto-rows-fr gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filteredGames.map((game) => {
            const gameRoles = roles.filter((role) => role.gameId === game.id);
            const report = reports.find((item) => item.gameId === game.id);
            const running = gameRoles.filter((role) => statusByRole.has(role.id)).length;
            const checking = runStatuses.some((item) => item.gameId === game.id);
            const iconUrl = getGameIconUrl(game);
            const coverUrl = getGameCoverUrl(game);
            const isReportStale = !checking && report?.isStale === true;
            const isEmbeddedAvailable = !checking
              && !report?.isStale
              && report?.recommendation?.reason !== "graphics_unavailable"
              && report?.load?.state === "available";
            const isGraphicsLimited = !checking
              && !isReportStale
              && report?.recommendation?.reason === "graphics_unavailable";
            const isFailed = !checking
              && !isReportStale
              && !isGraphicsLimited
              && report?.load?.state === "failed";
            const isCancelled = !checking
              && !isReportStale
              && report?.load?.state === "cancelled";
            const isNotChecked = !checking
              && !isReportStale
              && !isEmbeddedAvailable
              && !isGraphicsLimited
              && !isFailed
              && !isCancelled;
            return (
              <Card
                key={game.id}
                ref={selection.registerItem(game.id)}
                className="group relative overflow-hidden transition-[box-shadow,background-color]"
                data-selection-id={game.id}
                onClickCapture={(event) => selection.handleItemClick(event, game.id)}
              >
                <SelectionCardOverlay isSelected={selection.isSelected(game.id)} />
                <button className="block w-full min-w-0 text-left" type="button" onClick={() => onEdit(game)}>
                  <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/15 via-muted/80 to-accent/15">
                    {coverUrl ? (
                      <img
                        className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.015]"
                        src={coverUrl}
                        alt=""
                      />
                    ) : (
                      <div className="absolute inset-0 grid place-items-center">
                        {iconUrl ? (
                          <img className="size-16 rounded-2xl object-cover opacity-85 shadow-lg ring-1 ring-white/25" src={iconUrl} alt="" />
                        ) : (
                          <Gamepad2 className="text-muted-foreground/65" size={42} />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 items-center gap-3 px-4 pt-4">
                    <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
                      {iconUrl ? <img className="size-full object-cover" src={iconUrl} alt="" /> : <Gamepad2 size={20} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-sm font-semibold">{game.name}</h2>
                        {game.source === "custom" ? <Badge variant="muted">{t("games.custom")}</Badge> : null}
                        {isReportStale ? (
                          <Badge className="shrink-0" variant="warning">
                            {t("games.compatibility.stale")}
                          </Badge>
                        ) : isEmbeddedAvailable ? (
                          <span
                            aria-label={t("games.compatibility.recommendation.embedded_available")}
                            className="inline-flex shrink-0 text-emerald-500"
                            role="img"
                            title={t("games.compatibility.recommendation.embedded_available")}
                          >
                            <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.5} />
                          </span>
                        ) : checking ? (
                          <Badge className="shrink-0" variant="warning">
                            {t("games.compatibility.running")}
                          </Badge>
                        ) : isGraphicsLimited ? (
                          <Badge className="shrink-0" variant="warning">
                            {t("games.compatibility.graphicsLimited")}
                          </Badge>
                        ) : isFailed ? (
                          <Badge className="shrink-0" variant="destructive">
                            {t("games.compatibility.failed")}
                          </Badge>
                        ) : isCancelled ? (
                          <Badge className="shrink-0" variant="muted">
                            {t("games.compatibility.cancelled")}
                          </Badge>
                        ) : isNotChecked ? (
                          <Badge className="shrink-0" variant="muted">
                            {t("games.compatibility.notChecked")}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{game.defaultLaunchUrl}</p>
                    </div>
                  </div>
                </button>
                <div className="pointer-events-none absolute right-3 top-3 z-30 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                  <GameActionMenu
                    checking={checking}
                    game={game}
                    t={t}
                    onDelete={() => onDelete(game)}
                    onEdit={() => onEdit(game)}
                    onNewRole={() => onNewRole(game.id)}
                    onRunCheck={() => onRunCheck(game.id)}
                  />
                </div>
                <div className="p-4 pt-3">
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <Metric label={t("games.roles")} value={gameRoles.length} />
                    <Metric label={t("games.running")} value={running} />
                  </div>
                </div>
              </Card>
            );
          })}
          <CreateItemCard label={t("games.new")} onClick={onNewGame} />
        </div>
      )}
      <SelectionMarquee container={pageRef.current} rect={selection.selectionRect} />
    </PageFrame>
  );
}

function GameActionMenu({
  checking,
  game,
  t,
  onDelete,
  onEdit,
  onNewRole,
  onRunCheck
}: {
  checking: boolean;
  game: Game;
  t: Translator;
  onDelete: () => void;
  onEdit: () => void;
  onNewRole: () => void;
  onRunCheck: () => void;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setIsOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function run(action: () => void): void {
    setIsOpen(false);
    action();
  }

  const itemClassName = "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50";

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        className="role-cover-menu-control h-7 w-7 text-white hover:text-white"
        type="button"
        variant="ghost"
        size="icon"
        title={t("games.actions")}
        aria-label={t("games.actions")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
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
          <button className={itemClassName} type="button" role="menuitem" onClick={() => run(onNewRole)}>
            <Users size={14} />
            <span>{t("games.addRole")}</span>
          </button>
          <button className={itemClassName} type="button" role="menuitem" onClick={() => run(onEdit)}>
            <Pencil size={14} />
            <span>{t("common.edit")}</span>
          </button>
          <button className={itemClassName} type="button" role="menuitem" disabled={checking} onClick={() => run(onRunCheck)}>
            {checking ? <Loader2 className="spin" size={14} /> : <ShieldCheck size={14} />}
            <span>{checking ? t("games.compatibility.running") : t("games.compatibility.run")}</span>
          </button>
          {game.source === "custom" ? (
            <button
              className={`${itemClassName} text-destructive hover:bg-destructive/10 hover:text-destructive`}
              type="button"
              role="menuitem"
              onClick={() => run(onDelete)}
            >
              <Trash2 size={14} />
              <span>{t("confirm.delete")}</span>
            </button>
          ) : null}
        </Surface>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return <div className="rounded-md bg-muted/55 px-2 py-2"><p className="font-semibold">{value}</p><p className="truncate text-[10px] text-muted-foreground">{label}</p></div>;
}

export default GamesRoute;
