import type {
  Game,
  GameBrowserSettings,
  GameCompatibilityReport,
  LaunchWorkspace,
  Macro,
  MacroSettings,
  Role
} from "../../shared/types";
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
      await this.core.invoke<{ revision: number }>({
        type: "stateReplace",
        key,
        value: structuredClone(value)
      });
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
        type: "stateReplaceSnapshot",
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
