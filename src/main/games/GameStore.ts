import type {
  CreateGameInput,
  Game,
  UpdateGameInput
} from "../../shared/types";
import type { RoleStore } from "../roles/RoleStore";
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
    private readonly roleStore: Pick<RoleStore, "assignGameIds" | "listRoles">,
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
    try {
      await this.repository().deleteGame(id);
    } catch (error) {
      if (getErrorCode(error) !== "GAME_IN_USE") throw error;
      const assignedRoles = (await this.roleStore.listRoles()).filter((role) => role.gameId === id);
      throw new GameStoreError("GAME_IN_USE", "Move or delete assigned roles before deleting this game.", {
        roleCount: assignedRoles.length,
        roleNames: assignedRoles.map((role) => role.name)
      });
    }
  }

  private repository(): StateRepository {
    return this.stateRepository;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
