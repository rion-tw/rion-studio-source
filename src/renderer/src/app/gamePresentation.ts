import feifeiIconUrl from "../assets/games/feifei-infinite-universe.png";
import flyffIconUrl from "../assets/games/flyff-universe.png";

import type { Game } from "../../../shared/types";

export function getGameIconUrl(game: Game | undefined): string | undefined {
  if (!game) {
    return undefined;
  }
  if (game.iconImageDataUrl) {
    return game.iconImageDataUrl;
  }
  return game.builtinKey === "flyff-universe"
    ? flyffIconUrl
    : game.builtinKey === "feifei-infinite-universe"
      ? feifeiIconUrl
      : undefined;
}

export function sortGames(games: Game[]): Game[] {
  return [...games].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "builtin" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
