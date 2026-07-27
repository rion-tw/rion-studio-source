import type {
  CreateGameInput,
  CreateRoleInput,
  Game,
  GameBrowserSettings,
  GameCompatibilityObservations,
  GameCompatibilityReport,
  LaunchWorkspace,
  Macro,
  MacroSettings,
  BulkDeleteResult,
  Role,
  UpdateGameInput,
  UpdateRoleInput,
  CreateLaunchWorkspaceInput,
  UpdateLaunchWorkspaceInput,
  CreateMacroInput,
  UpdateMacroInput,
  WorkspaceSlotBrowserZoomPercent
} from "../../src/shared/types";
import {
  createDefaultWorkspaceSlots,
  getDefaultWorkspaceBrowserZoomPercent
} from "../../src/shared/workspaceLayout";
import { normalizeGameBrowserSettings } from "../../src/shared/browserFonts";
import { normalizeMacroSettings } from "../../src/shared/macroSettings";
import type {
  CoreCommand,
  CoreCommandResult,
  CoreStateSnapshotRecord,
  RuntimeRestoreSessionRecord,
  RuntimeWindowPreferencesRecord
} from "../../src/shared/generated";

type CoreStateSnapshot = CoreStateSnapshotRecord;
type CoreStateKey = keyof CoreStateSnapshot;

export class MemoryStateRepository {
  constructor(private state: Partial<CoreStateSnapshot> = {}) {
    if (state.games === undefined) {
      const timestamp = "2026-01-01T00:00:00.000Z";
      state.games = [
        {
          id: "builtin-flyff-universe",
          source: "builtin",
          builtinKey: "flyff-universe",
          name: "Flyff Universe",
          defaultLaunchUrl: "https://universe.flyff.com/play",
          localStorageSyncKeys: ["game_client_settings"],
          createdAt: timestamp,
          updatedAt: timestamp
        },
        {
          id: "builtin-feifei-infinite-universe",
          source: "builtin",
          builtinKey: "feifei-infinite-universe",
          name: "飞飞：无限宇宙",
          defaultLaunchUrl: "https://ffcli.ruiwoo.cn/",
          localStorageSyncKeys: [],
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ];
    }
  }

  async read<K extends CoreStateKey>(
    key: K,
    fallback: CoreStateSnapshot[K]
  ): Promise<CoreStateSnapshot[K]> {
    return structuredClone(this.state[key] ?? fallback) as CoreStateSnapshot[K];
  }

  async replace<K extends CoreStateKey>(
    key: K,
    value: CoreStateSnapshot[K]
  ): Promise<CoreStateSnapshot[K]> {
    const normalized = key === "gameBrowserSettings"
      ? normalizeGameBrowserSettings(value)
      : key === "macroSettings"
        ? normalizeMacroSettings(value)
        : value;
    this.state[key] = structuredClone(normalized) as never;
    return structuredClone(normalized) as CoreStateSnapshot[K];
  }

  async replaceMany(values: Partial<CoreStateSnapshot>): Promise<void> {
    this.state = { ...this.state, ...structuredClone(values) };
  }

  async getGameBrowserSettings(): Promise<GameBrowserSettings> {
    return normalizeGameBrowserSettings(this.state.gameBrowserSettings);
  }

  replaceGameBrowserSettings(settings: GameBrowserSettings): Promise<GameBrowserSettings> {
    return this.replace("gameBrowserSettings", settings) as Promise<GameBrowserSettings>;
  }

  async getMacroSettings(): Promise<MacroSettings> {
    return normalizeMacroSettings(this.state.macroSettings);
  }

  replaceMacroSettings(settings: MacroSettings): Promise<MacroSettings> {
    return this.replace("macroSettings", settings) as Promise<MacroSettings>;
  }

  async getRuntimeWindowPreferences(): Promise<RuntimeWindowPreferencesRecord> {
    return structuredClone(this.state.runtimeWindowPreferences ?? {
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    });
  }

  replaceRuntimeWindowPreferences(
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<RuntimeWindowPreferencesRecord> {
    return this.replace(
      "runtimeWindowPreferences",
      preferences
    ) as Promise<RuntimeWindowPreferencesRecord>;
  }

  async getRuntimeRestoreSession(): Promise<RuntimeRestoreSessionRecord> {
    return structuredClone(this.state.runtimeRestoreSession ?? {
      schemaVersion: 2,
      sessionGeneration: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      cleanExit: true,
      restoreInProgressWindowIds: [],
      windows: []
    });
  }

  replaceRuntimeRestoreSession(
    session: RuntimeRestoreSessionRecord
  ): Promise<RuntimeRestoreSessionRecord> {
    return this.replace(
      "runtimeRestoreSession",
      session
    ) as Promise<RuntimeRestoreSessionRecord>;
  }

  async listGames(): Promise<Game[]> {
    return this.read("games", []);
  }

  async getGame(id: string): Promise<Game> {
    const game = (await this.listGames()).find((item) => item.id === id);
    if (!game) throw codedError("GAME_NOT_FOUND", "Game not found.");
    return game;
  }

  async createGame(input: CreateGameInput): Promise<Game> {
    const games = await this.listGames();
    const timestamp = new Date().toISOString();
    const game: Game = {
      id: crypto.randomUUID(),
      source: "custom",
      name: input.name.trim(),
      defaultLaunchUrl: new URL(input.defaultLaunchUrl).toString(),
      localStorageSyncKeys: input.localStorageSyncKeys,
      ...(typeof input.iconImageDataUrl === "string" && input.iconImageDataUrl
        ? { iconImageDataUrl: input.iconImageDataUrl }
        : {}),
      ...(typeof input.coverImageDataUrl === "string" && input.coverImageDataUrl
        ? { coverImageDataUrl: input.coverImageDataUrl }
        : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    games.push(game);
    await this.replace("games", games);
    return game;
  }

  async updateGame(id: string, input: UpdateGameInput): Promise<Game> {
    const games = await this.listGames();
    const index = games.findIndex((game) => game.id === id);
    if (index < 0) throw codedError("GAME_NOT_FOUND", "Game not found.");
    const current = games[index];
    const game: Game = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.defaultLaunchUrl === undefined ? {} : { defaultLaunchUrl: new URL(input.defaultLaunchUrl).toString() }),
      ...(input.iconImageDataUrl === undefined
        ? {}
        : input.iconImageDataUrl
          ? { iconImageDataUrl: input.iconImageDataUrl }
          : { iconImageDataUrl: undefined }),
      ...(input.coverImageDataUrl === undefined
        ? {}
        : input.coverImageDataUrl
          ? { coverImageDataUrl: input.coverImageDataUrl }
          : { coverImageDataUrl: undefined }),
      ...(input.localStorageSyncKeys === undefined
        ? {}
        : { localStorageSyncKeys: input.localStorageSyncKeys }),
      updatedAt: new Date().toISOString()
    };
    games[index] = game;
    await this.replace("games", games);
    return game;
  }

  async resetBuiltinGame(id: string): Promise<Game> {
    return this.getGame(id);
  }

  async deleteGame(id: string): Promise<void> {
    const games = await this.listGames();
    if (!games.some((game) => game.id === id)) throw codedError("GAME_NOT_FOUND", "Game not found.");
    await this.replace("games", games.filter((game) => game.id !== id));
  }

  async deleteGames(ids: string[]): Promise<BulkDeleteResult> {
    return this.deleteMany(ids, () => this.listGames(), (id) => this.deleteGame(id));
  }

  async listRoles(): Promise<Role[]> {
    return this.read("roles", []);
  }

  async getRole(id: string): Promise<Role> {
    const role = (await this.listRoles()).find((item) => item.id === id);
    if (!role) throw codedError("ROLE_NOT_FOUND", "Role not found.");
    return role;
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    const roles = await this.listRoles();
    const timestamp = new Date().toISOString();
    const role: Role = {
      id: crypto.randomUUID(),
      gameId: input.gameId.trim(),
      name: input.name.trim(),
      launchUrl: new URL(input.launchUrl ?? "https://universe.flyff.com/play").toString(),
      notes: input.notes?.trim() ?? "",
      ...(typeof input.coverImageDataUrl === "string" && input.coverImageDataUrl
        ? { coverImageDataUrl: input.coverImageDataUrl }
        : {}),
      ...(typeof input.coverImageDominantColor === "string" && input.coverImageDominantColor
        ? { coverImageDominantColor: input.coverImageDominantColor }
        : {}),
      ...(typeof input.localStorageSourceRoleId === "string"
        ? { localStorageSourceRoleId: input.localStorageSourceRoleId }
        : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    roles.push(role);
    await this.replace("roles", roles);
    return role;
  }

  async updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    const roles = await this.listRoles();
    const index = roles.findIndex((role) => role.id === id);
    if (index < 0) throw codedError("ROLE_NOT_FOUND", "Role not found.");
    const role: Role = {
      ...roles[index],
      ...(input.gameId === undefined ? {} : { gameId: input.gameId.trim() }),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.launchUrl === undefined ? {} : { launchUrl: new URL(input.launchUrl).toString() }),
      ...(input.notes === undefined ? {} : { notes: input.notes.trim() }),
      ...(input.localStorageSourceRoleId === undefined
        ? {}
        : { localStorageSourceRoleId: input.localStorageSourceRoleId ?? undefined }),
      updatedAt: new Date().toISOString()
    };
    roles[index] = role;
    await this.replace("roles", roles);
    return role;
  }

  async reorderRoles(orderedIds: string[]): Promise<Role[]> {
    const roles = await this.listRoles();
    const byId = new Map(roles.map((role) => [role.id, role]));
    const ordered = orderedIds.map((id) => byId.get(id)).filter((role): role is Role => Boolean(role));
    await this.replace("roles", ordered);
    return ordered;
  }

  async deleteRole(id: string): Promise<void> {
    const roles = await this.listRoles();
    if (!roles.some((role) => role.id === id)) throw codedError("ROLE_NOT_FOUND", "Role not found.");
    await this.replace("roles", roles.filter((role) => role.id !== id));
  }

  async deleteRoles(ids: string[]): Promise<BulkDeleteResult> {
    return this.deleteMany(ids, () => this.listRoles(), (id) => this.deleteRole(id));
  }

  async assignRoleGameIds(assignments: ReadonlyMap<string, string>): Promise<Role[]> {
    const roles = (await this.listRoles()).map((role) => ({
      ...role,
      gameId: assignments.get(role.id) ?? role.gameId
    }));
    await this.replace("roles", roles);
    return roles;
  }

  listWorkspaces(): Promise<LaunchWorkspace[]> {
    return this.read("launchWorkspaces", []);
  }

  async getWorkspace(id: string): Promise<LaunchWorkspace> {
    const workspace = (await this.listWorkspaces()).find((item) => item.id === id);
    if (!workspace) throw codedError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
    return workspace;
  }

  async createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    const workspaces = await this.listWorkspaces();
    const template = input.template ?? "two_columns";
    const timestamp = new Date().toISOString();
    const defaults = createDefaultWorkspaceSlots(template);
    const workspace: LaunchWorkspace = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      template,
      browserZoomMode: input.browserZoomMode ?? "adaptive",
      browserZoomPercent: input.browserZoomPercent ?? getDefaultWorkspaceBrowserZoomPercent(template),
      slots: defaults.map((slot, index) => ({ ...slot, ...structuredClone(input.slots?.[index] ?? {}) })),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    workspaces.push(structuredClone(workspace));
    await this.replace("launchWorkspaces", workspaces);
    return workspace;
  }

  async updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    const workspaces = await this.listWorkspaces();
    const index = workspaces.findIndex((item) => item.id === id);
    if (index < 0) throw codedError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
    const current = workspaces[index];
    const workspace: LaunchWorkspace = {
      ...current,
      ...structuredClone(input),
      updatedAt: new Date().toISOString()
    } as LaunchWorkspace;
    workspaces[index] = structuredClone(workspace);
    await this.replace("launchWorkspaces", workspaces);
    return workspace;
  }

  async reorderWorkspaces(orderedIds: string[]): Promise<LaunchWorkspace[]> {
    const workspaces = await this.listWorkspaces();
    const byId = new Map(workspaces.map((item) => [item.id, item]));
    const ordered = orderedIds.map((id) => byId.get(id)).filter((item): item is LaunchWorkspace => Boolean(item));
    await this.replace("launchWorkspaces", ordered);
    return ordered;
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.replace("launchWorkspaces", (await this.listWorkspaces()).filter((item) => item.id !== id));
  }

  async deleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
    return this.deleteMany(
      ids,
      () => this.listWorkspaces(),
      (id) => this.deleteWorkspace(id)
    );
  }

  async clearWorkspaceRole(roleId: string): Promise<void> {
    const workspaces = (await this.listWorkspaces()).map((workspace) => ({
      ...workspace,
      slots: workspace.slots.map((slot) => {
        if (slot.roleId !== roleId) return slot;
        const { roleId: _roleId, ...remaining } = slot;
        return remaining;
      })
    }));
    await this.replace("launchWorkspaces", workspaces);
  }

  async setWorkspaceRoleBrowserZoom(
    workspaceId: string,
    roleId: string,
    browserZoomPercent: WorkspaceSlotBrowserZoomPercent
  ): Promise<LaunchWorkspace | undefined> {
    const workspaces = await this.listWorkspaces();
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const slot = workspace?.slots.find((item) => item.roleId === roleId);
    if (!workspace || !slot) return undefined;
    slot.browserZoomPercent = browserZoomPercent;
    await this.replace("launchWorkspaces", workspaces);
    return workspace;
  }

  listMacros(): Promise<Macro[]> {
    return this.read("macros", []);
  }

  async getMacro(id: string): Promise<Macro> {
    const macro = (await this.listMacros()).find((item) => item.id === id);
    if (!macro) throw codedError("MACRO_NOT_FOUND", "Macro not found.");
    return macro;
  }

  async createMacro(input: CreateMacroInput): Promise<Macro> {
    const macros = await this.listMacros();
    const timestamp = new Date().toISOString();
    const macro: Macro = {
      id: crypto.randomUUID(),
      enabled: input.enabled ?? true,
      activationMode: input.activationMode ?? "toggle",
      name: input.name.trim(),
      roleIds: [...input.roleIds],
      ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
      repeat: structuredClone(input.repeat ?? { type: "once" }),
      steps: structuredClone(input.steps),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    macros.push(structuredClone(macro));
    await this.replace("macros", macros);
    return macro;
  }

  async updateMacro(id: string, input: UpdateMacroInput): Promise<Macro> {
    const macros = await this.listMacros();
    const index = macros.findIndex((item) => item.id === id);
    if (index < 0) throw codedError("MACRO_NOT_FOUND", "Macro not found.");
    const macro = {
      ...macros[index],
      ...structuredClone(input),
      ...(input.trigger === null ? { trigger: undefined } : {}),
      updatedAt: new Date().toISOString()
    } as Macro;
    macros[index] = structuredClone(macro);
    await this.replace("macros", macros);
    return macro;
  }

  async deleteMacro(id: string): Promise<void> {
    await this.replace("macros", (await this.listMacros()).filter((item) => item.id !== id));
  }

  async deleteMacros(ids: string[]): Promise<BulkDeleteResult> {
    const existing = new Set((await this.listMacros()).map((item) => item.id));
    const deletedIds = [...new Set(ids)].filter((id) => existing.has(id));
    await this.replace("macros", (await this.listMacros()).filter((item) => !deletedIds.includes(item.id)));
    return { deletedIds, skipped: [...new Set(ids)].filter((id) => !existing.has(id)).map((id) => ({ id, reason: "not_found" })) };
  }

  async clearMacroRole(roleId: string): Promise<void> {
    await this.replace("macros", (await this.listMacros()).map((macro) => ({
      ...macro,
      roleIds: macro.roleIds.filter((id) => id !== roleId)
    })));
  }

  async invoke<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
    let result: unknown;
    switch (command.type) {
      case "gamesList":
        result = await this.listGames();
        break;
      case "gameGet":
        result = await this.getGame(command.id);
        break;
      case "gameCreate":
        result = await this.createGame(command.input as CreateGameInput);
        break;
      case "gameUpdate":
        result = await this.updateGame(command.id, command.input as UpdateGameInput);
        break;
      case "gameResetBuiltin":
        result = await this.resetBuiltinGame(command.id);
        break;
      case "gameDelete":
        await this.deleteGame(command.id);
        result = null;
        break;
      case "gamesDelete":
        result = await this.deleteGames(command.ids);
        break;
      case "rolesList":
        result = await this.listRoles();
        break;
      case "roleGet":
        result = await this.getRole(command.id);
        break;
      case "roleCreate":
        result = await this.createRole(command.input as CreateRoleInput);
        break;
      case "roleUpdate":
        result = await this.updateRole(command.id, command.input as UpdateRoleInput);
        break;
      case "roleReorder":
        result = await this.reorderRoles(command.orderedIds);
        break;
      case "roleDelete":
        await this.deleteRole(command.id);
        result = null;
        break;
      case "rolesDelete":
        result = await this.deleteRoles(command.ids);
        break;
      case "roleAssignGameIds":
        result = await this.assignRoleGameIds(new Map(
          command.assignments.map(({ roleId, gameId }) => [roleId, gameId])
        ));
        break;
      case "workspacesList":
        result = await this.listWorkspaces();
        break;
      case "workspaceGet":
        result = await this.getWorkspace(command.id);
        break;
      case "workspaceCreate":
        result = await this.createWorkspace(command.input as CreateLaunchWorkspaceInput);
        break;
      case "workspaceUpdate":
        result = await this.updateWorkspace(command.id, command.input as UpdateLaunchWorkspaceInput);
        break;
      case "workspaceReorder":
        result = await this.reorderWorkspaces(command.orderedIds);
        break;
      case "workspaceDelete":
        await this.deleteWorkspace(command.id);
        result = null;
        break;
      case "workspacesDelete":
        result = await this.deleteWorkspaces(command.ids);
        break;
      case "workspaceClearRole":
        await this.clearWorkspaceRole(command.roleId);
        result = null;
        break;
      case "workspaceSetRoleBrowserZoom":
        result = await this.setWorkspaceRoleBrowserZoom(
          command.workspaceId,
          command.roleId,
          command.browserZoomPercent
        ) ?? null;
        break;
      case "macrosList":
        result = await this.listMacros();
        break;
      case "macroGet":
        result = await this.getMacro(command.id);
        break;
      case "macroCreate":
        result = await this.createMacro(command.input as CreateMacroInput);
        break;
      case "macroUpdate":
        result = await this.updateMacro(command.id, command.input as UpdateMacroInput);
        break;
      case "macroDelete":
        await this.deleteMacro(command.id);
        result = null;
        break;
      case "macrosDelete":
        result = await this.deleteMacros(command.ids);
        break;
      case "macrosClearRole":
        await this.clearMacroRole(command.roleId);
        result = null;
        break;
      case "gameBrowserSettingsGet":
        result = await this.getGameBrowserSettings();
        break;
      case "gameBrowserSettingsReplace":
        result = await this.replaceGameBrowserSettings(command.settings);
        break;
      case "macroSettingsGet":
        result = await this.getMacroSettings();
        break;
      case "macroSettingsReplace":
        result = await this.replaceMacroSettings(command.settings);
        break;
      case "runtimeWindowPreferencesGet":
        result = await this.getRuntimeWindowPreferences();
        break;
      case "runtimeWindowPreferencesReplace":
        result = await this.replaceRuntimeWindowPreferences(command.preferences);
        break;
      case "runtimeRestoreSessionGet":
        result = await this.getRuntimeRestoreSession();
        break;
      case "runtimeRestoreSessionReplace":
        result = await this.replaceRuntimeRestoreSession(command.session);
        break;
      default:
        throw new Error(`Unsupported memory core command: ${command.type}`);
    }
    return result as CoreCommandResult<C>;
  }

  private async deleteMany(
    ids: string[],
    list: () => Promise<Array<{ id: string }>>,
    remove: (id: string) => Promise<void>
  ): Promise<BulkDeleteResult> {
    const normalized = [...new Set(ids)];
    const existing = new Set((await list()).map((item) => item.id));
    const deletedIds = normalized.filter((id) => existing.has(id));
    for (const id of deletedIds) await remove(id);
    return {
      deletedIds,
      skipped: normalized
        .filter((id) => !existing.has(id))
        .map((id) => ({ id, reason: "not_found" }))
    };
  }

  listCompatibilityReports(): Promise<GameCompatibilityReport[]> {
    return this.read("compatibilityReports", []);
  }

  async saveCompatibilityReport(report: GameCompatibilityReport): Promise<GameCompatibilityReport> {
    const reports = await this.listCompatibilityReports();
    const index = reports.findIndex((item) => item.gameId === report.gameId);
    if (index < 0) reports.push(structuredClone(report));
    else reports[index] = structuredClone(report);
    await this.replace("compatibilityReports", reports);
    return structuredClone(report);
  }

  async recordCompatibilityObservation(
    gameId: string,
    observation: Partial<GameCompatibilityObservations>
  ): Promise<GameCompatibilityReport> {
    const current = (await this.listCompatibilityReports()).find((item) => item.gameId === gameId);
    return this.saveCompatibilityReport({
      ...(current ?? { gameId, isStale: false }),
      observations: { ...(current?.observations ?? {}), ...observation }
    });
  }

  async deleteCompatibilityReport(gameId: string): Promise<void> {
    await this.replace(
      "compatibilityReports",
      (await this.listCompatibilityReports()).filter((report) => report.gameId !== gameId)
    );
  }
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
