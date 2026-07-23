import type {
  BulkDeleteResult,
  CreateGameInput,
  Game,
  UpdateGameInput
} from "../../shared/types";
import type { StateRepository } from "../core/RustStateRepository";

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
    private readonly stateRepository: StateRepository
  ) {}

  listGames(): Promise<Game[]> {
    return this.repository().listGames();
  }

  getGame(id: string): Promise<Game> {
    return this.repository().getGame(id);
  }

  createGame(input: CreateGameInput): Promise<Game> {
    return this.repository().createGame(input);
  }

  updateGame(id: string, input: UpdateGameInput): Promise<Game> {
    return this.repository().updateGame(id, input);
  }

  resetBuiltinGame(id: string): Promise<Game> {
    return this.repository().resetBuiltinGame(id);
  }

  async deleteGame(id: string): Promise<void> {
    await this.repository().deleteGame(id);
  }

  deleteGames(ids: string[]): Promise<BulkDeleteResult> {
    return this.repository().deleteGames(ids);
  }

  private repository(): StateRepository {
    return this.stateRepository;
  }
}
