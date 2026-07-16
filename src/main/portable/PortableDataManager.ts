import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeGameBrowserSettings } from "../../shared/browserFonts";
import { BUILTIN_GAME_DEFINITIONS } from "../../shared/games";
import {
  areMacroTriggersEqual,
  macroRoleAssignmentsOverlap,
  MACRO_OVERLAY_TRIGGER
} from "../../shared/macroShortcuts";
import { findMacroDependencyIssue, macroDependsOn } from "../../shared/macroDependencies";
import { MacroMutationBusyError } from "../macros/MacroManager";
import type { MacroStore } from "../macros/MacroStore";
import type { GameStore } from "../games/GameStore";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import type { RoleStore } from "../roles/RoleStore";
import {
  LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
  migrateWorkspaceResourcePolicyToAdaptive,
  type LaunchWorkspaceStore
} from "../workspaces/LaunchWorkspaceStore";
import {
  DEFAULT_LAUNCH_URL,
  DEFAULT_ROLE_WINDOW_HEIGHT,
  DEFAULT_ROLE_WINDOW_WIDTH,
  type GameBrowserSettings,
  type Game,
  type InheritableBrowserLaunchMode,
  type LaunchWorkspace,
  type Macro,
  type MacroRepeat,
  type MacroStep,
  type MacroTrigger,
  type PortableDataSelection,
  type PortableExportInput,
  type PortableExportResult,
  type PortableImportInput,
  type PortableImportOperations,
  type PortableImportOperationSummary,
  type PortableImportPreview,
  type PortableImportResult,
  type PortableImportWarning,
  type PortableLaunchWorkspace,
  type PortableGame,
  type PortableMacro,
  type PortablePreferences,
  type PortableMacroConflict,
  type PortableMacroConflictResolution,
  type PortableRole,
  type RionPortableDataV3,
  type Role,
  type RoleDefaults,
  type WorkspaceResourcePolicy
} from "../../shared/types";
import {
  DEFAULT_WORKSPACE_RESOURCE_POLICY,
  getDefaultWorkspaceRects,
  getWorkspaceTemplateSlotCount,
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
  gameBrowserSettingsStore?: Pick<
    GameBrowserSettingsStore,
    "getSettings" | "publishSettingsForImport" | "updateSettings"
  >;
  gameStore: Pick<GameStore, "listGames" | "publishGamesForImport" | "replaceGamesForImport">;
  now?: () => Date;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  roleStore: Pick<
    RoleStore,
    "getUserDataDir" | "listRoles" | "publishRolesForImport" | "replaceRolesForImport"
  >;
  showOpenDialog: (options: PortableOpenDialogOptions) => Promise<PortableOpenDialogResult>;
  showSaveDialog: (options: PortableSaveDialogOptions) => Promise<PortableSaveDialogResult>;
  userDataDir?: string;
  workspaceStore: Pick<
    LaunchWorkspaceStore,
    "listWorkspaces" | "publishWorkspacesForImport" | "replaceWorkspacesForImport"
  >;
  macroStore: Pick<MacroStore, "listMacros" | "publishMacrosForImport" | "replaceMacrosForImport">;
  withDataMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  withStoppedMacros?: <T>(macroIds: string[], operation: () => Promise<T>) => Promise<T>;
  writeTextFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

interface ImportPlan {
  affectedMacroIds: string[];
  conflicts: PortableMacroConflict[];
  createdRoleIds: string[];
  finalGames: Game[];
  finalMacros: Macro[];
  finalRoles: Role[];
  finalWorkspaces: LaunchWorkspace[];
  operations: PortableImportOperations;
  warnings: PortableImportWarning[];
}

interface PlannedPortableMacro {
  destinationId: string;
  existing?: Macro;
  macro: PortableMacro;
  name: string;
  roleIds: string[];
}

interface PendingImport {
  data: RionPortableDataV3;
  filePath: string;
}

interface PortableImportJournal {
  createdRoleIds: string[];
  games: Game[];
  gameBrowserSettings?: GameBrowserSettings;
  macros: Macro[];
  phase?: "committed" | "prepared";
  roles: Role[];
  targetGames?: Game[];
  targetGameBrowserSettings?: GameBrowserSettings;
  targetMacros?: Macro[];
  targetRoles?: Role[];
  targetWorkspaces?: LaunchWorkspace[];
  workspaceFileSchemaVersion?: number;
  workspaces: LaunchWorkspace[];
}

const PORTABLE_APP_NAME = "Rion Studio";
const PORTABLE_SCHEMA_VERSION = 3;
const PORTABLE_IMPORT_JOURNAL_FILE = "portable-import-transaction.json";
const PORTABLE_IMPORT_STAGE_DIRECTORY = "portable-import-transaction.stage";
const MAX_COVER_IMAGE_DATA_URL_LENGTH = 1_500_000;
const MAX_GAME_IMAGE_BYTES = 1_500_000;
const MAX_GAME_IMAGE_DATA_URL_LENGTH = 2_000_128;
const MAX_LAUNCH_URL_LENGTH = 2_048;
const MAX_NAME_LENGTH = 80;
const MACRO_STEPS_MAX_LENGTH = 100;
const MACRO_DELAY_MAX_MS = 600_000;
const MACRO_CODE_MAX_LENGTH = 48;
const MACRO_LABEL_MAX_LENGTH = 48;
const COVER_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const COVER_IMAGE_DOMINANT_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const GENERATED_ROLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  private readonly applyQueue = new SerialTaskQueue();
  private readonly createImportId: () => string;
  private readonly now: () => Date;
  private pendingImport: (PendingImport & { importId: string }) | undefined;
  private readonly readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly userDataDir: string;
  private readonly writeTextFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

  constructor(private readonly options: PortableDataManagerOptions) {
    this.createImportId = options.createImportId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.readTextFile = options.readTextFile ?? readFile;
    this.userDataDir = options.userDataDir ?? options.roleStore.getUserDataDir();
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

    this.pendingImport = undefined;
    const filePath = dialogResult.filePaths[0];
    const data = parsePortableData(await this.readTextFile(filePath, "utf8"));
    const plan = await this.buildImportPlan(data, []);
    const importId = this.createImportId();

    this.pendingImport = { data, filePath, importId };

    return {
      importId,
      filePath,
      exportedAt: data.exportedAt,
      appVersion: data.appVersion,
      gameCount: getProcessedImportCount(plan.operations.games),
      roleCount: getProcessedImportCount(plan.operations.roles),
      workspaceCount: getProcessedImportCount(plan.operations.launchWorkspaces),
      macroCount: getProcessedImportCount(plan.operations.macros),
      preferences: data.preferences,
      operations: plan.operations,
      conflicts: plan.conflicts,
      warnings: plan.warnings
    };
  }

  async applyImport(input: PortableImportInput): Promise<PortableImportResult> {
    return this.applyQueue.run(() => this.runDataMutation(async () => {
      const selection = normalizePortableDataSelection(input?.selection, false);
      const pendingImport = this.pendingImport;

      if (!pendingImport || pendingImport.importId !== input?.importId) {
        throw new PortableDataError(
          "PORTABLE_IMPORT_EXPIRED",
          "Portable import session expired. Choose the JSON file again."
        );
      }

      const selectedData = selectPortableData(pendingImport.data, selection);
      ensurePortableContentSelected(selectedData);
      const plan = await this.buildImportPlan(
        selectedData,
        normalizePortableMacroConflictResolutions(input.resolutions)
      );
      if (plan.conflicts.length > 0) {
        throw new PortableDataError(
          "PORTABLE_IMPORT_CONFLICT_UNRESOLVED",
          "Resolve every ambiguous macro before importing."
        );
      }

      const commit = () => this.commitImport(plan, selectedData.preferences?.gameBrowserSettings);
      if (this.options.withStoppedMacros && plan.affectedMacroIds.length > 0) {
        try {
          await this.options.withStoppedMacros(plan.affectedMacroIds, commit);
        } catch (error) {
          if (error instanceof PortableDataError) {
            throw error;
          }
          if (error instanceof MacroMutationBusyError) {
            throw new PortableDataError(
              "PORTABLE_IMPORT_BUSY",
              "Stop affected macros before importing."
            );
          }
          throw error;
        }
      } else {
        await commit();
      }

      this.pendingImport = undefined;
      return {
        gameCount: getProcessedImportCount(plan.operations.games),
        roleCount: getProcessedImportCount(plan.operations.roles),
        workspaceCount: getProcessedImportCount(plan.operations.launchWorkspaces),
        macroCount: getProcessedImportCount(plan.operations.macros),
        preferencesIncluded: Boolean(selectedData.preferences),
        ...(selectedData.preferences ? { preferences: selectedData.preferences } : {}),
        selection: getEffectivePortableDataSelection(selectedData),
        operations: plan.operations,
        warnings: plan.warnings
      };
    }));
  }

  discardImport(importId: string): void {
    if (this.pendingImport?.importId === importId) {
      this.pendingImport = undefined;
    }
  }

  private runDataMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.withDataMutation?.(operation) ?? operation();
  }

  private async createPortableData(
    preferences: PortablePreferences | undefined,
    selection: PortableDataSelection
  ): Promise<RionPortableDataV3> {
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
        ...(role.coverImageDataUrl ? { coverImageDataUrl: role.coverImageDataUrl } : {}),
        ...(role.coverImageDominantColor ? { coverImageDominantColor: role.coverImageDominantColor } : {})
      })) : [],
      launchWorkspaces: selection.launchWorkspaces ? launchWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        template: workspace.template,
        browserLaunchMode: workspace.browserLaunchMode,
        browserZoomPercent: workspace.browserZoomPercent,
        resourcePolicy: { ...workspace.resourcePolicy },
        slots: workspace.slots.map((slot) => ({
          id: slot.id,
          ...(slot.roleId ? { roleId: slot.roleId } : {}),
          rect: { ...slot.rect }
        }))
      })) : [],
      macros: selection.macros ? macros.map((macro) => ({
        id: macro.id,
        enabled: macro.enabled,
        name: macro.name,
        roleIds: [...macro.roleIds],
        ...(macro.trigger ? { trigger: { ...macro.trigger } } : {}),
        repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
        steps: macro.steps.map((step) => ({ ...step }))
      })) : [],
      ...(normalizedPreferences ? { preferences: normalizedPreferences } : {})
    };
  }

  private async commitImport(plan: ImportPlan, gameBrowserSettings?: GameBrowserSettings): Promise<void> {
    const shouldWriteGames = hasImportChanges(plan.operations.games);
    const shouldWriteRoles = hasImportChanges(plan.operations.roles);
    const shouldWriteWorkspaces = hasImportChanges(plan.operations.launchWorkspaces);
    const shouldWriteMacros = hasImportChanges(plan.operations.macros);
    const shouldWriteSettings = Boolean(gameBrowserSettings && this.options.gameBrowserSettingsStore);
    if (!shouldWriteGames && !shouldWriteRoles && !shouldWriteWorkspaces && !shouldWriteMacros && !shouldWriteSettings) {
      return;
    }

    const [games, roles, workspaces, macros, currentSettings] = await Promise.all([
      this.options.gameStore.listGames(),
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces(),
      this.options.macroStore.listMacros(),
      shouldWriteSettings ? this.options.gameBrowserSettingsStore?.getSettings() : undefined
    ]);
    const targetSettings = gameBrowserSettings
      ? normalizeGameBrowserSettings(gameBrowserSettings)
      : undefined;

    // Pin one coherent pre-transaction snapshot in every cache. Stores with no
    // persisted file otherwise intentionally leave their empty cache uninitialized,
    // which could expose a later on-disk replacement before the transaction commits.
    this.options.gameStore.publishGamesForImport(games);
    this.options.roleStore.publishRolesForImport(roles);
    this.options.workspaceStore.publishWorkspacesForImport(workspaces);
    this.options.macroStore.publishMacrosForImport(macros);
    if (currentSettings) {
      this.options.gameBrowserSettingsStore?.publishSettingsForImport(currentSettings);
    }

    const journal: PortableImportJournal = {
      createdRoleIds: plan.createdRoleIds,
      games,
      roles,
      workspaces,
      macros,
      phase: "prepared",
      targetGames: plan.finalGames,
      targetRoles: plan.finalRoles,
      targetWorkspaces: plan.finalWorkspaces,
      targetMacros: plan.finalMacros,
      workspaceFileSchemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
      ...(targetSettings ? { targetGameBrowserSettings: targetSettings } : {}),
      ...(currentSettings ? { gameBrowserSettings: currentSettings } : {})
    };
    const journalPath = join(this.userDataDir, PORTABLE_IMPORT_JOURNAL_FILE);
    const stageDirectory = join(this.userDataDir, PORTABLE_IMPORT_STAGE_DIRECTORY);
    await writeJsonFileAtomically(journalPath, journal);

    try {
      await writePortableImportStage(stageDirectory, journal);
      let committedGames = games;
      let committedRoles = roles;
      let committedWorkspaces = workspaces;
      let committedMacros = macros;
      let committedSettings = currentSettings;

      if (shouldWriteGames) {
        committedGames = await this.options.gameStore.replaceGamesForImport(plan.finalGames, false);
      }
      if (shouldWriteRoles) {
        committedRoles = await this.options.roleStore.replaceRolesForImport(plan.finalRoles, false);
      }
      if (shouldWriteWorkspaces) {
        committedWorkspaces = await this.options.workspaceStore.replaceWorkspacesForImport(
          plan.finalWorkspaces,
          false
        );
      }
      if (shouldWriteMacros) {
        committedMacros = await this.options.macroStore.replaceMacrosForImport(plan.finalMacros, false);
      }
      if (shouldWriteSettings && targetSettings) {
        committedSettings = await this.options.gameBrowserSettingsStore?.updateSettings(targetSettings, false);
      }

      const committedJournal: PortableImportJournal = {
        ...journal,
        phase: "committed",
        targetGames: committedGames,
        targetRoles: committedRoles,
        targetWorkspaces: committedWorkspaces,
        targetMacros: committedMacros,
        ...(committedSettings ? { targetGameBrowserSettings: committedSettings } : {})
      };
      await writeJsonFileAtomically(journalPath, committedJournal);

      this.options.gameStore.publishGamesForImport(committedGames);
      this.options.roleStore.publishRolesForImport(committedRoles);
      this.options.workspaceStore.publishWorkspacesForImport(committedWorkspaces);
      this.options.macroStore.publishMacrosForImport(committedMacros);
      if (committedSettings) {
        this.options.gameBrowserSettingsStore?.publishSettingsForImport(committedSettings);
      }

      await rm(stageDirectory, { force: true, recursive: true });
      await rm(journalPath, { force: true });
    } catch (error) {
      let didRestore = false;
      try {
        const restoredGames = await this.options.gameStore.replaceGamesForImport(journal.games, false);
        const restoredRoles = await this.options.roleStore.replaceRolesForImport(journal.roles, false);
        const restoredWorkspaces = await this.options.workspaceStore.replaceWorkspacesForImport(
          journal.workspaces,
          false
        );
        const restoredMacros = await this.options.macroStore.replaceMacrosForImport(journal.macros, false);
        let restoredSettings = journal.gameBrowserSettings;
        if (journal.gameBrowserSettings) {
          restoredSettings = await this.options.gameBrowserSettingsStore?.updateSettings(
            journal.gameBrowserSettings,
            false
          );
        }

        this.options.gameStore.publishGamesForImport(restoredGames);
        this.options.roleStore.publishRolesForImport(restoredRoles);
        this.options.workspaceStore.publishWorkspacesForImport(restoredWorkspaces);
        this.options.macroStore.publishMacrosForImport(restoredMacros);
        if (restoredSettings) {
          this.options.gameBrowserSettingsStore?.publishSettingsForImport(restoredSettings);
        }
        await cleanupImportedRoleDirectories(this.userDataDir, journal.createdRoleIds);
        didRestore = true;
      } finally {
        if (didRestore) {
          await rm(stageDirectory, { force: true, recursive: true });
          await rm(journalPath, { force: true });
        }
      }
      throw error;
    }
  }

  private async buildImportPlan(
    data: RionPortableDataV3,
    resolutions: PortableMacroConflictResolution[]
  ): Promise<ImportPlan> {
    const [existingGames, existingRoles, existingWorkspaces, existingMacros] = await Promise.all([
      this.options.gameStore.listGames(),
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces(),
      this.options.macroStore.listMacros()
    ]);
    const timestamp = this.now().toISOString();
    const warnings: PortableImportWarning[] = [];
    const operations = createEmptyImportOperations();
    const gameIdMap = new Map<string, string>();
    const roleIdMap = new Map<string, string>();

    const finalGames = structuredClone(existingGames);
    const usedGameNames = new Set(finalGames.map((game) => normalizeNameKey(game.name)));
    const seenGameKeys = new Set<string>();
    for (const game of data.games) {
      const identityKey = game.source === "builtin" && game.builtinKey
        ? `builtin:${game.builtinKey}`
        : `custom:${normalizeNameKey(game.name)}`;
      const isDuplicateSourceIdentity = seenGameKeys.has(identityKey);
      seenGameKeys.add(identityKey);
      let existing = game.source === "builtin" && game.builtinKey
        ? finalGames.find((candidate) => candidate.builtinKey === game.builtinKey)
        : game.inferred
          ? finalGames.find(
              (candidate) => candidate.source === "custom" && candidate.defaultLaunchUrl === game.defaultLaunchUrl
            )
          : finalGames.find(
              (candidate) =>
                candidate.source === "custom" && normalizeNameKey(candidate.name) === normalizeNameKey(game.name)
            );

      if (isDuplicateSourceIdentity) {
        existing = undefined;
      }
      if (existing) {
        gameIdMap.set(game.id, existing.id);
        if (game.inferred) {
          incrementOperation(operations.games, "unchanged");
          continue;
        }
        const updated = createMergedGame(existing, game, timestamp);
        if (areGamesImportEqual(existing, updated)) {
          incrementOperation(operations.games, "unchanged");
        } else {
          finalGames[finalGames.findIndex((candidate) => candidate.id === existing.id)] = updated;
          incrementOperation(operations.games, "update");
          if (existing.source === "builtin") {
            warnings.push({ code: "BUILTIN_GAME_DEFAULTS_REPLACED", itemName: existing.name });
          }
        }
        continue;
      }

      const sourceForCreation: PortableGame = isDuplicateSourceIdentity && game.source === "builtin"
        ? { ...game, source: "custom", builtinKey: undefined }
        : game;
      const name = reserveUniqueName(sourceForCreation.name, usedGameNames);
      if (name !== game.name) {
        warnings.push({ code: "GAME_NAME_RENAMED", itemName: game.name, replacementName: name });
      }
      const created = createImportedGame(sourceForCreation, name, timestamp);
      finalGames.push(created);
      gameIdMap.set(game.id, created.id);
      incrementOperation(operations.games, "create");
    }

    const finalRoles = structuredClone(existingRoles);
    const usedRoleNames = createRoleNameRegistry(finalRoles);
    const seenRoleKeys = new Set<string>();
    const createdRoleIds: string[] = [];
    for (const role of data.roles) {
      const gameId = role.gameId ? gameIdMap.get(role.gameId) : undefined;
      if (!gameId) {
        throw new PortableDataError("PORTABLE_ROLE_GAME_MISSING", "Imported role game is unavailable.");
      }
      if (role.gameRecovered) {
        warnings.push({ code: "ROLE_GAME_RECOVERED", itemName: role.name });
      }
      const identityKey = createRoleIdentityKey(gameId, role.name);
      const isDuplicateSourceIdentity = seenRoleKeys.has(identityKey);
      seenRoleKeys.add(identityKey);
      const existing = isDuplicateSourceIdentity
        ? undefined
        : finalRoles.find(
            (candidate) => candidate.gameId === gameId && normalizeNameKey(candidate.name) === normalizeNameKey(role.name)
          );

      if (existing) {
        roleIdMap.set(role.id, existing.id);
        const updated = createMergedRole(existing, role, gameId, role.name, timestamp);
        if (areRolesImportEqual(existing, updated)) {
          incrementOperation(operations.roles, "unchanged");
        } else {
          finalRoles[finalRoles.findIndex((candidate) => candidate.id === existing.id)] = updated;
          incrementOperation(operations.roles, "update");
        }
        continue;
      }

      const name = reserveUniqueRoleName(role.name, gameId, usedRoleNames);
      if (name !== role.name) {
        warnings.push({ code: "ROLE_NAME_RENAMED", itemName: role.name, replacementName: name });
      }
      const created = createImportedRole(role, gameId, name, timestamp);
      finalRoles.push(created);
      createdRoleIds.push(created.id);
      roleIdMap.set(role.id, created.id);
      incrementOperation(operations.roles, "create");
    }

    const finalWorkspaces = structuredClone(existingWorkspaces);
    const usedWorkspaceNames = new Set(finalWorkspaces.map((workspace) => normalizeNameKey(workspace.name)));
    const seenWorkspaceKeys = new Set<string>();
    for (const workspace of data.launchWorkspaces) {
      const missingRoleCount = workspace.slots.filter(
        (slot) => slot.roleId && !roleIdMap.has(slot.roleId)
      ).length;
      if (missingRoleCount > 0) {
        warnings.push({
          code: "WORKSPACE_ROLE_MISSING",
          count: missingRoleCount,
          itemName: workspace.name
        });
      }
      validatePortableWorkspaceLayout(workspace);
      const identityKey = normalizeNameKey(workspace.name);
      const isDuplicateSourceIdentity = seenWorkspaceKeys.has(identityKey);
      seenWorkspaceKeys.add(identityKey);
      const existing = isDuplicateSourceIdentity
        ? undefined
        : finalWorkspaces.find((candidate) => normalizeNameKey(candidate.name) === identityKey);
      const name = existing ? workspace.name : reserveUniqueName(workspace.name, usedWorkspaceNames);
      if (name !== workspace.name) {
        warnings.push({ code: "WORKSPACE_NAME_RENAMED", itemName: workspace.name, replacementName: name });
      }
      const merged = createImportedWorkspace(workspace, name, roleIdMap, timestamp, existing);
      if (!existing) {
        finalWorkspaces.push(merged);
        incrementOperation(operations.launchWorkspaces, "create");
      } else if (areWorkspacesImportEqual(existing, merged)) {
        incrementOperation(operations.launchWorkspaces, "unchanged");
      } else {
        finalWorkspaces[finalWorkspaces.findIndex((candidate) => candidate.id === existing.id)] = merged;
        incrementOperation(operations.launchWorkspaces, "update");
      }
    }

    const resolutionByConflictId = new Map(resolutions.map((resolution) => [resolution.conflictId, resolution]));
    const conflicts: PortableMacroConflict[] = [];
    const seenMacroKeys = new Set<string>();
    const usedMacroCopyNames = new Set(existingMacros.map((macro) => normalizeNameKey(macro.name)));
    const plannedMacros: PlannedPortableMacro[] = [];
    for (const macro of data.macros) {
      const roleIds = [...new Set(macro.roleIds.map((roleId) => roleIdMap.get(roleId)).filter(isString))];
      const missingRoleCount = [...new Set(macro.roleIds)].filter((roleId) => !roleIdMap.has(roleId)).length;
      if (missingRoleCount > 0) {
        warnings.push({ code: "MACRO_ROLE_MISSING", count: missingRoleCount, itemName: macro.name });
      }
      if (roleIds.length === 0) {
        warnings.push({ code: "MACRO_SKIPPED_NO_ROLES", itemName: macro.name });
        incrementOperation(operations.macros, "skip");
        continue;
      }

      const identityKey = createMacroIdentityKey(macro.name, roleIds);
      const isDuplicateSourceIdentity = seenMacroKeys.has(identityKey);
      seenMacroKeys.add(identityKey);
      if (isDuplicateSourceIdentity) {
        const name = reserveUniqueName(macro.name, usedMacroCopyNames);
        warnings.push({ code: "MACRO_NAME_RENAMED", itemName: macro.name, replacementName: name });
        plannedMacros.push({ destinationId: randomUUID(), macro, name, roleIds });
        continue;
      }

      const candidates = existingMacros.filter(
        (candidate) => createMacroIdentityKey(candidate.name, candidate.roleIds) === identityKey
      );
      if (candidates.length <= 1) {
        plannedMacros.push({
          destinationId: candidates[0]?.id ?? randomUUID(),
          existing: candidates[0],
          macro,
          name: macro.name,
          roleIds
        });
        continue;
      }

      const conflictId = `macro:${macro.id}`;
      const resolution = resolutionByConflictId.get(conflictId);
      if (resolution?.action === "skip") {
        incrementOperation(operations.macros, "skip");
        continue;
      }
      if (resolution?.action === "copy") {
        const name = reserveUniqueName(macro.name, usedMacroCopyNames);
        warnings.push({ code: "MACRO_NAME_RENAMED", itemName: macro.name, replacementName: name });
        plannedMacros.push({ destinationId: randomUUID(), macro, name, roleIds });
        continue;
      }
      const selected = resolution?.action === "update"
        ? candidates.find((candidate) => candidate.id === resolution.targetMacroId)
        : undefined;
      if (selected) {
        plannedMacros.push({
          destinationId: selected.id,
          existing: selected,
          macro,
          name: macro.name,
          roleIds
        });
        continue;
      }

      conflicts.push(createPortableMacroConflict(conflictId, macro, roleIds, candidates, finalRoles));
    }

    const macroIdMap = new Map(
      plannedMacros.map((item) => [item.macro.id, item.destinationId])
    );
    let didSkipDependency = true;
    while (didSkipDependency) {
      didSkipDependency = false;
      for (let index = plannedMacros.length - 1; index >= 0; index -= 1) {
        const item = plannedMacros[index];
        const hasMissingDependency = item.macro.steps.some(
          (step) => step.type === "macro" && !macroIdMap.has(step.macroId)
        );
        if (!hasMissingDependency) continue;

        plannedMacros.splice(index, 1);
        macroIdMap.delete(item.macro.id);
        warnings.push({ code: "MACRO_SKIPPED_MISSING_DEPENDENCY", itemName: item.name });
        incrementOperation(operations.macros, "skip");
        didSkipDependency = true;
      }
    }

    const replacedMacroIds = new Set(
      plannedMacros.flatMap((item) => item.existing ? [item.existing.id] : [])
    );
    const acceptedMacros = existingMacros.filter((macro) => !replacedMacroIds.has(macro.id));
    const macroReplacementById = new Map<string, Macro>();
    const createdMacros: Macro[] = [];
    const directlyAffectedMacroIds: string[] = [];
    for (const item of plannedMacros) {
      let trigger = item.macro.trigger ? { ...item.macro.trigger } : undefined;
      if (trigger && areMacroTriggersEqual(trigger, MACRO_OVERLAY_TRIGGER)) {
        warnings.push({ code: "MACRO_SHORTCUT_CLEARED_RESERVED", itemName: item.name });
        trigger = undefined;
      } else if (
        trigger && acceptedMacros.some(
          (candidate) =>
            areMacroTriggersEqual(candidate.trigger, trigger) &&
            macroRoleAssignmentsOverlap(candidate.roleIds, item.roleIds)
        )
      ) {
        warnings.push({ code: "MACRO_SHORTCUT_CLEARED_CONFLICT", itemName: item.name });
        trigger = undefined;
      }

      const remappedMacro: PortableMacro = {
        ...item.macro,
        steps: item.macro.steps.map((step) =>
          step.type === "macro"
            ? { ...step, macroId: macroIdMap.get(step.macroId)! }
            : { ...step }
        )
      };
      const merged = createImportedMacro(
        remappedMacro,
        item.name,
        item.roleIds,
        trigger,
        timestamp,
        item.existing,
        item.destinationId
      );
      if (!item.existing) {
        createdMacros.push(merged);
        acceptedMacros.push(merged);
        incrementOperation(operations.macros, "create");
      } else if (areMacrosImportEqual(item.existing, merged)) {
        macroReplacementById.set(item.existing.id, item.existing);
        acceptedMacros.push(item.existing);
        incrementOperation(operations.macros, "unchanged");
      } else {
        macroReplacementById.set(item.existing.id, merged);
        acceptedMacros.push(merged);
        directlyAffectedMacroIds.push(item.existing.id);
        incrementOperation(operations.macros, "update");
      }
    }
    const finalMacros = existingMacros
      .map((macro) => macroReplacementById.get(macro.id) ?? macro)
      .concat(createdMacros);
    if (findMacroDependencyIssue(finalMacros)) {
      throw new PortableDataError(
        "PORTABLE_MACRO_DEPENDENCY_INVALID",
        "Imported macro dependencies are invalid."
      );
    }
    const affectedMacroIds = existingMacros
      .filter((macro) =>
        directlyAffectedMacroIds.includes(macro.id) ||
        directlyAffectedMacroIds.some((targetId) =>
          macroDependsOn(existingMacros, macro.id, targetId)
        )
      )
      .map((macro) => macro.id);

    return {
      affectedMacroIds,
      conflicts,
      createdRoleIds,
      finalGames,
      finalMacros,
      finalRoles,
      finalWorkspaces,
      operations,
      warnings
    };
  }
}

async function writePortableImportStage(
  stageDirectory: string,
  journal: PortableImportJournal
): Promise<void> {
  await rm(stageDirectory, { force: true, recursive: true });
  await Promise.all([
    writeJsonFileAtomically(join(stageDirectory, "games.json"), { games: journal.targetGames }),
    writeJsonFileAtomically(join(stageDirectory, "roles.json"), { roles: journal.targetRoles }),
    writeJsonFileAtomically(join(stageDirectory, "launch-workspaces.json"), {
      schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
      workspaces: journal.targetWorkspaces
    }),
    writeJsonFileAtomically(join(stageDirectory, "macros.json"), { macros: journal.targetMacros }),
    ...(journal.targetGameBrowserSettings
      ? [
          writeJsonFileAtomically(
            join(stageDirectory, "game-browser-settings.json"),
            journal.targetGameBrowserSettings
          )
        ]
      : [])
  ]);
}

export async function recoverPortableImportTransaction(userDataDir: string): Promise<void> {
  const journalPath = join(userDataDir, PORTABLE_IMPORT_JOURNAL_FILE);
  const stageDirectory = join(userDataDir, PORTABLE_IMPORT_STAGE_DIRECTORY);
  let journal: PortableImportJournal;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as PortableImportJournal;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await rm(stageDirectory, { force: true, recursive: true });
      return;
    }
    throw error;
  }

  const isCommitted = journal.phase === "committed";
  if (
    (journal.phase !== undefined && journal.phase !== "prepared" && journal.phase !== "committed") ||
    !Array.isArray(journal.games) ||
    !Array.isArray(journal.roles) ||
    !Array.isArray(journal.workspaces) ||
    !Array.isArray(journal.macros) ||
    (isCommitted && !Array.isArray(journal.targetGames)) ||
    (isCommitted && !Array.isArray(journal.targetRoles)) ||
    (isCommitted && !Array.isArray(journal.targetWorkspaces)) ||
    (isCommitted && !Array.isArray(journal.targetMacros)) ||
    !Array.isArray(journal.createdRoleIds) ||
    journal.createdRoleIds.some(
      (roleId) => typeof roleId !== "string" || !GENERATED_ROLE_ID_PATTERN.test(roleId)
    ) ||
    (
      journal.workspaceFileSchemaVersion !== undefined &&
      journal.workspaceFileSchemaVersion > LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION
    )
  ) {
    throw new PortableDataError("PORTABLE_IMPORT_RECOVERY_INVALID", "Portable import recovery data is invalid.");
  }

  const recoveryGames = isCommitted ? journal.targetGames as Game[] : journal.games;
  const recoveryRoles = isCommitted ? journal.targetRoles as Role[] : journal.roles;
  const journalWorkspaces = isCommitted
    ? journal.targetWorkspaces as LaunchWorkspace[]
    : journal.workspaces;
  const recoveryWorkspaces = (journal.workspaceFileSchemaVersion ?? 0) < LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION
    ? journalWorkspaces.map(migrateWorkspaceResourcePolicyToAdaptive)
    : journalWorkspaces;
  const recoveryMacros = isCommitted ? journal.targetMacros as Macro[] : journal.macros;
  const recoverySettings = isCommitted
    ? journal.targetGameBrowserSettings
    : journal.gameBrowserSettings;

  await writeJsonFileAtomically(join(userDataDir, "games.json"), { games: recoveryGames });
  await writeJsonFileAtomically(join(userDataDir, "roles.json"), { roles: recoveryRoles });
  await writeJsonFileAtomically(join(userDataDir, "launch-workspaces.json"), {
    schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
    workspaces: recoveryWorkspaces
  });
  await writeJsonFileAtomically(join(userDataDir, "macros.json"), { macros: recoveryMacros });
  if (recoverySettings) {
    await writeJsonFileAtomically(join(userDataDir, "game-browser-settings.json"), recoverySettings);
  }
  if (!isCommitted) {
    await cleanupImportedRoleDirectories(userDataDir, journal.createdRoleIds);
  }
  await rm(stageDirectory, { force: true, recursive: true });
  await rm(journalPath, { force: true });
}

function createEmptyImportOperationSummary(): PortableImportOperationSummary {
  return { create: 0, update: 0, unchanged: 0, skip: 0 };
}

function createEmptyImportOperations(): PortableImportOperations {
  return {
    games: createEmptyImportOperationSummary(),
    roles: createEmptyImportOperationSummary(),
    launchWorkspaces: createEmptyImportOperationSummary(),
    macros: createEmptyImportOperationSummary()
  };
}

function incrementOperation(
  summary: PortableImportOperationSummary,
  action: keyof PortableImportOperationSummary
): void {
  summary[action] += 1;
}

function hasImportChanges(summary: PortableImportOperationSummary): boolean {
  return summary.create > 0 || summary.update > 0;
}

function getProcessedImportCount(summary: PortableImportOperationSummary): number {
  return summary.create + summary.update + summary.unchanged;
}

function createMergedGame(existing: Game, source: PortableGame, timestamp: string): Game {
  return {
    ...existing,
    name: existing.source === "builtin" ? existing.name : source.name,
    defaultLaunchUrl: source.defaultLaunchUrl,
    loginUrl: source.loginUrl,
    iconImageDataUrl: existing.source === "builtin" ? existing.iconImageDataUrl : source.iconImageDataUrl,
    coverImageDataUrl: existing.source === "builtin" ? existing.coverImageDataUrl : source.coverImageDataUrl,
    roleDefaults: source.roleDefaults ? { ...source.roleDefaults } : undefined,
    browserLaunchMode: source.browserLaunchMode,
    updatedAt: timestamp
  };
}

function createImportedGame(source: PortableGame, name: string, timestamp: string): Game {
  const definition = source.builtinKey
    ? BUILTIN_GAME_DEFINITIONS.find((candidate) => candidate.builtinKey === source.builtinKey)
    : undefined;
  return {
    id: definition?.id ?? randomUUID(),
    source: definition ? "builtin" : "custom",
    ...(definition ? { builtinKey: definition.builtinKey } : {}),
    name: definition?.name ?? name,
    ...(source.iconImageDataUrl && !definition ? { iconImageDataUrl: source.iconImageDataUrl } : {}),
    ...(source.coverImageDataUrl && !definition ? { coverImageDataUrl: source.coverImageDataUrl } : {}),
    defaultLaunchUrl: source.defaultLaunchUrl,
    ...(source.loginUrl ? { loginUrl: source.loginUrl } : {}),
    ...(source.roleDefaults ? { roleDefaults: { ...source.roleDefaults } } : {}),
    browserLaunchMode: source.browserLaunchMode,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function areGamesImportEqual(left: Game, right: Game): boolean {
  return JSON.stringify(toPortableGame(left)) === JSON.stringify(toPortableGame(right));
}

function createRoleIdentityKey(gameId: string, name: string): string {
  return `${gameId}\u0000${normalizeNameKey(name)}`;
}

function createRoleNameRegistry(roles: Role[]): Map<string, Set<string>> {
  const registry = new Map<string, Set<string>>();
  roles.forEach((role) => {
    const names = registry.get(role.gameId) ?? new Set<string>();
    names.add(normalizeNameKey(role.name));
    registry.set(role.gameId, names);
  });
  return registry;
}

function reserveUniqueRoleName(name: string, gameId: string, registry: Map<string, Set<string>>): string {
  const names = registry.get(gameId) ?? new Set<string>();
  registry.set(gameId, names);
  return reserveUniqueName(name, names);
}

function createMergedRole(
  existing: Role,
  source: PortableRole,
  gameId: string,
  name: string,
  timestamp: string
): Role {
  return {
    ...existing,
    gameId,
    name,
    launchUrl: source.launchUrl,
    windowWidth: source.windowWidth,
    windowHeight: source.windowHeight,
    notes: source.notes,
    coverImageDataUrl: source.coverImageDataUrl,
    coverImageDominantColor: source.coverImageDataUrl ? source.coverImageDominantColor : undefined,
    updatedAt: timestamp
  };
}

function createImportedRole(
  source: PortableRole,
  gameId: string,
  name: string,
  timestamp: string
): Role {
  return {
    id: randomUUID(),
    gameId,
    name,
    launchUrl: source.launchUrl,
    windowWidth: source.windowWidth,
    windowHeight: source.windowHeight,
    notes: source.notes,
    authState: "login_required",
    ...(source.coverImageDataUrl ? { coverImageDataUrl: source.coverImageDataUrl } : {}),
    ...(source.coverImageDataUrl && source.coverImageDominantColor
      ? { coverImageDominantColor: source.coverImageDominantColor }
      : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function areRolesImportEqual(left: Role, right: Role): boolean {
  return JSON.stringify(toPortableRole(left)) === JSON.stringify(toPortableRole(right));
}

function toPortableRole(role: Role): PortableRole {
  return {
    id: role.id,
    gameId: role.gameId,
    name: role.name,
    launchUrl: role.launchUrl,
    windowWidth: role.windowWidth,
    windowHeight: role.windowHeight,
    notes: role.notes,
    ...(role.coverImageDataUrl ? { coverImageDataUrl: role.coverImageDataUrl } : {}),
    ...(role.coverImageDominantColor ? { coverImageDominantColor: role.coverImageDominantColor } : {})
  };
}

function validatePortableWorkspaceLayout(workspace: PortableLaunchWorkspace): void {
  const slotCount = getWorkspaceTemplateSlotCount(workspace.template);
  if (workspace.slots.slice(slotCount).some((slot) => Boolean(slot.roleId))) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function createImportedWorkspace(
  source: PortableLaunchWorkspace,
  name: string,
  roleIdMap: Map<string, string>,
  timestamp: string,
  existing?: LaunchWorkspace
): LaunchWorkspace {
  const defaultRects = getDefaultWorkspaceRects(source.template);
  const slots = defaultRects.map((defaultRect, index) => {
    const sourceSlot = source.slots[index];
    const roleId = sourceSlot?.roleId ? roleIdMap.get(sourceSlot.roleId) : undefined;
    return {
      id: sourceSlot?.id || `slot-${index + 1}`,
      ...(roleId ? { roleId } : {}),
      rect: { ...(sourceSlot?.rect ?? defaultRect) }
    };
  });
  return {
    id: existing?.id ?? randomUUID(),
    name,
    template: source.template,
    browserLaunchMode: source.browserLaunchMode ?? "inherit",
    browserZoomPercent: source.browserZoomPercent,
    resourcePolicy: remapWorkspaceResourcePolicy(source.resourcePolicy, roleIdMap, slots),
    ...(existing?.targetDisplayId === undefined ? {} : { targetDisplayId: existing.targetDisplayId }),
    slots,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function areWorkspacesImportEqual(left: LaunchWorkspace, right: LaunchWorkspace): boolean {
  return JSON.stringify(toPortableWorkspace(left)) === JSON.stringify(toPortableWorkspace(right));
}

function toPortableWorkspace(workspace: LaunchWorkspace): PortableLaunchWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    template: workspace.template,
    browserLaunchMode: workspace.browserLaunchMode,
    browserZoomPercent: workspace.browserZoomPercent,
    resourcePolicy: { ...workspace.resourcePolicy },
    slots: workspace.slots.map((slot) => ({
      id: slot.id,
      ...(slot.roleId ? { roleId: slot.roleId } : {}),
      rect: { ...slot.rect }
    }))
  };
}

function createMacroIdentityKey(name: string, roleIds: string[]): string {
  return `${normalizeNameKey(name)}\u0000${[...roleIds].sort().join("\u0000")}`;
}

function createPortableMacroConflict(
  id: string,
  source: PortableMacro,
  roleIds: string[],
  candidates: Macro[],
  roles: Role[]
): PortableMacroConflict {
  const roleNameById = new Map(roles.map((role) => [role.id, role.name]));
  return {
    id,
    macroId: source.id,
    name: source.name,
    roleNames: roleIds.map((roleId) => roleNameById.get(roleId) ?? roleId),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      roleNames: candidate.roleIds.map((roleId) => roleNameById.get(roleId) ?? roleId),
      stepCount: candidate.steps.length,
      ...(candidate.trigger ? { trigger: { ...candidate.trigger } } : {}),
      updatedAt: candidate.updatedAt
    }))
  };
}

function createImportedMacro(
  source: PortableMacro,
  name: string,
  roleIds: string[],
  trigger: MacroTrigger | undefined,
  timestamp: string,
  existing: Macro | undefined,
  destinationId: string
): Macro {
  return {
    id: destinationId,
    enabled: source.enabled ?? true,
    name,
    roleIds: [...roleIds],
    ...(trigger ? { trigger: { ...trigger } } : {}),
    repeat: source.repeat.type === "loop" ? { ...source.repeat } : { type: "once" },
    steps: source.steps.map((step) => ({ ...step })),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function areMacrosImportEqual(left: Macro, right: Macro): boolean {
  return JSON.stringify(toPortableMacro(left)) === JSON.stringify(toPortableMacro(right));
}

function toPortableMacro(macro: Macro): PortableMacro {
  return {
    id: macro.id,
    enabled: macro.enabled,
    name: macro.name,
    roleIds: [...macro.roleIds].sort(),
    ...(macro.trigger ? { trigger: { ...macro.trigger } } : {}),
    repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
    steps: macro.steps.map((step) => ({ ...step }))
  };
}

async function cleanupImportedRoleDirectories(userDataDir: string, roleIds: string[]): Promise<void> {
  if (roleIds.some((roleId) => !GENERATED_ROLE_ID_PATTERN.test(roleId))) {
    throw new PortableDataError("PORTABLE_IMPORT_RECOVERY_INVALID", "Portable import recovery data is invalid.");
  }
  await Promise.all(
    roleIds.map((roleId) => rm(join(userDataDir, "roles", roleId), { force: true, recursive: true }))
  );
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

function normalizePortableMacroConflictResolutions(value: unknown): PortableMacroConflictResolution[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new PortableDataError(
      "PORTABLE_IMPORT_RESOLUTION_INVALID",
      "Portable import conflict resolution is invalid."
    );
  }
  const seenConflictIds = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PortableDataError(
        "PORTABLE_IMPORT_RESOLUTION_INVALID",
        "Portable import conflict resolution is invalid."
      );
    }
    const resolution = item as Record<string, unknown>;
    const conflictId = typeof resolution.conflictId === "string" ? resolution.conflictId.trim() : "";
    if (!conflictId || seenConflictIds.has(conflictId)) {
      throw new PortableDataError(
        "PORTABLE_IMPORT_RESOLUTION_INVALID",
        "Portable import conflict resolution is invalid."
      );
    }
    seenConflictIds.add(conflictId);
    if (resolution.action === "copy" || resolution.action === "skip") {
      return { conflictId, action: resolution.action };
    }
    const targetMacroId = typeof resolution.targetMacroId === "string" ? resolution.targetMacroId.trim() : "";
    if (resolution.action !== "update" || !targetMacroId) {
      throw new PortableDataError(
        "PORTABLE_IMPORT_RESOLUTION_INVALID",
        "Portable import conflict resolution is invalid."
      );
    }
    return { conflictId, action: "update", targetMacroId };
  });
}

function selectPortableData(
  data: RionPortableDataV3,
  selection: PortableDataSelection
): RionPortableDataV3 {
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

function getEffectivePortableDataSelection(data: RionPortableDataV3): PortableDataSelection {
  return {
    games: data.games.length > 0,
    roles: data.roles.length > 0,
    launchWorkspaces: data.launchWorkspaces.length > 0,
    macros: data.macros.length > 0,
    preferences: Boolean(data.preferences)
  };
}

function ensurePortableContentSelected(data: RionPortableDataV3): void {
  const selection = getEffectivePortableDataSelection(data);
  if (!selection.games && !selection.roles && !selection.launchWorkspaces && !selection.macros && !selection.preferences) {
    throw new PortableDataError("PORTABLE_SELECTION_EMPTY", "Select at least one available data category.");
  }
}

function toPortableGame(game: Game): PortableGame {
  return {
    id: game.id,
    source: game.source,
    ...(game.builtinKey ? { builtinKey: game.builtinKey } : {}),
    name: game.name,
    ...(game.iconImageDataUrl ? { iconImageDataUrl: game.iconImageDataUrl } : {}),
    ...(game.coverImageDataUrl ? { coverImageDataUrl: game.coverImageDataUrl } : {}),
    defaultLaunchUrl: game.defaultLaunchUrl,
    ...(game.loginUrl ? { loginUrl: game.loginUrl } : {}),
    ...(game.roleDefaults ? { roleDefaults: { ...game.roleDefaults } } : {}),
    browserLaunchMode: game.browserLaunchMode
  };
}

function parsePortableData(raw: string): RionPortableDataV3 {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const data = toRecord(parsed);

    if (
      data.app !== PORTABLE_APP_NAME ||
      (data.schemaVersion !== 1 && data.schemaVersion !== 2 && data.schemaVersion !== PORTABLE_SCHEMA_VERSION) ||
      !Array.isArray(data.roles) ||
      !Array.isArray(data.launchWorkspaces) ||
      !Array.isArray(data.macros)
    ) {
      throw new Error("Invalid portable metadata.");
    }

    let roles = data.roles.map(normalizePortableRole);
    const games = (data.schemaVersion === 2 || data.schemaVersion === PORTABLE_SCHEMA_VERSION) && Array.isArray(data.games)
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
    if (findMacroDependencyIssue(macros)) {
      throw new PortableDataError(
        "PORTABLE_MACRO_DEPENDENCY_INVALID",
        "Imported macro dependencies are invalid."
      );
    }

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
  const coverImageDataUrl = source === "custom"
    ? normalizeOptionalGameCoverDataUrl(game.coverImageDataUrl)
    : undefined;
  const loginUrl = normalizeOptionalPortableUrl(game.loginUrl);
  const roleDefaults = normalizeOptionalPortableRoleDefaults(game.roleDefaults);
  return {
    id: normalizeRequiredString(game.id),
    source,
    ...(builtinKey ? { builtinKey } : {}),
    name: normalizeName(game.name),
    ...(iconImageDataUrl ? { iconImageDataUrl } : {}),
    ...(coverImageDataUrl ? { coverImageDataUrl } : {}),
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
          inferred: true,
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
          inferred: true,
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
    resourcePolicy: normalizePortableWorkspaceResourcePolicy(workspace.resourcePolicy, normalizedSlots),
    slots: normalizedSlots
  };
}

function normalizePortableWorkspaceResourcePolicy(
  value: unknown,
  slots: PortableLaunchWorkspace["slots"]
): WorkspaceResourcePolicy {
  const input = toRecord(
    value === undefined || value === null ? DEFAULT_WORKSPACE_RESOURCE_POLICY : value
  );
  if (input.mode !== "unrestricted" && input.mode !== "primary_priority" && input.mode !== "adaptive") {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  if (input.mode === "unrestricted") {
    return { mode: input.mode };
  }

  const roleIds = slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []);
  const primaryRoleId = typeof input.primaryRoleId === "string" && roleIds.includes(input.primaryRoleId)
    ? input.primaryRoleId
    : roleIds[0];
  return {
    mode: "adaptive",
    ...(primaryRoleId ? { primaryRoleId } : {})
  };
}

function remapWorkspaceResourcePolicy(
  policy: WorkspaceResourcePolicy | undefined,
  roleIdMap: Map<string, string>,
  slots: LaunchWorkspace["slots"]
): WorkspaceResourcePolicy {
  const source = policy ?? DEFAULT_WORKSPACE_RESOURCE_POLICY;
  if (source.mode === "unrestricted") {
    return { mode: source.mode };
  }

  const assignedRoleIds = slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []);
  const mappedPrimaryRoleId = source.primaryRoleId ? roleIdMap.get(source.primaryRoleId) : undefined;
  const primaryRoleId = mappedPrimaryRoleId && assignedRoleIds.includes(mappedPrimaryRoleId)
    ? mappedPrimaryRoleId
    : assignedRoleIds[0];
  return {
    mode: source.mode,
    ...(primaryRoleId ? { primaryRoleId } : {})
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

  if (!Array.isArray(macro.roleIds) || (macro.enabled !== undefined && typeof macro.enabled !== "boolean")) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    id: normalizeRequiredString(macro.id),
    enabled: macro.enabled ?? true,
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
    if (
      !isValidRoleDefaultWindowSize(windowWidth) ||
      !isValidRoleDefaultWindowSize(windowHeight)
    ) {
      return undefined;
    }

    return {
      windowWidth,
      windowHeight
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
      case "macro":
        return {
          id,
          type: "macro",
          macroId: normalizeRequiredString(step.macroId)
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
    trimmed.length > MAX_GAME_IMAGE_DATA_URL_LENGTH ||
    !COVER_IMAGE_DATA_URL_PATTERN.test(trimmed) ||
    getBase64PayloadByteLength(trimmed) > MAX_GAME_IMAGE_BYTES
  ) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
  return trimmed;
}

function normalizeOptionalGameCoverDataUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = normalizeRequiredString(value);
  if (
    trimmed.length > MAX_GAME_IMAGE_DATA_URL_LENGTH ||
    !COVER_IMAGE_DATA_URL_PATTERN.test(trimmed) ||
    getBase64PayloadByteLength(trimmed) > MAX_GAME_IMAGE_BYTES
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
