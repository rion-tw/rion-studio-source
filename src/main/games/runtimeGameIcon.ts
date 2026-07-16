import feifeiIconDataUrl from "../../renderer/src/assets/games/feifei-infinite-universe.png?inline";
import flyffIconDataUrl from "../../renderer/src/assets/games/flyff-universe.png?inline";

import type { Game } from "../../shared/types";

const RUNTIME_GAME_ICON_SIZE = 32;

interface RuntimeGameIconImage {
  isEmpty(): boolean;
  resize(options: {
    height: number;
    quality: "best";
    width: number;
  }): RuntimeGameIconImage;
  toDataURL(): string;
}

export function getRuntimeGameIconSource(
  game: Pick<Game, "builtinKey" | "iconImageDataUrl">
): string | undefined {
  if (game.iconImageDataUrl) {
    return game.iconImageDataUrl;
  }
  return game.builtinKey === "flyff-universe"
    ? flyffIconDataUrl
    : game.builtinKey === "feifei-infinite-universe"
      ? feifeiIconDataUrl
      : undefined;
}

export function createRuntimeGameIconDataUrl(
  game: Pick<Game, "builtinKey" | "iconImageDataUrl">,
  createImage: (source: string) => RuntimeGameIconImage
): string | undefined {
  const source = getRuntimeGameIconSource(game);
  if (!source) return undefined;

  try {
    const image = createImage(source);
    if (image.isEmpty()) return undefined;
    const resized = image.resize({
      height: RUNTIME_GAME_ICON_SIZE,
      quality: "best",
      width: RUNTIME_GAME_ICON_SIZE
    });
    if (resized.isEmpty()) return undefined;
    return resized.toDataURL();
  } catch {
    return undefined;
  }
}
