import { Gamepad2, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { type JSX, useMemo, useState } from "react";

import { getGameCoverUrl, getGameIconUrl, sortGames } from "../../app/gamePresentation";
import { EmptyState } from "../../components/EmptyState";
import { SearchField } from "../../components/SearchField";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageFrame, PageHeader } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import type { Game, GameCompatibilityReport, GameCompatibilityRunStatus, Role, RoleStatus } from "../../../../shared/types";

interface GamesRouteProps {
  games: Game[];
  reports: GameCompatibilityReport[];
  roles: Role[];
  runStatuses: GameCompatibilityRunStatus[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onDelete: (game: Game) => void;
  onEdit: (game: Game) => void;
  onNewGame: () => void;
  onNewRole: (gameId: string) => void;
  onView: (game: Game) => void;
}

function GamesRoute({
  games,
  reports,
  roles,
  runStatuses,
  statusByRole,
  t,
  onDelete,
  onEdit,
  onNewGame,
  onNewRole,
  onView
}: GamesRouteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const filteredGames = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return sortGames(games).filter((game) => !normalized || [game.name, game.defaultLaunchUrl]
      .join(" ").toLocaleLowerCase().includes(normalized));
  }, [games, query]);

  return (
    <PageFrame>
      <PageHeader
        kicker={t("app.navigation.play")}
        title={t("games.title")}
        description={t("games.description")}
        actions={<>
          <SearchField value={query} onChange={setQuery} placeholder={t("games.search")} />
          <Button type="button" variant="outline" onClick={onNewGame}><Plus size={15} />{t("games.new")}</Button>
        </>}
      />
      {games.length === 0 ? (
        <EmptyState icon={Gamepad2} title={t("games.empty.title")} description={t("games.empty.description")} actionLabel={t("games.new")} onAction={onNewGame} />
      ) : filteredGames.length === 0 ? (
        <EmptyState icon={Search} title={t("games.noMatches.title")} description={t("games.noMatches.description")} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filteredGames.map((game) => {
            const gameRoles = roles.filter((role) => role.gameId === game.id);
            const report = reports.find((item) => item.gameId === game.id);
            const running = gameRoles.filter((role) => statusByRole.has(role.id)).length;
            const needsLogin = gameRoles.filter((role) => role.authState !== "authenticated").length;
            const checking = runStatuses.some((item) => item.gameId === game.id);
            const iconUrl = getGameIconUrl(game);
            const coverUrl = getGameCoverUrl(game);
            return (
              <Card key={game.id} className="overflow-hidden">
                <button className="group block w-full min-w-0 text-left" type="button" onClick={() => onView(game)}>
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
                      <div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold">{game.name}</h2><Badge variant={game.source === "builtin" ? "secondary" : "muted"}>{t(game.source === "builtin" ? "games.builtin" : "games.custom")}</Badge></div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{game.defaultLaunchUrl}</p>
                    </div>
                  </div>
                </button>
                <div className="grid gap-4 p-4 pt-3">
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <Metric label={t("games.roles")} value={gameRoles.length} />
                    <Metric label={t("games.running")} value={running} />
                    <Metric label={t("games.needsLogin")} value={needsLogin} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant={checking ? "warning" : report?.recommendation?.reason === "graphics_unavailable" ? "warning" : report?.load?.state === "available" ? "success" : report?.load?.state === "failed" ? "destructive" : "muted"}>
                      {checking ? t("games.compatibility.running") : report?.isStale ? t("games.compatibility.stale") : report?.recommendation?.reason === "graphics_unavailable" ? t("games.compatibility.graphicsLimited") : report?.load?.state === "available" ? t("games.compatibility.available") : report?.load?.state === "failed" ? t("games.compatibility.failed") : report?.load?.state === "cancelled" ? t("games.compatibility.cancelled") : t("games.compatibility.notChecked")}
                    </Badge>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" title={t("games.addRole")} onClick={() => onNewRole(game.id)}><Users size={15} /></Button>
                      <Button size="icon" variant="ghost" title={t("common.edit")} onClick={() => onEdit(game)}><Pencil size={15} /></Button>
                      {game.source === "custom" ? <Button size="icon" variant="ghost" title={t("confirm.delete")} onClick={() => onDelete(game)}><Trash2 size={15} /></Button> : null}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return <div className="rounded-md bg-muted/55 px-2 py-2"><p className="font-semibold">{value}</p><p className="truncate text-[10px] text-muted-foreground">{label}</p></div>;
}

export default GamesRoute;
