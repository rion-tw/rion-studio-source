import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BUILTIN_GAME_DEFINITIONS,
  createBuiltinGame,
  getBuiltinGameDefinition
} from "../../shared/games";
import type {
  CreateGameInput,
  Game,
  InheritableBrowserLaunchMode,
  Role,
  RoleDefaults,
  UpdateGameInput
} from "../../shared/types";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";
import type { RoleStore } from "../roles/RoleStore";

interface GamesFile {
  games: Game[];
}

const MAX_IMAGE_BYTES = 1_500_000;
const MAX_IMAGE_DATA_URL_LENGTH = 2_000_128;
const MAX_URL_LENGTH = 2_048;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

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

export class GameStore {
  private cachedFile: GamesFile | undefined;
  private readonly gamesPath: string;
  private readonly taskQueue = new SerialTaskQueue();

  constructor(
    private readonly userDataDir: string,
    private readonly roleStore: Pick<RoleStore, "assignGameIds" | "listRoles">
  ) {
    this.gamesPath = join(userDataDir, "games.json");
  }

  async initialize(): Promise<void> {
    const roles = await this.roleStore.listRoles();
    const assignments = await this.taskQueue.run(async () => {
      const file = await this.readGamesFile();
      const assignmentMap = new Map<string, string>();
      let changed = false;

      for (const role of roles) {
        if (role.gameId && file.games.some((game) => game.id === role.gameId)) {
          continue;
        }

        const normalizedLaunchUrl = normalizeHttpUrl(role.launchUrl);
        let game = file.games.find((item) => normalizeHttpUrl(item.defaultLaunchUrl) === normalizedLaunchUrl);
        if (!game) {
          const name = createUniqueName(file.games, createImportedGameName(normalizedLaunchUrl));
          const timestamp = new Date().toISOString();
          game = {
            id: randomUUID(),
            source: "custom",
            name,
            defaultLaunchUrl: normalizedLaunchUrl,
            browserLaunchMode: "inherit",
            createdAt: timestamp,
            updatedAt: timestamp
          };
          file.games.push(game);
          changed = true;
        }

        assignmentMap.set(role.id, game.id);
      }

      if (changed) {
        await this.writeGamesFile(file);
      }

      return assignmentMap;
    });

    if (assignments.size > 0) {
      await this.roleStore.assignGameIds(assignments);
    }
  }

  async listGames(): Promise<Game[]> {
    return this.taskQueue.run(async () => structuredClone((await this.readGamesFile()).games));
  }

  async replaceGamesForImport(games: Game[], publishCache = true): Promise<Game[]> {
    return this.taskQueue.run(async () => {
      const normalized = games.map((game) => normalizeStoredGame(game));
      ensureNamesAreUnique(normalized);
      const file = { games: structuredClone(games) };
      await this.writeGamesFile(file, publishCache);
      return structuredClone(file.games);
    });
  }

  publishGamesForImport(games: Game[]): void {
    this.cachedFile = { games: structuredClone(games) };
  }

  async getGame(id: string): Promise<Game> {
    return this.taskQueue.run(async () => {
      const game = (await this.readGamesFile()).games.find((item) => item.id === id);
      if (!game) {
        throw new GameStoreError("GAME_NOT_FOUND", "Game not found.");
      }
      return structuredClone(game);
    });
  }

  async createGame(input: CreateGameInput): Promise<Game> {
    return this.taskQueue.run(async () => {
      const file = await this.readGamesFile();
      const timestamp = new Date().toISOString();
      const name = normalizeName(input.name);
      ensureUniqueName(file.games, name);
      const game: Game = {
        id: randomUUID(),
        source: "custom",
        name,
        defaultLaunchUrl: normalizeHttpUrl(input.defaultLaunchUrl),
        loginUrl: normalizeOptionalHttpUrl(input.loginUrl),
        iconImageDataUrl: normalizeImageDataUrl(input.iconImageDataUrl),
        coverImageDataUrl: normalizeCoverImageDataUrl(input.coverImageDataUrl),
        roleDefaults: normalizeOptionalRoleDefaults(input.roleDefaults),
        browserLaunchMode: normalizeBrowserLaunchMode(input.browserLaunchMode),
        createdAt: timestamp,
        updatedAt: timestamp
      };

      file.games.push(game);
      await this.writeGamesFile(file);
      return structuredClone(game);
    });
  }

  async updateGame(id: string, input: UpdateGameInput): Promise<Game> {
    return this.taskQueue.run(async () => {
      const file = await this.readGamesFile();
      const index = file.games.findIndex((item) => item.id === id);
      if (index === -1) {
        throw new GameStoreError("GAME_NOT_FOUND", "Game not found.");
      }

      const current = file.games[index];
      if (current.source === "builtin") {
        if (input.name !== undefined && normalizeName(input.name) !== current.name) {
          throw new GameStoreError("GAME_BUILTIN_FIELD_PROTECTED", "Built-in game name cannot be changed.");
        }
        if (input.iconImageDataUrl !== undefined) {
          throw new GameStoreError("GAME_BUILTIN_FIELD_PROTECTED", "Built-in game icon cannot be changed.");
        }
        if (input.coverImageDataUrl !== undefined) {
          throw new GameStoreError("GAME_BUILTIN_FIELD_PROTECTED", "Built-in game cover cannot be changed.");
        }
      }

      const name = input.name === undefined ? current.name : normalizeName(input.name);
      ensureUniqueName(file.games, name, id);
      const updated: Game = {
        ...current,
        name,
        defaultLaunchUrl: input.defaultLaunchUrl === undefined
          ? current.defaultLaunchUrl
          : normalizeHttpUrl(input.defaultLaunchUrl),
        loginUrl: input.loginUrl === undefined ? current.loginUrl : normalizeOptionalHttpUrl(input.loginUrl),
        iconImageDataUrl: input.iconImageDataUrl === undefined
          ? current.iconImageDataUrl
          : normalizeImageDataUrl(input.iconImageDataUrl),
        coverImageDataUrl: input.coverImageDataUrl === undefined
          ? current.coverImageDataUrl
          : normalizeCoverImageDataUrl(input.coverImageDataUrl),
        roleDefaults: input.roleDefaults === undefined
          ? current.roleDefaults
          : normalizeOptionalRoleDefaults(input.roleDefaults),
        browserLaunchMode: input.browserLaunchMode === undefined
          ? current.browserLaunchMode
          : normalizeBrowserLaunchMode(input.browserLaunchMode),
        updatedAt: new Date().toISOString()
      };

      file.games[index] = updated;
      await this.writeGamesFile(file);
      return structuredClone(updated);
    });
  }

  async resetBuiltinGame(id: string): Promise<Game> {
    return this.taskQueue.run(async () => {
      const file = await this.readGamesFile();
      const index = file.games.findIndex((item) => item.id === id);
      const current = file.games[index];
      const definition = current?.builtinKey ? getBuiltinGameDefinition(current.builtinKey) : undefined;
      if (index === -1 || !current || current.source !== "builtin" || !definition) {
        throw new GameStoreError("GAME_NOT_BUILTIN", "Only built-in games can be reset.");
      }

      const updated: Game = {
        ...createBuiltinGame(definition, current.createdAt),
        updatedAt: new Date().toISOString()
      };
      file.games[index] = updated;
      await this.writeGamesFile(file);
      return structuredClone(updated);
    });
  }

  async deleteGame(id: string): Promise<void> {
    const roles = await this.roleStore.listRoles();
    await this.taskQueue.run(async () => {
      const file = await this.readGamesFile();
      const game = file.games.find((item) => item.id === id);
      if (!game) {
        throw new GameStoreError("GAME_NOT_FOUND", "Game not found.");
      }
      if (game.source === "builtin") {
        throw new GameStoreError("GAME_BUILTIN_DELETE_FORBIDDEN", "Built-in games cannot be deleted.");
      }

      const assignedRoles = roles.filter((role) => role.gameId === id);
      if (assignedRoles.length > 0) {
        throw new GameStoreError(
          "GAME_IN_USE",
          "Move or delete assigned roles before deleting this game.",
          { roleCount: assignedRoles.length, roleNames: assignedRoles.map((role) => role.name) }
        );
      }

      await this.writeGamesFile({ games: file.games.filter((item) => item.id !== id) });
    });
  }

  async findGameByLaunchUrl(launchUrl: string): Promise<Game | undefined> {
    const normalized = normalizeHttpUrl(launchUrl);
    return this.taskQueue.run(async () => {
      const game = (await this.readGamesFile()).games.find(
        (item) => normalizeHttpUrl(item.defaultLaunchUrl) === normalized
      );
      return game ? structuredClone(game) : undefined;
    });
  }

  private async readGamesFile(): Promise<GamesFile> {
    if (this.cachedFile) {
      return structuredClone(this.cachedFile);
    }

    let storedGames: Game[] = [];
    let shouldWrite = false;
    try {
      const parsed = JSON.parse(await readFile(this.gamesPath, "utf8")) as { games?: unknown };
      if (!Array.isArray(parsed.games)) {
        throw new GameStoreError("GAME_FILE_INVALID", "Game data file is invalid.");
      }
      storedGames = parsed.games.map((value) => normalizeStoredGame(value));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      shouldWrite = true;
    }

    const timestamp = new Date().toISOString();
    for (const definition of BUILTIN_GAME_DEFINITIONS) {
      const index = storedGames.findIndex(
        (game) => game.id === definition.id || game.builtinKey === definition.builtinKey
      );
      if (index === -1) {
        storedGames.push(createBuiltinGame(definition, timestamp));
        shouldWrite = true;
        continue;
      }

      const current = storedGames[index];
      const protectedFields = {
        id: definition.id,
        source: "builtin" as const,
        builtinKey: definition.builtinKey,
        name: definition.name,
        iconImageDataUrl: undefined,
        coverImageDataUrl: undefined
      };
      if (
        current.id !== protectedFields.id ||
        current.source !== protectedFields.source ||
        current.builtinKey !== protectedFields.builtinKey ||
        current.name !== protectedFields.name ||
        current.iconImageDataUrl !== undefined ||
        current.coverImageDataUrl !== undefined
      ) {
        storedGames[index] = { ...current, ...protectedFields };
        shouldWrite = true;
      }
    }

    for (const builtin of storedGames.filter((game) => game.source === "builtin")) {
      for (const custom of storedGames.filter(
        (game) => game.source === "custom" && game.name.toLowerCase() === builtin.name.toLowerCase()
      )) {
        custom.name = createUniqueName(storedGames, `${custom.name} (Custom)`);
        custom.updatedAt = timestamp;
        shouldWrite = true;
      }
    }

    ensureNamesAreUnique(storedGames);
    const file = { games: storedGames };
    if (shouldWrite) {
      await this.writeGamesFile(file);
    } else {
      this.cachedFile = structuredClone(file);
    }
    return structuredClone(file);
  }

  private async writeGamesFile(file: GamesFile, publishCache = true): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true });
    await writeJsonFileAtomically(this.gamesPath, file);
    if (publishCache) {
      this.cachedFile = structuredClone(file);
    }
  }
}

function normalizeStoredGame(value: unknown): Game {
  if (!isRecord(value)) {
    throw new GameStoreError("GAME_FILE_INVALID", "Game data file is invalid.");
  }

  const definition = typeof value.builtinKey === "string"
    ? getBuiltinGameDefinition(value.builtinKey)
    : typeof value.id === "string"
      ? getBuiltinGameDefinition(value.id)
      : undefined;
  const source = definition ? "builtin" : value.source === "custom" ? "custom" : undefined;
  if (!source || typeof value.id !== "string") {
    throw new GameStoreError("GAME_FILE_INVALID", "Game data file is invalid.");
  }

  return {
    id: definition?.id ?? value.id,
    source,
    ...(definition ? { builtinKey: definition.builtinKey } : {}),
    name: definition?.name ?? normalizeName(value.name),
    defaultLaunchUrl: normalizeHttpUrl(value.defaultLaunchUrl),
    loginUrl: normalizeOptionalHttpUrl(value.loginUrl),
    iconImageDataUrl: definition ? undefined : normalizeImageDataUrl(value.iconImageDataUrl),
    coverImageDataUrl: definition ? undefined : normalizeCoverImageDataUrl(value.coverImageDataUrl),
    roleDefaults: normalizeOptionalRoleDefaults(value.roleDefaults),
    browserLaunchMode: normalizeBrowserLaunchMode(value.browserLaunchMode),
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt)
  };
}

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new GameStoreError("GAME_NAME_REQUIRED", "Game name is required.");
  }
  if (name.length > 80) {
    throw new GameStoreError("GAME_NAME_TOO_LONG", "Game name must be 80 characters or fewer.");
  }
  return name;
}

function ensureUniqueName(games: Game[], name: string, currentId?: string): void {
  if (games.some((game) => game.id !== currentId && game.name.toLowerCase() === name.toLowerCase())) {
    throw new GameStoreError("GAME_NAME_DUPLICATE", "A game with this name already exists.");
  }
}

function ensureNamesAreUnique(games: Game[]): void {
  const names = new Set<string>();
  for (const game of games) {
    const key = game.name.toLowerCase();
    if (names.has(key)) {
      throw new GameStoreError("GAME_NAME_DUPLICATE", "Game names in the data file must be unique.");
    }
    names.add(key);
  }
}

function createUniqueName(games: Game[], baseName: string): string {
  if (!games.some((game) => game.name.toLowerCase() === baseName.toLowerCase())) {
    return baseName;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!games.some((game) => game.name.toLowerCase() === candidate.toLowerCase())) {
      return candidate;
    }
  }
  throw new GameStoreError("GAME_NAME_DUPLICATE", "Unable to create a unique imported game name.");
}

function createImportedGameName(launchUrl: string): string {
  const url = new URL(launchUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return path && path !== "play" ? `${url.hostname} · ${path.slice(0, 32)}` : url.hostname;
}

function normalizeHttpUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new GameStoreError("GAME_URL_INVALID", "Game URL must use HTTP or HTTPS.");
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    throw new GameStoreError("GAME_URL_INVALID", "Game URL must use HTTP or HTTPS.");
  }
}

function normalizeOptionalHttpUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeHttpUrl(value);
}

function normalizeImageDataUrl(value: unknown): string | undefined {
  return normalizeGameImageDataUrl(
    value,
    "GAME_ICON_INVALID",
    "Game icon must be a valid image data URL."
  );
}

function normalizeCoverImageDataUrl(value: unknown): string | undefined {
  return normalizeGameImageDataUrl(
    value,
    "GAME_COVER_INVALID",
    "Game cover must be a valid image data URL up to 1.5 MB."
  );
}

function normalizeGameImageDataUrl(value: unknown, code: string, message: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const image = typeof value === "string" ? value.trim() : "";
  if (
    !image ||
    image.length > MAX_IMAGE_DATA_URL_LENGTH ||
    !IMAGE_DATA_URL_PATTERN.test(image) ||
    getBase64PayloadByteLength(image) > MAX_IMAGE_BYTES
  ) {
    throw new GameStoreError(code, message);
  }
  return image;
}

function getBase64PayloadByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function normalizeOptionalRoleDefaults(value: unknown): RoleDefaults | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new GameStoreError("GAME_ROLE_DEFAULTS_INVALID", "Game role defaults are invalid.");
  }
  const { windowWidth, windowHeight, launchPreset } = value;
  if (
    !Number.isInteger(windowWidth) || Number(windowWidth) < 640 || Number(windowWidth) > 7680 ||
    !Number.isInteger(windowHeight) || Number(windowHeight) < 640 || Number(windowHeight) > 7680 ||
    (launchPreset !== "balanced" && launchPreset !== "performance")
  ) {
    throw new GameStoreError("GAME_ROLE_DEFAULTS_INVALID", "Game role defaults are invalid.");
  }
  return {
    windowWidth: Number(windowWidth),
    windowHeight: Number(windowHeight),
    launchPreset
  };
}

function normalizeBrowserLaunchMode(value: unknown): InheritableBrowserLaunchMode {
  if (value === undefined || value === null) {
    return "inherit";
  }
  if (value === "auto" || value === "embedded" || value === "external" || value === "inherit") {
    return value;
  }
  throw new GameStoreError("GAME_LAUNCH_MODE_INVALID", "Game browser launch mode is invalid.");
}

function normalizeTimestamp(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function getGameLoginUrl(game: Game, role: Role): string {
  return game.loginUrl ?? role.launchUrl;
}
