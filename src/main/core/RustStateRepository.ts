import type {
  Game,
  GameBrowserSettings,
  LaunchWorkspace,
  Macro,
  MacroSettings,
  Role,
  CreateGameInput,
  UpdateGameInput,
  CreateRoleInput,
  UpdateRoleInput,
  RoleBrowserSessionSource,
  BulkDeleteResult,
  CreateLaunchWorkspaceInput,
  UpdateLaunchWorkspaceInput,
  CreateMacroInput,
  UpdateMacroInput,
  WorkspaceDisplayInfo,
  WorkspaceSlotBrowserZoomPercent
} from "../../shared/types";
import type {
  CoreStateSnapshotRecord,
  RuntimeWindowPreferencesRecord,
  MacroCreateInputRecord,
  MacroUpdateInputRecord,
  WorkspaceCreateInputRecord,
  WorkspaceUpdateInputRecord,
  WorkspaceDisplayInfoRecord,
} from "../../shared/generated";
import type { AppCoreClient } from "./nativeCore";

export type CoreStateSnapshot = CoreStateSnapshotRecord;

export type CoreStateKey = keyof CoreStateSnapshot;

export interface StateRepository {
  getGameBrowserSettings(): Promise<GameBrowserSettings>;
  replaceGameBrowserSettings(settings: GameBrowserSettings): Promise<GameBrowserSettings>;
  getMacroSettings(): Promise<MacroSettings>;
  replaceMacroSettings(settings: MacroSettings): Promise<MacroSettings>;
  getRuntimeWindowPreferences(): Promise<RuntimeWindowPreferencesRecord>;
  replaceRuntimeWindowPreferences(
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<RuntimeWindowPreferencesRecord>;
  listGames(): Promise<Game[]>;
  getGame(id: string): Promise<Game>;
  createGame(input: CreateGameInput): Promise<Game>;
  updateGame(id: string, input: UpdateGameInput): Promise<Game>;
  resetBuiltinGame(id: string): Promise<Game>;
  deleteGame(id: string): Promise<void>;
  deleteGames(ids: string[]): Promise<BulkDeleteResult>;
  listRoles(): Promise<Role[]>;
  getRole(id: string): Promise<Role>;
  createRole(input: CreateRoleInput): Promise<Role>;
  updateRole(id: string, input: UpdateRoleInput): Promise<Role>;
  reorderRoles(orderedIds: string[]): Promise<Role[]>;
  deleteRole(id: string): Promise<void>;
  deleteRoles(ids: string[]): Promise<BulkDeleteResult>;
  setRoleBrowserSessionSource(id: string, source: RoleBrowserSessionSource): Promise<Role>;
  assignRoleGameIds(assignments: ReadonlyMap<string, string>): Promise<Role[]>;
  listWorkspaces(): Promise<LaunchWorkspace[]>;
  getWorkspace(id: string): Promise<LaunchWorkspace>;
  createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace>;
  updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace>;
  reorderWorkspaces(orderedIds: string[]): Promise<LaunchWorkspace[]>;
  deleteWorkspace(id: string): Promise<void>;
  deleteWorkspaces(ids: string[]): Promise<BulkDeleteResult>;
  clearWorkspaceRole(roleId: string): Promise<void>;
  setWorkspaceRoleBrowserZoom(
    workspaceId: string,
    roleId: string,
    browserZoomPercent: WorkspaceSlotBrowserZoomPercent
  ): Promise<LaunchWorkspace | undefined>;
  reconcileWorkspaceDisplays(displays: WorkspaceDisplayInfo[]): Promise<LaunchWorkspace[]>;
  listMacros(): Promise<Macro[]>;
  getMacro(id: string): Promise<Macro>;
  createMacro(input: CreateMacroInput): Promise<Macro>;
  updateMacro(id: string, input: UpdateMacroInput): Promise<Macro>;
  deleteMacro(id: string): Promise<void>;
  deleteMacros(ids: string[]): Promise<BulkDeleteResult>;
  clearMacroRole(roleId: string): Promise<void>;
}

export class RustStateRepository implements StateRepository {
  constructor(private readonly core: AppCoreClient) {}

  getGameBrowserSettings(): Promise<GameBrowserSettings> {
    return this.core.invoke<GameBrowserSettings>({ type: "gameBrowserSettingsGet" });
  }

  replaceGameBrowserSettings(settings: GameBrowserSettings): Promise<GameBrowserSettings> {
    return this.core.invoke<GameBrowserSettings>({ type: "gameBrowserSettingsReplace", settings });
  }

  getMacroSettings(): Promise<MacroSettings> {
    return this.core.invoke<MacroSettings>({ type: "macroSettingsGet" });
  }

  replaceMacroSettings(settings: MacroSettings): Promise<MacroSettings> {
    return this.core.invoke<MacroSettings>({ type: "macroSettingsReplace", settings });
  }

  getRuntimeWindowPreferences(): Promise<RuntimeWindowPreferencesRecord> {
    return this.core.invoke<RuntimeWindowPreferencesRecord>({ type: "runtimeWindowPreferencesGet" });
  }

  replaceRuntimeWindowPreferences(
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<RuntimeWindowPreferencesRecord> {
    return this.core.invoke<RuntimeWindowPreferencesRecord>({
      type: "runtimeWindowPreferencesReplace",
      preferences
    });
  }

  listGames(): Promise<Game[]> {
    return this.core.invoke<Game[]>({ type: "gamesList" });
  }

  getGame(id: string): Promise<Game> {
    return this.core.invoke<Game>({ type: "gameGet", id });
  }

  createGame(input: CreateGameInput): Promise<Game> {
    return this.core.invoke<Game>({
      type: "gameCreate",
      input: {
        name: input.name,
        defaultLaunchUrl: input.defaultLaunchUrl,
        ...(typeof input.iconImageDataUrl === "string" ? { iconImageDataUrl: input.iconImageDataUrl } : {}),
        ...(typeof input.coverImageDataUrl === "string" ? { coverImageDataUrl: input.coverImageDataUrl } : {}),
        ...(input.browserLaunchMode === undefined ? {} : { browserLaunchMode: input.browserLaunchMode })
      }
    });
  }

  updateGame(id: string, input: UpdateGameInput): Promise<Game> {
    return this.core.invoke<Game>({
      type: "gameUpdate",
      id,
      input: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.defaultLaunchUrl === undefined ? {} : { defaultLaunchUrl: input.defaultLaunchUrl }),
        ...(typeof input.iconImageDataUrl === "string" ? { iconImageDataUrl: input.iconImageDataUrl } : {}),
        setIconImageDataUrl: input.iconImageDataUrl !== undefined,
        ...(typeof input.coverImageDataUrl === "string" ? { coverImageDataUrl: input.coverImageDataUrl } : {}),
        setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
        ...(input.browserLaunchMode === undefined ? {} : { browserLaunchMode: input.browserLaunchMode })
      }
    });
  }

  resetBuiltinGame(id: string): Promise<Game> {
    return this.core.invoke<Game>({ type: "gameResetBuiltin", id });
  }

  deleteGame(id: string): Promise<void> {
    return this.core.invoke({ type: "gameDelete", id }).then(() => undefined);
  }

  deleteGames(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke<BulkDeleteResult>({ type: "gamesDelete", ids });
  }

  listRoles(): Promise<Role[]> {
    return this.core.invoke<Role[]>({ type: "rolesList" });
  }

  getRole(id: string): Promise<Role> {
    return this.core.invoke<Role>({ type: "roleGet", id });
  }

  createRole(input: CreateRoleInput): Promise<Role> {
    return this.core.invoke<Role>({
      type: "roleCreate",
      input: {
        gameId: input.gameId,
        name: input.name,
        ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(typeof input.coverImageDataUrl === "string" ? { coverImageDataUrl: input.coverImageDataUrl } : {}),
        ...(typeof input.coverImageDominantColor === "string" ? { coverImageDominantColor: input.coverImageDominantColor } : {})
      }
    });
  }

  updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    return this.core.invoke<Role>({
      type: "roleUpdate",
      id,
      input: {
        ...(input.gameId === undefined ? {} : { gameId: input.gameId }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(typeof input.coverImageDataUrl === "string" ? { coverImageDataUrl: input.coverImageDataUrl } : {}),
        setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
        ...(typeof input.coverImageDominantColor === "string" ? { coverImageDominantColor: input.coverImageDominantColor } : {}),
        setCoverImageDominantColor: input.coverImageDominantColor !== undefined
      }
    });
  }

  reorderRoles(orderedIds: string[]): Promise<Role[]> {
    return this.core.invoke<Role[]>({ type: "roleReorder", orderedIds });
  }

  deleteRole(id: string): Promise<void> {
    return this.core.invoke({ type: "roleDelete", id }).then(() => undefined);
  }

  deleteRoles(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke<BulkDeleteResult>({ type: "rolesDelete", ids });
  }

  setRoleBrowserSessionSource(id: string, source: RoleBrowserSessionSource): Promise<Role> {
    return this.core.invoke<Role>({ type: "roleSetBrowserSessionSource", id, source });
  }

  assignRoleGameIds(assignments: ReadonlyMap<string, string>): Promise<Role[]> {
    return this.core.invoke<Role[]>({
      type: "roleAssignGameIds",
      assignments: [...assignments].map(([roleId, gameId]) => ({ roleId, gameId }))
    });
  }

  listWorkspaces(): Promise<LaunchWorkspace[]> {
    return this.core.invoke<LaunchWorkspace[]>({ type: "workspacesList" });
  }

  getWorkspace(id: string): Promise<LaunchWorkspace> {
    return this.core.invoke<LaunchWorkspace>({ type: "workspaceGet", id });
  }

  createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.core.invoke<LaunchWorkspace>({
      type: "workspaceCreate",
      input: toWorkspaceCreateInput(input)
    });
  }

  updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.core.invoke<LaunchWorkspace>({
      type: "workspaceUpdate",
      id,
      input: toWorkspaceUpdateInput(input)
    });
  }

  reorderWorkspaces(orderedIds: string[]): Promise<LaunchWorkspace[]> {
    return this.core.invoke<LaunchWorkspace[]>({
      type: "workspaceReorder",
      orderedIds
    });
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.core.invoke({ type: "workspaceDelete", id }).then(() => undefined);
  }

  deleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke<BulkDeleteResult>({ type: "workspacesDelete", ids });
  }

  clearWorkspaceRole(roleId: string): Promise<void> {
    return this.core.invoke({ type: "workspaceClearRole", roleId }).then(() => undefined);
  }

  setWorkspaceRoleBrowserZoom(
    workspaceId: string,
    roleId: string,
    browserZoomPercent: WorkspaceSlotBrowserZoomPercent
  ): Promise<LaunchWorkspace | undefined> {
    return this.core.invoke<LaunchWorkspace | null>({
      type: "workspaceSetRoleBrowserZoom",
      workspaceId,
      roleId,
      browserZoomPercent
    }).then((workspace) => workspace ?? undefined);
  }

  reconcileWorkspaceDisplays(displays: WorkspaceDisplayInfo[]): Promise<LaunchWorkspace[]> {
    return this.core.invoke<LaunchWorkspace[]>({
      type: "workspaceReconcileDisplays",
      displays: displays.map((display): WorkspaceDisplayInfoRecord => ({
        id: display.id,
        label: display.label,
        bounds: { ...display.bounds },
        resolution: { ...display.resolution },
        scaleFactor: display.scaleFactor,
        isPrimary: display.isPrimary,
        isInternal: display.isInternal
      }))
    });
  }

  listMacros(): Promise<Macro[]> {
    return this.core.invoke<Macro[]>({ type: "macrosList" });
  }

  getMacro(id: string): Promise<Macro> {
    return this.core.invoke<Macro>({ type: "macroGet", id });
  }

  createMacro(input: CreateMacroInput): Promise<Macro> {
    return this.core.invoke<Macro>({
      type: "macroCreate",
      input: toMacroCreateInput(input)
    });
  }

  updateMacro(id: string, input: UpdateMacroInput): Promise<Macro> {
    return this.core.invoke<Macro>({
      type: "macroUpdate",
      id,
      input: toMacroUpdateInput(input)
    });
  }

  deleteMacro(id: string): Promise<void> {
    return this.core.invoke({ type: "macroDelete", id }).then(() => undefined);
  }

  deleteMacros(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke<BulkDeleteResult>({ type: "macrosDelete", ids });
  }

  clearMacroRole(roleId: string): Promise<void> {
    return this.core.invoke({ type: "macrosClearRole", roleId }).then(() => undefined);
  }
}

function toWorkspaceCreateInput(input: CreateLaunchWorkspaceInput): WorkspaceCreateInputRecord {
  return {
    name: input.name,
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.browserLaunchMode === undefined ? {} : { browserLaunchMode: input.browserLaunchMode }),
    ...(input.browserZoomMode === undefined ? {} : { browserZoomMode: input.browserZoomMode }),
    ...(input.browserZoomPercent === undefined ? {} : { browserZoomPercent: input.browserZoomPercent }),
    ...(input.resourcePolicy === undefined ? {} : { resourcePolicy: structuredClone(input.resourcePolicy) }),
    ...(input.targetDisplay && { targetDisplay: structuredClone(input.targetDisplay) }),
    ...(input.slots === undefined ? {} : { slots: structuredClone(input.slots) })
  } as WorkspaceCreateInputRecord;
}

function toWorkspaceUpdateInput(input: UpdateLaunchWorkspaceInput): WorkspaceUpdateInputRecord {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.browserLaunchMode === undefined ? {} : { browserLaunchMode: input.browserLaunchMode }),
    ...(input.browserZoomMode === undefined ? {} : { browserZoomMode: input.browserZoomMode }),
    ...(input.browserZoomPercent === undefined ? {} : { browserZoomPercent: input.browserZoomPercent }),
    ...(input.resourcePolicy === undefined ? {} : { resourcePolicy: structuredClone(input.resourcePolicy) }),
    setTargetDisplay: input.targetDisplay !== undefined,
    ...(input.targetDisplay && { targetDisplay: structuredClone(input.targetDisplay) }),
    ...(input.slots === undefined ? {} : { slots: structuredClone(input.slots) })
  } as WorkspaceUpdateInputRecord;
}

function toMacroCreateInput(input: CreateMacroInput): MacroCreateInputRecord {
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
    name: input.name,
    roleIds: [...input.roleIds],
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    ...(input.repeat === undefined ? {} : { repeat: structuredClone(input.repeat) }),
    steps: structuredClone(input.steps)
  } as MacroCreateInputRecord;
}

function toMacroUpdateInput(input: UpdateMacroInput): MacroUpdateInputRecord {
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.roleIds === undefined ? {} : { roleIds: [...input.roleIds] }),
    setTrigger: input.trigger !== undefined,
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    ...(input.repeat === undefined ? {} : { repeat: structuredClone(input.repeat) }),
    ...(input.steps === undefined ? {} : { steps: structuredClone(input.steps) })
  } as MacroUpdateInputRecord;
}
