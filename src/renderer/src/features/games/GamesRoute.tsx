import {
  Gamepad2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
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
import type { Game } from "../../../../shared/types";

interface GamesRouteProps {
  games: Game[];
  t: Translator;
  isDeleting?: boolean;
  onDelete: (game: Game) => void;
  onDeleteMany: (games: Game[]) => Promise<boolean>;
  onEdit: (game: Game) => void;
  onNewGame: () => void;
  onNewRole: (gameId: string) => void;
}

function GamesRoute({
  games,
  t,
  isDeleting = false,
  onDelete,
  onDeleteMany,
  onEdit,
  onNewGame,
  onNewRole
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
          <SearchField className="page-header-control page-header-search" value={query} onChange={setQuery} placeholder={t("games.search")} />
          <Button className="page-header-control" type="button" variant="outline" onClick={onNewGame}><Plus size={15} />{t("games.new")}</Button>
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
        <div className="collection-grid collection-grid-games auto-rows-fr gap-3">
          {filteredGames.map((game) => {
            const iconUrl = getGameIconUrl(game);
            const coverUrl = getGameCoverUrl(game);
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
                  <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/15 via-muted/80 to-accent/15 [contain:paint]">
                    {coverUrl ? (
                      <img
                        className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.015]"
                        src={coverUrl}
                        alt=""
                        decoding="async"
                        draggable={false}
                        loading="lazy"
                      />
                    ) : (
                      <div className="absolute inset-0 grid place-items-center">
                        {iconUrl ? (
                          <img className="size-16 rounded-lg object-cover opacity-85 shadow-lg ring-1 ring-on-media/25" src={iconUrl} alt="" decoding="async" draggable={false} loading="lazy" />
                        ) : (
                          <Gamepad2 className="text-muted-foreground/65" size={42} />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 items-center gap-3 px-4 py-4">
                    <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
                      {iconUrl ? <img className="size-full object-cover" src={iconUrl} alt="" decoding="async" draggable={false} loading="lazy" /> : <Gamepad2 size={20} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-sm font-semibold">{game.name}</h2>
                        {game.source === "custom" ? <Badge variant="muted">{t("games.custom")}</Badge> : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{game.defaultLaunchUrl}</p>
                    </div>
                  </div>
                </button>
                <div className="pointer-events-none absolute right-3 top-3 z-[var(--layer-selection)] opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                  <GameActionMenu
                    game={game}
                    t={t}
                    onDelete={() => onDelete(game)}
                    onEdit={() => onEdit(game)}
                    onNewRole={() => onNewRole(game.id)}
                  />
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
  game,
  t,
  onDelete,
  onEdit,
  onNewRole
}: {
  game: Game;
  t: Translator;
  onDelete: () => void;
  onEdit: () => void;
  onNewRole: () => void;
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
        className="role-cover-menu-control h-7 w-7 text-on-media hover:text-on-media"
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
          className="absolute right-0 top-8 z-[var(--layer-popover)] min-w-44 overflow-hidden text-popover-foreground"
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

export default GamesRoute;
