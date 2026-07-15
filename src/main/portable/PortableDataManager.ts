import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { normalizeGameBrowserSettings } from "../../shared/browserFonts";
import { BUILTIN_GAME_DEFINITIONS } from "../../shared/games";
import {
  areMacroTriggersEqual,
  macroRoleAssignmentsOverlap,
  MACRO_OVERLAY_TRIGGER
} from "../../shared/macroShortcuts";
import type { MacroStore } from "../macros/MacroStore";
import type { GameStore } from "../games/GameStore";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import {
  DEFAULT_LAUNCH_URL,
  DEFAULT_ROLE_WINDOW_HEIGHT,
  DEFAULT_ROLE_WINDOW_WIDTH,
  type CreateLaunchWorkspaceInput,
  type CreateMacroInput,
  type CreateRoleInput,
  type CreateGameInput,
  type GameBrowserSettings,
  type Game,
  type InheritableBrowserLaunchMode,
  type LaunchPreset,
  type MacroRepeat,
  type MacroStep,
  type MacroTrigger,
  type PortableDataSelection,
  type PortableExportInput,
  type PortableExportResult,
  type PortableImportInput,
  type PortableImportPreview,
  type PortableImportResult,
  type PortableImportWarning,
  type PortableLaunchWorkspace,
  type PortableGame,
  type PortableMacro,
  type PortablePreferences,
  type PortableRole,
  type RionPortableDataV2,
  type RoleDefaults
} from "../../shared/types";
import {
  isWorkspaceBrowserZoomPercent,
  isWorkspaceLayoutTemplate,
  MAX_WORKSPACE_SLOTS,
  MIN_WORKSPACE_SLOT_SIZE,
  normalizeWorkspaceRectEdges
} from "../../shared/workspaceLayout";

interface PortableSaveDialogOptions {
  defaultPath: string;
  filters: Array<{ extensions: string[]; name: string }>;
  title: string;
}

interface PortableOpenDialogOptions {
  filters: Array<{ extensions: string[]; name: string }>;
  properties: Array<"openFile">;
  title: string;
}

interface PortableSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

interface PortableOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface PortableDataManagerOptions {
  createImportId?: () => string;
  getAppVersion: () => string;
  gameStore: Pick<GameStore, "createGame" | "listGames" | "updateGame">;
  now?: () => Date;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  roleStore: Pick<RoleStore, "createRole" | "listRoles">;
  showOpenDialog: (options: PortableOpenDialogOptions) => Promise<PortableOpenDialogResult>;
  showSaveDialog: (options: PortableSaveDialogOptions) => Promise<PortableSaveDialogResult>;
  workspaceStore: Pick<LaunchWorkspaceStore, "createWorkspace" | "listWorkspaces">;
  macroStore: Pick<MacroStore, "createMacro" | "listMacros">;
  writeTextFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

interface ImportPlan {
  games: Array<{ existingId?: string; name: string; source: PortableGame }>;
  roles: Array<{ name: string; source: PortableRole }>;
  workspaces: Array<{ name: string; source: PortableLaunchWorkspace }>;
  macros: Array<{ name: string; roleIds: string[]; source: PortableMacro; trigger?: MacroTrigger }>;
  warnings: PortableImportWarning[];
}

interface PendingImport {
  data: RionPortableDataV2;
  filePath: string;
}

const PORTABLE_APP_NAME = "Rion Studio";
const PORTABLE_SCHEMA_VERSION = 2;
const MAX_COVER_IMAGE_DATA_URL_LENGTH = 1_500_000;
const MAX_GAME_ICON_BYTES = 1_500_000;
const MAX_GAME_ICON_DATA_URL_LENGTH = 2_000_128;
const MAX_LAUNCH_URL_LENGTH = 2_048;
const MAX_NAME_LENGTH = 80;
const MACRO_STEPS_MAX_LENGTH = 100;
const MACRO_DELAY_MAX_MS = 600_000;
const MACRO_CODE_MAX_LENGTH = 48;
const MACRO_LABEL_MAX_LENGTH = 48;
const COVER_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const COVER_IMAGE_DOMINANT_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_PORTABLE_DATA_SELECTION: PortableDataSelection = {
  games: true,
  roles: true,
  launchWorkspaces: true,
  macros: true,
  preferences: true
};

export class PortableDataError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PortableDataError";
  }
}

export class PortableDataManager {
  private readonly createImportId: () => string;
  private readonly now: () => Date;
  private readonly pendingImports = new Map<string, PendingImport>();
  private readonly readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly writeTextFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

  constructor(private readonly options: PortableDataManagerOptions) {
    this.createImportId = options.createImportId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.readTextFile = options.readTextFile ?? readFile;
    this.writeTextFile = options.writeTextFile ?? writeFile;
  }

  async exportData(input: PortableExportInput = {}): Promise<PortableExportResult | null> {
    const selection = normalizePortableDataSelection(input.selection);
    const data = await this.createPortableData(input.preferences, selection);
    ensurePortableContentSelected(data);
    const dialogResult = await this.options.showSaveDialog({
      defaultPath: `rion-studio-${formatDate(this.now())}.json`,
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      title: "Export Rion Studio JSON"
    });

    if (dialogResult.canceled || !dialogResult.filePath) {
      return null;
    }

    await this.writeTextFile(dialogResult.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const effectiveSelection = getEffectivePortableDataSelection(data);

    return {
      filePath: dialogResult.filePath,
      gameCount: data.games.length,
      roleCount: data.roles.length,
      workspaceCount: data.launchWorkspaces.length,
      macroCount: data.macros.length,
      preferencesIncluded: Boolean(data.preferences),
      selection: effectiveSelection
    };
  }

  async previewImport(): Promise<PortableImportPreview | null> {
    const dialogResult = await this.options.showOpenDialog({
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      properties: ["openFile"],
      title: "Import Rion Studio JSON"
    });

    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return null;
    }

    const filePath = dialogResult.filePaths[0];
    const data = parsePortableData(await this.readTextFile(filePath, "utf8"));
    const plan = await this.buildImportPlan(data);
    const importId = this.createImportId();

    this.pendingImports.set(importId, { data, filePath });

    return {
      importId,
      filePath,
      exportedAt: data.exportedAt,
      appVersion: data.appVersion,
      gameCount: plan.games.length,
      roleCount: plan.roles.length,
      workspaceCount: plan.workspaces.length,
      macroCount: plan.macros.length,
      preferences: data.preferences,
      warnings: plan.warnings
    };
  }

  async applyImport(input: PortableImportInput): Promise<PortableImportResult> {
    const selection = normalizePortableDataSelection(input?.selection, false);
    const pendingImport = this.pendingImports.get(input?.importId);

    if (!pendingImport) {
      throw new PortableDataError(
        "PORTABLE_IMPORT_EXPIRED",
        "Portable import session expired. Choose the JSON file again."
      );
    }

    const selectedData = selectPortableData(pendingImport.data, selection);
    ensurePortableContentSelected(selectedData);
    this.pendingImports.delete(input.importId);
    const plan = await this.buildImportPlan(selectedData);
    const gameIdMap = new Map<string, string>();
    const roleIdMap = new Map<string, string>();
    let gameCount = 0;
    let roleCount = 0;
    let workspaceCount = 0;
    let macroCount = 0;

    for (const gamePlan of plan.games) {
      const savedGame = gamePlan.existingId
        ? await this.options.gameStore.updateGame(gamePlan.existingId, toCreateGameInput(gamePlan.source, gamePlan.name))
        : await this.options.gameStore.createGame(toCreateGameInput(gamePlan.source, gamePlan.name));
      gameIdMap.set(gamePlan.source.id, savedGame.id);
      gameCount += 1;
    }

    for (const rolePlan of plan.roles) {
      const gameId = rolePlan.source.gameId ? gameIdMap.get(rolePlan.source.gameId) : undefined;
      if (!gameId) {
        throw new PortableDataError("PORTABLE_ROLE_GAME_MISSING", "Imported role game is unavailable.");
      }
      const createdRole = await this.options.roleStore.createRole(
        toCreateRoleInput(rolePlan.source, rolePlan.name, gameId)
      );
      roleIdMap.set(rolePlan.source.id, createdRole.id);
      roleCount += 1;
    }

    for (const workspacePlan of plan.workspaces) {
      await this.options.workspaceStore.createWorkspace(
        toCreateWorkspaceInput(workspacePlan.source, workspacePlan.name, roleIdMap)
      );
      workspaceCount += 1;
    }

    for (const macroPlan of plan.macros) {
      await this.options.macroStore.createMacro(
        toCreateMacroInput(
          macroPlan.source,
          macroPlan.name,
          macroPlan.roleIds,
          macroPlan.trigger,
          roleIdMap
        )
      );
      macroCount += 1;
    }

    return {
      gameCount,
      roleCount,
      workspaceCount,
      macroCount,
      preferencesIncluded: Boolean(selectedData.preferences),
      ...(selectedData.preferences ? { preferences: selectedData.preferences } : {}),
      selection: getEffectivePortableDataSelection(selectedData),
      warnings: plan.warnings
    };
  }

  private async createPortableData(
    preferences: PortablePreferences | undefined,
    selection: PortableDataSelection
  ): Promise<RionPortableDataV2> {
    const [games, roles, launchWorkspaces, macros] = await Promise.all([
      this.options.gameStore.listGames(),
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces(),
      this.options.macroStore.listMacros()
    ]);
    const normalizedPreferences = selection.preferences ? normalizePortablePreferences(preferences) : undefined;

    return {
      app: PORTABLE_APP_NAME,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      exportedAt: this.now().toISOString(),
      appVersion: this.options.getAppVersion(),
      games: selection.games ? games.map(toPortableGame) : [],
      roles: selection.roles ? roles.map((role) => ({
        id: role.id,
        gameId: role.gameId,
        name: role.name,
        launchUrl: role.launchUrl,
        windowWidth: role.windowWidth,
        windowHeight: role.windowHeight,
        notes: role.notes,
        launchPreset: role.launchPreset,
        ...(role.coverImageDataUrl ? { coverImageDataUrl: role.coverImageDataUrl } : {}),
        ...(role.coverImageDominantColor ? { coverImageDominantColor: role.coverImageDominantColor } : {})
      })) : [],
      launchWorkspaces: selection.launchWorkspaces ? launchWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        template: workspace.template,
        browserLaunchMode: workspace.browserLaunchMode,
        browserZoomPercent: workspace.browserZoomPercent,
        slots: workspace.slots.map((slot) => ({
          id: slot.id,
          ...(slot.roleId ? { roleId: slot.roleId } : {}),
          rect: { ...slot.rect }
        }))
      })) : [],
      macros: selection.macros ? macros.map((macro) => ({
        id: macro.id,
        name: macro.name,
        roleIds: [...macro.roleIds],
        ...(macro.trigger ? { trigger: { ...macro.trigger } } : {}),
        repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
        steps: macro.steps.map((step) => ({ ...step }))
      })) : [],
      ...(normalizedPreferences ? { preferences: normalizedPreferences } : {})
    };
  }

  private async buildImportPlan(data: RionPortableDataV2): Promise<ImportPlan> {
    const [existingGames, existingRoles, existingWorkspaces] = await Promise.all([
      this.options.gameStore.listGames(),
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces()
    ]);
    const warnings: PortableImportWarning[] = [];
    const usedGameNames = new Set(existingGames.map((game) => normalizeNameKey(game.name)));
    const usedRoleNames = new Set(existingRoles.map((role) => normalizeNameKey(role.name)));
    const usedWorkspaceNames = new Set(existingWorkspaces.map((workspace) => normalizeNameKey(workspace.name)));
    const importedRoleIds = new Set(data.roles.map((role) => role.id));

    const games = data.games.map((game) => {
      if (game.source === "builtin" && game.builtinKey) {
        const existing = existingGames.find((item) => item.builtinKey === game.builtinKey);
        if (existing) {
          warnings.push({ code: "BUILTIN_GAME_DEFAULTS_REPLACED", itemName: existing.name });
          usedGameNames.add(normalizeNameKey(existing.name));
          return { existingId: existing.id, name: existing.name, source: game };
        }
      }

      const name = reserveUniqueName(game.name, usedGameNames);
      if (name !== game.name) {
        warnings.push({ code: "GAME_NAME_RENAMED", itemName: game.name, replacementName: name });
      }
      return { name, source: game };
    });

    const roles = data.roles.map((role) => {
      const name = reserveUniqueName(role.name, usedRoleNames);
      if (role.gameRecovered) {
        warnings.push({ code: "ROLE_GAME_RECOVERED", itemName: role.name });
      }
      if (name !== role.name) {
        warnings.push({
          code: "ROLE_NAME_RENAMED",
          itemName: role.name,
          replacementName: name
        });
      }

      return { name, source: role };
    });

    const workspaces = data.launchWorkspaces.map((workspace) => {
      const missingRoleCount = workspace.slots.filter(
        (slot) => slot.roleId && !importedRoleIds.has(slot.roleId)
      ).length;
      const name = reserveUniqueName(workspace.name, usedWorkspaceNames);

      if (name !== workspace.name) {
        warnings.push({
          code: "WORKSPACE_NAME_RENAMED",
          itemName: workspace.name,
          replacementName: name
        });
      }

      if (missingRoleCount > 0) {
        warnings.push({
          code: "WORKSPACE_ROLE_MISSING",
          count: missingRoleCount,
          itemName: workspace.name
        });
      }

      return { name, source: workspace };
    });

    const macros: ImportPlan["macros"] = [];
    data.macros.forEach((macro) => {
      const importedRoleIdList = macro.roleIds.filter((roleId) => importedRoleIds.has(roleId));
      const roleIds = [...new Set(importedRoleIdList)];
      const missingRoleCount = [...new Set(macro.roleIds)].filter((roleId) => !importedRoleIds.has(roleId)).length;

      if (roleIds.length === 0) {
        warnings.push({
          code: "MACRO_SKIPPED_NO_ROLES",
          itemName: macro.name
        });
        return;
      }

      if (missingRoleCount > 0) {
        warnings.push({
          code: "MACRO_ROLE_MISSING",
          count: missingRoleCount,
          itemName: macro.name
        });
      }

      let trigger = macro.trigger ? { ...macro.trigger } : undefined;
      if (trigger && areMacroTriggersEqual(trigger, MACRO_OVERLAY_TRIGGER)) {
        warnings.push({ code: "MACRO_SHORTCUT_CLEARED_RESERVED", itemName: macro.name });
        trigger = undefined;
      } else if (
        trigger &&
        macros.some(
          (plannedMacro) =>
            areMacroTriggersEqual(plannedMacro.trigger, trigger) &&
            macroRoleAssignmentsOverlap(plannedMacro.roleIds, roleIds)
        )
      ) {
        warnings.push({ code: "MACRO_SHORTCUT_CLEARED_CONFLICT", itemName: macro.name });
        trigger = undefined;
      }

      macros.push({ name: macro.name, roleIds, source: macro, trigger });
    });

    return { games, roles, workspaces, macros, warnings };
  }
}

function normalizePortableDataSelection(value: unknown, useDefaultWhenMissing = true): PortableDataSelection {
  if (value === undefined && useDefaultWhenMissing) {
    return { ...DEFAULT_PORTABLE_DATA_SELECTION };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortableDataError("PORTABLE_SELECTION_INVALID", "Portable data selection is invalid.");
  }

  const selection = value as Record<string, unknown>;
  const gamesSelected = selection.games === undefined ? selection.roles : selection.games;
  if (
    typeof gamesSelected !== "boolean" ||
    typeof selection.roles !== "boolean" ||
    typeof selection.launchWorkspaces !== "boolean" ||
    typeof selection.macros !== "boolean" ||
    typeof selection.preferences !== "boolean"
  ) {
    throw new PortableDataError("PORTABLE_SELECTION_INVALID", "Portable data selection is invalid.");
  }

  const requiresRoles = selection.launchWorkspaces || selection.macros;
  const roles = selection.roles || requiresRoles;
  return {
    games: gamesSelected || roles,
    roles,
    launchWorkspaces: selection.launchWorkspaces,
    macros: selection.macros,
    preferences: selection.preferences
  };
}

function selectPortableData(data: RionPortableDataV2, selection: PortableDataSelection): RionPortableDataV2 {
  return {
    app: data.app,
    schemaVersion: data.schemaVersion,
    exportedAt: data.exportedAt,
    appVersion: data.appVersion,
    games: selection.games ? data.games : [],
    roles: selection.roles ? data.roles : [],
    launchWorkspaces: selection.launchWorkspaces ? data.launchWorkspaces : [],
    macros: selection.macros ? data.macros : [],
    ...(selection.preferences && data.preferences ? { preferences: data.preferences } : {})
  };
}

function getEffectivePortableDataSelection(data: RionPortableDataV2): PortableDataSelection {
  return {
    games: data.games.length > 0,
    roles: data.roles.length > 0,
    launchWorkspaces: data.launchWorkspaces.length > 0,
    macros: data.macros.length > 0,
    preferences: Boolean(data.preferences)
  };
}

function ensurePortableContentSelected(data: RionPortableDataV2): void {
  const selection = getEffectivePortableDataSelection(data);
  if (!selection.games && !selection.roles && !selection.launchWorkspaces && !selection.macros && !selection.preferences) {
    throw new PortableDataError("PORTABLE_SELECTION_EMPTY", "Select at least one available data category.");
  }
}

function toCreateRoleInput(role: PortableRole, name: string, gameId: string): CreateRoleInput {
  return {
    gameId,
    name,
    launchUrl: role.launchUrl,
    windowWidth: role.windowWidth,
    windowHeight: role.windowHeight,
    notes: role.notes,
    launchPreset: role.launchPreset,
    coverImageDataUrl: role.coverImageDataUrl ?? null,
    coverImageDominantColor: role.coverImageDominantColor ?? null
  };
}

function toCreateWorkspaceInput(
  workspace: PortableLaunchWorkspace,
  name: string,
  roleIdMap: Map<string, string>
): CreateLaunchWorkspaceInput {
  return {
    name,
    template: workspace.template,
    browserLaunchMode: workspace.browserLaunchMode ?? "inherit",
    browserZoomPercent: workspace.browserZoomPercent,
    slots: workspace.slots.map((slot) => {
      const mappedRoleId = slot.roleId ? roleIdMap.get(slot.roleId) : undefined;

      return {
        id: slot.id,
        ...(mappedRoleId ? { roleId: mappedRoleId } : {}),
        rect: { ...slot.rect }
      };
    })
  };
}

function toPortableGame(game: Game): PortableGame {
  return {
    id: game.id,
    source: game.source,
    ...(game.builtinKey ? { builtinKey: game.builtinKey } : {}),
    name: game.name,
    ...(game.iconImageDataUrl ? { iconImageDataUrl: game.iconImageDataUrl } : {}),
    defaultLaunchUrl: game.defaultLaunchUrl,
    ...(game.loginUrl ? { loginUrl: game.loginUrl } : {}),
    ...(game.roleDefaults ? { roleDefaults: { ...game.roleDefaults } } : {}),
    browserLaunchMode: game.browserLaunchMode
  };
}

function toCreateGameInput(game: PortableGame, name: string): CreateGameInput {
  return {
    name,
    defaultLaunchUrl: game.defaultLaunchUrl,
    loginUrl: game.loginUrl ?? null,
    iconImageDataUrl: game.source === "custom" ? game.iconImageDataUrl ?? null : undefined,
    roleDefaults: game.roleDefaults ?? null,
    browserLaunchMode: game.browserLaunchMode
  };
}

function toCreateMacroInput(
  macro: PortableMacro,
  name: string,
  roleIds: string[],
  trigger: MacroTrigger | undefined,
  roleIdMap: Map<string, string>
): CreateMacroInput {
  return {
    name,
    roleIds: roleIds.map((roleId) => roleIdMap.get(roleId)).filter(isString),
    trigger: trigger ? { ...trigger } : null,
    repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
    steps: macro.steps.map((step) => ({ ...step }))
  };
}

function parsePortableData(raw: string): RionPortableDataV2 {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const data = toRecord(parsed);

    if (
      data.app !== PORTABLE_APP_NAME ||
      (data.schemaVersion !== 1 && data.schemaVersion !== PORTABLE_SCHEMA_VERSION) ||
      !Array.isArray(data.roles) ||
      !Array.isArray(data.launchWorkspaces) ||
      !Array.isArray(data.macros)
    ) {
      throw new Error("Invalid portable metadata.");
    }

    let roles = data.roles.map(normalizePortableRole);
    const games = data.schemaVersion === PORTABLE_SCHEMA_VERSION && Array.isArray(data.games)
      ? data.games.map(normalizePortableGame)
      : [];
    const normalizedGames = recoverPortableGames(games, roles);
    roles = normalizedGames.roles;
    const launchWorkspaces = data.launchWorkspaces.map(normalizePortableLaunchWorkspace);
    const macros = data.macros.map(normalizePortableMacro);
    const preferences = normalizePortablePreferences(data.preferences);
    ensureUniqueIds(roles.map((role) => role.id));
    ensureUniqueIds(normalizedGames.games.map((game) => game.id));
    ensureUniqueIds(launchWorkspaces.map((workspace) => workspace.id));
    ensureUniqueIds(macros.map((macro) => macro.id));

    return {
      app: PORTABLE_APP_NAME,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : "",
      appVersion: typeof data.appVersion === "string" ? data.appVersion : "",
      games: normalizedGames.games,
      roles,
      launchWorkspaces,
      macros,
      ...(preferences ? { preferences } : {})
    };
  } catch (error) {
    if (error instanceof PortableDataError) {
      throw error;
    }

    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function normalizePortableRole(value: unknown): PortableRole {
  const role = toRecord(value);
  const coverImageDataUrl = normalizeOptionalCoverImageDataUrl(role.coverImageDataUrl);

  return {
    id: normalizeRequiredString(role.id),
    ...(typeof role.gameId === "string" && role.gameId.trim() ? { gameId: role.gameId.trim() } : {}),
    name: normalizeName(role.name),
    launchUrl: normalizeLaunchUrl(role.launchUrl),
    windowWidth: normalizeWindowSize(role.windowWidth, DEFAULT_ROLE_WINDOW_WIDTH),
    windowHeight: normalizeWindowSize(role.windowHeight, DEFAULT_ROLE_WINDOW_HEIGHT),
    notes: typeof role.notes === "string" ? role.notes.trim() : "",
    launchPreset: normalizeLaunchPreset(role.launchPreset),
    ...(coverImageDataUrl ? { coverImageDataUrl } : {}),
    ...(coverImageDataUrl ? normalizeOptionalCoverImageDominantColorProperty(role.coverImageDominantColor) : {})
  };
}

function normalizePortableGame(value: unknown): PortableGame {
  const game = toRecord(value);
  const source = game.source === "builtin" ? "builtin" : game.source === "custom" ? "custom" : undefined;
  if (!source) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
  const builtinKey = game.builtinKey === "flyff-universe" || game.builtinKey === "feifei-infinite-universe"
    ? game.builtinKey
    : undefined;
  if (source === "builtin" && !builtinKey) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
  const iconImageDataUrl = source === "custom"
    ? normalizeOptionalGameIconDataUrl(game.iconImageDataUrl)
    : undefined;
  const loginUrl = normalizeOptionalPortableUrl(game.loginUrl);
  const roleDefaults = normalizeOptionalPortableRoleDefaults(game.roleDefaults);
  return {
    id: normalizeRequiredString(game.id),
    source,
    ...(builtinKey ? { builtinKey } : {}),
    name: normalizeName(game.name),
    ...(iconImageDataUrl ? { iconImageDataUrl } : {}),
    defaultLaunchUrl: normalizeLaunchUrl(game.defaultLaunchUrl),
    ...(loginUrl ? { loginUrl } : {}),
    ...(roleDefaults ? { roleDefaults } : {}),
    browserLaunchMode: normalizeInheritableBrowserLaunchMode(game.browserLaunchMode)
  };
}

function recoverPortableGames(
  inputGames: PortableGame[],
  inputRoles: PortableRole[]
): { games: PortableGame[]; roles: PortableRole[] } {
  const games = inputGames.map((game) => ({ ...game }));
  const gameIds = new Set(games.map((game) => game.id));
  const gameByUrl = new Map(games.map((game) => [game.defaultLaunchUrl, game]));
  const usedNames = new Set(games.map((game) => normalizeNameKey(game.name)));

  const roles = inputRoles.map((role, index) => {
    if (role.gameId && gameIds.has(role.gameId)) {
      return role;
    }

    let game = gameByUrl.get(role.launchUrl);
    if (!game) {
      const definition = BUILTIN_GAME_DEFINITIONS.find(
        (item) => normalizeLaunchUrl(item.defaultLaunchUrl) === role.launchUrl
      );
      if (definition) {
        game = {
          id: definition.id,
          source: "builtin",
          builtinKey: definition.builtinKey,
          name: definition.name,
          defaultLaunchUrl: normalizeLaunchUrl(definition.defaultLaunchUrl),
          browserLaunchMode: definition.browserLaunchMode
        };
      } else {
        const baseName = createRecoveredGameName(role.launchUrl);
        game = {
          id: `recovered-game-${index + 1}-${randomUUID()}`,
          source: "custom",
          name: reserveUniqueName(baseName, usedNames),
          defaultLaunchUrl: role.launchUrl,
          browserLaunchMode: "inherit"
        };
      }
      games.push(game);
      gameIds.add(game.id);
      gameByUrl.set(game.defaultLaunchUrl, game);
      usedNames.add(normalizeNameKey(game.name));
    }

    return { ...role, gameId: game.id, gameRecovered: true };
  });

  return { games, roles };
}

function normalizePortableLaunchWorkspace(value: unknown): PortableLaunchWorkspace {
  const workspace = toRecord(value);
  const template = workspace.template;
  const browserZoomPercent = workspace.browserZoomPercent;

  if (!isWorkspaceLayoutTemplate(template) || !isWorkspaceBrowserZoomPercent(browserZoomPercent)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  if (!Array.isArray(workspace.slots) || workspace.slots.length > MAX_WORKSPACE_SLOTS) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
  const slots = workspace.slots.map((slot, index) => normalizePortableWorkspaceSlot(slot, index));
  const normalizedRects = normalizeWorkspaceRectEdges(slots.map((slot) => slot.rect));
  const normalizedSlots = slots.map((slot, index) => ({
    ...slot,
    rect: normalizedRects[index]
  }));
  const assignedRoleIds = normalizedSlots.map((slot) => slot.roleId).filter(isString);
  ensureUniqueIds(assignedRoleIds);

  return {
    id: normalizeRequiredString(workspace.id),
    name: normalizeName(workspace.name),
    template,
    browserLaunchMode: normalizeInheritableBrowserLaunchMode(workspace.browserLaunchMode),
    browserZoomPercent,
    slots: normalizedSlots
  };
}

function normalizePortableWorkspaceSlot(value: unknown, index: number): PortableLaunchWorkspace["slots"][number] {
  const slot = toRecord(value);
  const roleId = slot.roleId === undefined ? undefined : normalizeOptionalString(slot.roleId);

  return {
    id: typeof slot.id === "string" && slot.id.trim() ? slot.id.trim() : `slot-${index + 1}`,
    ...(roleId ? { roleId } : {}),
    rect: normalizeRect(slot.rect)
  };
}

function normalizePortableMacro(value: unknown): PortableMacro {
  const macro = toRecord(value);

  if (!Array.isArray(macro.roleIds)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    id: normalizeRequiredString(macro.id),
    name: normalizeName(macro.name),
    roleIds: macro.roleIds.map(normalizeRequiredString),
    ...(macro.trigger === undefined ? {} : normalizeOptionalTriggerProperty(macro.trigger)),
    repeat: normalizeRepeat(macro.repeat),
    steps: normalizeSteps(macro.steps)
  };
}

function normalizePortablePreferences(value: unknown): PortablePreferences | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const preferences = toRecord(value);
  const language = preferences.language;
  const themeMode = preferences.themeMode;
  const gameBrowserSettings = normalizeOptionalPortableGameBrowserSettings(preferences.gameBrowserSettings);
  const roleDefaults = normalizeOptionalPortableRoleDefaults(preferences.roleDefaults);
  const normalized: PortablePreferences = {};

  if (language === "en" || language === "zh-TW" || language === "zh-CN" || language === "ja") {
    normalized.language = language;
  }

  if (themeMode === "system" || themeMode === "light" || themeMode === "dark") {
    normalized.themeMode = themeMode;
  }

  if (roleDefaults) {
    normalized.roleDefaults = roleDefaults;
  }

  if (gameBrowserSettings) {
    normalized.gameBrowserSettings = gameBrowserSettings;
  }

  return normalized.language || normalized.themeMode || normalized.roleDefaults || normalized.gameBrowserSettings
    ? normalized
    : undefined;
}

function normalizeOptionalPortableGameBrowserSettings(value: unknown): GameBrowserSettings | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeGameBrowserSettings(value);
}

function normalizeOptionalPortableRoleDefaults(value: unknown): RoleDefaults | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    const defaults = toRecord(value);
    const windowWidth = defaults.windowWidth;
    const windowHeight = defaults.windowHeight;
    const launchPreset = defaults.launchPreset;

    if (
      !isValidRoleDefaultWindowSize(windowWidth) ||
      !isValidRoleDefaultWindowSize(windowHeight) ||
      (launchPreset !== "balanced" && launchPreset !== "performance")
    ) {
      return undefined;
    }

    return {
      windowWidth,
      windowHeight,
      launchPreset
    };
  } catch {
    return undefined;
  }
}

function isValidRoleDefaultWindowSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 640 && value <= 7680;
}

function normalizeOptionalTriggerProperty(value: unknown): { trigger?: MacroTrigger } {
  if (value === null || value === undefined) {
    return {};
  }

  const trigger = toRecord(value);

  return {
    trigger: {
      code: normalizeKeyCode(trigger.code),
      ctrl: Boolean(trigger.ctrl),
      alt: Boolean(trigger.alt),
      shift: Boolean(trigger.shift),
      meta: Boolean(trigger.meta)
    }
  };
}

function normalizeRepeat(value: unknown): MacroRepeat {
  const repeat = toRecord(value);

  if (repeat.type === "once") {
    return { type: "once" };
  }

  if (repeat.type !== "loop") {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    type: "loop",
    intervalMs: normalizeLoopInterval(repeat.intervalMs)
  };
}

function normalizeSteps(value: unknown): MacroStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MACRO_STEPS_MAX_LENGTH) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  const seenStepIds = new Set<string>();

  return value.map((rawStep) => {
    const step = toRecord(rawStep);
    const id =
      typeof step.id === "string" && step.id.trim() && !seenStepIds.has(step.id.trim())
        ? step.id.trim()
        : randomUUID();
    seenStepIds.add(id);

    switch (step.type) {
      case "key":
        return {
          id,
          type: "key",
          code: normalizeKeyCode(step.code),
          ...(normalizeOptionalLabel(step.label) ? { label: normalizeOptionalLabel(step.label) } : {})
        };
      case "click":
        return {
          id,
          type: "click",
          xPercent: normalizePercent(step.xPercent),
          yPercent: normalizePercent(step.yPercent)
        };
      case "delay":
        return {
          id,
          type: "delay",
          ms: normalizeMilliseconds(step.ms)
        };
      default:
        throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
    }
  });
}

function normalizeRect(value: unknown): PortableLaunchWorkspace["slots"][number]["rect"] {
  const rect = toRecord(value);
  const normalizedRect = {
    x: normalizeUnit(rect.x),
    y: normalizeUnit(rect.y),
    width: normalizeUnit(rect.width),
    height: normalizeUnit(rect.height)
  };

  if (
    normalizedRect.width < MIN_WORKSPACE_SLOT_SIZE ||
    normalizedRect.height < MIN_WORKSPACE_SLOT_SIZE ||
    normalizedRect.x + normalizedRect.width > 1.0001 ||
    normalizedRect.y + normalizedRect.height > 1.0001
  ) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    x: roundRectValue(normalizedRect.x),
    y: roundRectValue(normalizedRect.y),
    width: roundRectValue(normalizedRect.width),
    height: roundRectValue(normalizedRect.height)
  };
}

function normalizeRequiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return normalizeRequiredString(value);
}

function normalizeName(value: unknown): string {
  const name = normalizeRequiredString(value);

  if (name.length > MAX_NAME_LENGTH) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return name;
}

function normalizeLaunchPreset(value: unknown): LaunchPreset {
  if (value === "balanced" || value === "performance") {
    return value;
  }

  return "performance";
}

function normalizeLaunchUrl(value: unknown): string {
  const rawValue = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_LAUNCH_URL;

  if (rawValue.length > MAX_LAUNCH_URL_LENGTH) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  try {
    const url = new URL(rawValue);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported URL protocol.");
    }

    return url.toString();
  } catch {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function normalizeOptionalPortableUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return normalizeLaunchUrl(value);
}

function normalizeInheritableBrowserLaunchMode(value: unknown): InheritableBrowserLaunchMode {
  return value === "auto" || value === "embedded" || value === "external" ? value : "inherit";
}

function normalizeWindowSize(value: unknown, fallback: number): number {
  const size = value ?? fallback;

  if (!Number.isInteger(size) || Number(size) < 640 || Number(size) > 7680) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Number(size);
}

function normalizeOptionalCoverImageDataUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = normalizeRequiredString(value);

  if (trimmed.length > MAX_COVER_IMAGE_DATA_URL_LENGTH || !COVER_IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return trimmed;
}

function normalizeOptionalGameIconDataUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = normalizeRequiredString(value);
  if (
    trimmed.length > MAX_GAME_ICON_DATA_URL_LENGTH ||
    !COVER_IMAGE_DATA_URL_PATTERN.test(trimmed) ||
    getBase64PayloadByteLength(trimmed) > MAX_GAME_ICON_BYTES
  ) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
  return trimmed;
}

function getBase64PayloadByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function normalizeOptionalCoverImageDominantColorProperty(value: unknown): { coverImageDominantColor?: string } {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  const color = normalizeRequiredString(value);

  if (!COVER_IMAGE_DOMINANT_COLOR_PATTERN.test(color)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return { coverImageDominantColor: color.toUpperCase() };
}

function normalizeKeyCode(value: unknown): string {
  const code = normalizeRequiredString(value);

  if (code.length > MACRO_CODE_MAX_LENGTH || !/^[A-Za-z0-9]+$/.test(code)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return code;
}

function normalizeOptionalLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const label = value.trim();
  return label ? label.slice(0, MACRO_LABEL_MAX_LENGTH) : undefined;
}

function normalizePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Math.round(value * 100) / 100;
}

function normalizeMilliseconds(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MACRO_DELAY_MAX_MS) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Number(value);
}

function normalizeLoopInterval(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MACRO_DELAY_MAX_MS) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Number(value);
}

function normalizeUnit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return value;
}

function reserveUniqueName(name: string, usedNames: Set<string>): string {
  const normalizedName = name.trim();

  if (!usedNames.has(normalizeNameKey(normalizedName))) {
    usedNames.add(normalizeNameKey(normalizedName));
    return normalizedName;
  }

  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? " (Imported)" : ` (Imported ${index})`;
    const baseName = normalizedName.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).trim();
    const candidate = `${baseName}${suffix}`;
    const key = normalizeNameKey(candidate);

    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
  }

  throw new PortableDataError("PORTABLE_NAME_CONFLICT", "Unable to create a unique imported name.");
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function createRecoveredGameName(launchUrl: string): string {
  const url = new URL(launchUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return path && path !== "play" ? `${url.hostname} · ${path.slice(0, 32)}` : url.hostname;
}

function ensureUniqueIds(ids: string[]): void {
  const uniqueIds = new Set(ids);

  if (uniqueIds.size !== ids.length) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return value as Record<string, unknown>;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function roundRectValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
