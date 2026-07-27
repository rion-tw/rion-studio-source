import { describe, expect, it } from "vitest";

import { getGameCoverUrl } from "../src/renderer/src/app/gamePresentation";
import type { Game } from "../src/shared/types";

describe("game cover presentation", () => {
  it("maps each built-in game to its packaged cover", () => {
    expect(getGameCoverUrl(game({
      id: "builtin-feifei-infinite-universe",
      source: "builtin",
      builtinKey: "feifei-infinite-universe",
      name: "飞飞：无限宇宙"
    }))).toContain("feifei-infinite-universe-cover");
    expect(getGameCoverUrl(game({
      id: "builtin-flyff-universe",
      source: "builtin",
      builtinKey: "flyff-universe",
      name: "Flyff Universe"
    }))).toContain("flyff-universe-cover");
  });

  it("uses a custom data URL and leaves uncovered custom games for the UI fallback", () => {
    const coverImageDataUrl = "data:image/webp;base64,QQ==";
    expect(getGameCoverUrl(game({ coverImageDataUrl }))).toBe(coverImageDataUrl);
    expect(getGameCoverUrl(game({ coverImageDataUrl: undefined }))).toBeUndefined();
  });
});

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: "custom-game",
    source: "custom",
    name: "Custom game",
    defaultLaunchUrl: "https://example.test/play",
    localStorageSyncKeys: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
