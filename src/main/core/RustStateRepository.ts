import type {
  Game,
  GameBrowserSettings,
  GameCompatibilityReport,
  LaunchWorkspace,
  Macro,
  MacroSettings,
  Role
} from "../../shared/types";
import type {
  GameBrowserSettingsRecord,
  LegalAcceptanceRecord,
  MacroSettingsRecord,
  RuntimeWindowPreferencesRecord
} from "../../shared/generated";
import type { AppCoreClient } from "./nativeCore";

export interface CoreStateSnapshot {
  games: Game[];
  roles: Role[];
  launchWorkspaces: LaunchWorkspace[];
  macros: Macro[];
  compatibilityReports: GameCompatibilityReport[];
  gameBrowserSettings?: GameBrowserSettings;
  macroSettings?: MacroSettings;
  runtimeWindowPreferences?: unknown;
  legalAcceptance?: unknown;
}

export type CoreStateKey = keyof CoreStateSnapshot;

export interface StateRepository {
  read<K extends CoreStateKey>(key: K, fallback: CoreStateSnapshot[K]): Promise<CoreStateSnapshot[K]>;
  replace<K extends CoreStateKey>(key: K, value: CoreStateSnapshot[K]): Promise<void>;
  replaceMany(values: Partial<CoreStateSnapshot>): Promise<void>;
}

export class RustStateRepository implements StateRepository {
  private cachedSnapshot: CoreStateSnapshot | undefined;
  private tail = Promise.resolve();

  constructor(private readonly core: AppCoreClient) {}

  async read<K extends CoreStateKey>(
    key: K,
    fallback: CoreStateSnapshot[K]
  ): Promise<CoreStateSnapshot[K]> {
    await this.tail;
    const snapshot = await this.getSnapshot();
    return structuredClone(snapshot[key] ?? fallback);
  }

  replace<K extends CoreStateKey>(key: K, value: CoreStateSnapshot[K]): Promise<void> {
    const operation = this.tail.then(async () => {
      if (isCollectionKey(key) && Array.isArray(value)) {
        const snapshot = await this.getSnapshot();
        const previous = snapshot[key] as Array<{ id?: string; gameId?: string }>;
        const next = structuredClone(value) as Array<{ id?: string; gameId?: string }>;
        const idKey = key === "compatibilityReports" ? "gameId" : "id";
        const previousById = new Map(previous.map((record) => [record[idKey], record]));
        const nextIds = next.map((record) => record[idKey]).filter((id): id is string => Boolean(id));
        const nextIdSet = new Set(nextIds);
        const upserts = next.filter((record) => {
          const id = record[idKey];
          return typeof id === "string" && !isDeepEqual(previousById.get(id), record);
        });
        const deleteIds = previous
          .map((record) => record[idKey])
          .filter((id): id is string => typeof id === "string" && !nextIdSet.has(id));
        await applyCollectionDelta(this.core, key, upserts, deleteIds, nextIds);
      } else {
        await replaceScalarState(this.core, key as ScalarStateKey, structuredClone(value));
      }
      if (this.cachedSnapshot) this.cachedSnapshot[key] = structuredClone(value);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  replaceMany(values: Partial<CoreStateSnapshot>): Promise<void> {
    const operation = this.tail.then(async () => {
      const current = await this.getSnapshot();
      const next = {
        ...current,
        ...structuredClone(values)
      };
      await this.core.invoke<{ revision: number }>({
        type: "portableCommit",
        snapshot: next
      });
      this.cachedSnapshot = next;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async getSnapshot(): Promise<CoreStateSnapshot> {
    if (!this.cachedSnapshot) {
      const snapshot = await this.core.invoke<Partial<CoreStateSnapshot>>({ type: "stateSnapshot" });
      this.cachedSnapshot = {
        games: snapshot.games ?? [],
        roles: snapshot.roles ?? [],
        launchWorkspaces: snapshot.launchWorkspaces ?? [],
        macros: snapshot.macros ?? [],
        compatibilityReports: snapshot.compatibilityReports ?? [],
        ...(snapshot.gameBrowserSettings === undefined
          ? {}
          : { gameBrowserSettings: snapshot.gameBrowserSettings }),
        ...(snapshot.macroSettings === undefined ? {} : { macroSettings: snapshot.macroSettings }),
        ...(snapshot.runtimeWindowPreferences === undefined
          ? {}
          : { runtimeWindowPreferences: snapshot.runtimeWindowPreferences }),
        ...(snapshot.legalAcceptance === undefined
          ? {}
          : { legalAcceptance: snapshot.legalAcceptance })
      };
    }
    return this.cachedSnapshot;
  }
}

async function replaceScalarState(
  core: AppCoreClient,
  key: Exclude<CoreStateKey, CollectionStateKey>,
  value: CoreStateSnapshot[typeof key]
): Promise<void> {
  switch (key) {
    case "gameBrowserSettings":
      await core.invoke({
        type: "gameBrowserSettingsReplace",
        settings: value as GameBrowserSettingsRecord
      });
      return;
    case "macroSettings":
      await core.invoke({ type: "macroSettingsReplace", settings: value as MacroSettingsRecord });
      return;
    case "runtimeWindowPreferences":
      await core.invoke({
        type: "runtimeWindowPreferencesReplace",
        preferences: value as RuntimeWindowPreferencesRecord
      });
      return;
    case "legalAcceptance":
      await core.invoke({
        type: "legalAcceptanceReplace",
        acceptance: value as LegalAcceptanceRecord
      });
  }
}

type CollectionStateKey = Extract<CoreStateKey,
  "games" | "roles" | "launchWorkspaces" | "macros" | "compatibilityReports">;
type ScalarStateKey = Exclude<CoreStateKey, CollectionStateKey>;

async function applyCollectionDelta(
  core: AppCoreClient,
  key: CollectionStateKey,
  upserts: Array<{ id?: string; gameId?: string }>,
  deleteIds: string[],
  orderedIds: string[]
): Promise<void> {
  switch (key) {
    case "games":
      await core.invoke({
        type: "gamesApplyDelta",
        upserts: upserts as Game[],
        deleteIds,
        orderedIds
      });
      return;
    case "roles":
      await core.invoke({
        type: "rolesApplyDelta",
        upserts: upserts as Role[],
        deleteIds,
        orderedIds
      });
      return;
    case "launchWorkspaces":
      await core.invoke({
        type: "launchWorkspacesApplyDelta",
        upserts: upserts as LaunchWorkspace[],
        deleteIds,
        orderedIds
      });
      return;
    case "macros":
      await core.invoke({
        type: "macrosApplyDelta",
        upserts: upserts as Macro[],
        deleteIds,
        orderedIds
      });
      return;
    case "compatibilityReports":
      await core.invoke({
        type: "compatibilityReportsApplyDelta",
        upserts: upserts as GameCompatibilityReport[],
        deleteIds,
        orderedIds
      });
  }
}

function isCollectionKey(key: CoreStateKey): key is CollectionStateKey {
  return ["games", "roles", "launchWorkspaces", "macros", "compatibilityReports"].includes(key);
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
