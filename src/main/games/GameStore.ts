import type {
  BulkDeleteResult,
  CreateGameInput,
  Game,
  UpdateGameInput
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

export class GameStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: { roleCount?: number; roleNames?: string[] }
  ) {
    super(message);
    this.name = "GameStoreError";
  }
}

/**
 * Electron-facing typed client for the Rust game domain.
 *
 * It intentionally owns no metadata cache, normalization, clock, ID generation,
 * migration, or persistence path. Those responsibilities are transactional in
 * rion-core.
 */
export class GameStore {
  constructor(
    _userDataDir: string,
    private readonly core: Pick<AppCoreClient, "invoke">
  ) {}

  listGames(): Promise<Game[]> {
    return this.core.invoke({ type: "gamesList" });
  }

  getGame(id: string): Promise<Game> {
    return this.core.invoke({ type: "gameGet", id });
  }

  createGame(input: CreateGameInput): Promise<Game> {
    return this.core.invoke({
      type: "gameCreate",
      input: {
        name: input.name,
        defaultLaunchUrl: input.defaultLaunchUrl,
        ...(typeof input.iconImageDataUrl === "string"
          ? { iconImageDataUrl: input.iconImageDataUrl }
          : {}),
        ...(typeof input.coverImageDataUrl === "string"
          ? { coverImageDataUrl: input.coverImageDataUrl }
          : {}),
        ...(input.browserEngine === undefined ? {} : { browserEngine: input.browserEngine })
      }
    });
  }

  updateGame(id: string, input: UpdateGameInput): Promise<Game> {
    return this.core.invoke({
      type: "gameUpdate",
      id,
      input: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.defaultLaunchUrl === undefined
          ? {}
          : { defaultLaunchUrl: input.defaultLaunchUrl }),
        ...(typeof input.iconImageDataUrl === "string"
          ? { iconImageDataUrl: input.iconImageDataUrl }
          : {}),
        setIconImageDataUrl: input.iconImageDataUrl !== undefined,
        ...(typeof input.coverImageDataUrl === "string"
          ? { coverImageDataUrl: input.coverImageDataUrl }
          : {}),
        setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
        ...(input.browserEngine === undefined ? {} : { browserEngine: input.browserEngine })
      }
    });
  }

  resetBuiltinGame(id: string): Promise<Game> {
    return this.core.invoke({ type: "gameResetBuiltin", id });
  }

  async deleteGame(id: string): Promise<void> {
    await this.core.invoke({ type: "gameDelete", id });
  }

  deleteGames(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke({ type: "gamesDelete", ids });
  }
}
