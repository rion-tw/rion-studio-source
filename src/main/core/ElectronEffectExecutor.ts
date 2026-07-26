import type {
  CoreEffectDispatchReport,
  CoreEffectRequest,
  CoreEffectResult,
  CoreJsonValue
} from "../../shared/generated";

export interface ElectronEffectExecutorOptions {
  dispatchResults: (results: CoreEffectResult[]) => Promise<CoreEffectDispatchReport>;
  executeBrowserActionEffect?: (
    effect: CoreEffectRequest & { action: BrowserCoreEffectAction }
  ) => Promise<CoreJsonValue | undefined>;
  executeCompatibilityEffect?: (
    effect: CoreEffectRequest & { action: CompatibilityCoreEffectAction }
  ) => Promise<CoreJsonValue | undefined>;
  executeEmbeddedEffect?: (
    effect: CoreEffectRequest & { action: EmbeddedCoreEffectAction }
  ) => Promise<CoreJsonValue | undefined>;
  executeOverlayEffect?: (
    effect: CoreEffectRequest & { action: OverlayCoreEffectAction }
  ) => Promise<CoreJsonValue | undefined>;
  executeProfileEffect?: (
    effect: CoreEffectRequest & { action: ProfileCoreEffectAction }
  ) => Promise<CoreJsonValue | undefined>;
  onResult?: (effect: CoreEffectRequest, result: CoreEffectResult) => void;
}

/**
 * Applies Electron-only effects. Operation ordering, deadlines, retries,
 * cancellation, and compensation remain authoritative in the Rust actor.
 */
export class ElectronEffectExecutor {
  private accepting = true;
  private readonly inFlight = new Set<Promise<CoreEffectDispatchReport>>();

  constructor(private readonly options: ElectronEffectExecutorOptions) {}

  executeAndDispatch(effects: CoreEffectRequest[]): Promise<CoreEffectDispatchReport> {
    if (!this.accepting) {
      return Promise.reject(
        effectError(
          "ELECTRON_EFFECT_EXECUTOR_CLOSED",
          "The Electron effect executor is shutting down."
        )
      );
    }
    const operation = this.executeAndDispatchTracked(effects);
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation)
    );
    return operation;
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async closeAndDrain(): Promise<void> {
    this.accepting = false;
    await this.drain();
  }

  private async executeAndDispatchTracked(
    effects: CoreEffectRequest[]
  ): Promise<CoreEffectDispatchReport> {
    const results = await Promise.all(effects.map((effect) => this.execute(effect)));
    return this.options.dispatchResults(results);
  }

  async execute(effect: CoreEffectRequest): Promise<CoreEffectResult> {
    let result: CoreEffectResult;
    try {
      const value = await this.apply(effect);
      result = {
        effectId: effect.effectId,
        operationId: effect.operationId,
        ok: true,
        valueJson: value === undefined ? null : JSON.stringify(value),
        error: null
      };
    } catch (error) {
      const normalized = normalizeEffectError(error);
      result = {
        effectId: effect.effectId,
        operationId: effect.operationId,
        ok: false,
        valueJson: null,
        error: normalized
      };
    }
    try {
      this.options.onResult?.(effect, result);
    } catch {
      // Diagnostics must not interfere with effect acknowledgement.
    }
    return result;
  }

  private async apply(effect: CoreEffectRequest): Promise<CoreJsonValue | undefined> {
    const { action } = effect;
    if (isEmbeddedEffectAction(action)) {
      if (!this.options.executeEmbeddedEffect) {
        throw effectError(
          "ELECTRON_EFFECT_UNSUPPORTED",
          "The embedded browser effect adapter is unavailable."
        );
      }
      return this.options.executeEmbeddedEffect({ ...effect, action });
    }
    if (isOverlayEffectAction(action)) {
      if (!this.options.executeOverlayEffect) {
        throw effectError(
          "ELECTRON_EFFECT_UNSUPPORTED",
          "The macro overlay presentation effect adapter is unavailable."
        );
      }
      return this.options.executeOverlayEffect({ ...effect, action });
    }
    if (isProfileEffectAction(action)) {
      if (!this.options.executeProfileEffect) {
        throw effectError(
          "ELECTRON_EFFECT_UNSUPPORTED",
          "The profile and browser-data effect adapter is unavailable."
        );
      }
      return this.options.executeProfileEffect({ ...effect, action });
    }
    if (isCompatibilityEffectAction(action)) {
      if (!this.options.executeCompatibilityEffect) {
        throw effectError(
          "ELECTRON_EFFECT_UNSUPPORTED",
          "The compatibility effect adapter is unavailable."
        );
      }
      return this.options.executeCompatibilityEffect({ ...effect, action });
    }
    if (isBrowserEffectAction(action)) {
      if (!this.options.executeBrowserActionEffect) {
        throw effectError(
          "ELECTRON_EFFECT_UNSUPPORTED",
          "The embedded browser action effect adapter is unavailable."
        );
      }
      return this.options.executeBrowserActionEffect({ ...effect, action });
    }

    return assertNever(action);
  }
}

type EmbeddedCoreEffectAction = Extract<
  CoreEffectRequest["action"],
  {
    type:
      | "embeddedApplyRuntime"
      | "embeddedConfigureRoleSessions"
      | "embeddedCreateTab"
      | "embeddedDestroyRole"
      | "embeddedDestroyTab"
      | "embeddedFocusRole"
      | "embeddedInstallOverlays"
      | "embeddedLoadRoles";
  }
>;

export type OverlayCoreEffectAction = Extract<
  CoreEffectRequest["action"],
  { type: "overlayCopyCoordinate" | "overlayOpenMacroPage" }
>;

export type ProfileCoreEffectAction = Extract<
  CoreEffectRequest["action"],
  { type: "roleBrowserDataClearSession" }
>;

export type CompatibilityCoreEffectAction = Extract<
  CoreEffectRequest["action"],
  {
    type:
      | "compatibilityCreateWindow"
      | "compatibilityConfigureSession"
      | "compatibilityLoadUrl"
      | "compatibilityProbeGraphics"
      | "compatibilityCleanupWindow";
  }
>;

export type BrowserCoreEffectAction = Extract<
  CoreEffectRequest["action"],
  { type: "browserAction" }
>;

function isEmbeddedEffectAction(
  action: CoreEffectRequest["action"]
): action is EmbeddedCoreEffectAction {
  return action.type.startsWith("embedded");
}

function isOverlayEffectAction(
  action: CoreEffectRequest["action"]
): action is OverlayCoreEffectAction {
  return action.type === "overlayCopyCoordinate" || action.type === "overlayOpenMacroPage";
}

function isProfileEffectAction(
  action: CoreEffectRequest["action"]
): action is ProfileCoreEffectAction {
  return action.type === "roleBrowserDataClearSession";
}

function isCompatibilityEffectAction(
  action: CoreEffectRequest["action"]
): action is CompatibilityCoreEffectAction {
  return action.type.startsWith("compatibility");
}

function isBrowserEffectAction(
  action: CoreEffectRequest["action"]
): action is BrowserCoreEffectAction {
  return action.type === "browserAction";
}

function assertNever(value: never): never {
  throw effectError(
    "ELECTRON_EFFECT_UNSUPPORTED",
    `The transitional Electron shell cannot execute effect ${JSON.stringify(value)}.`
  );
}

function effectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeEffectError(error: unknown): {
  code: string;
  message: string;
} {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "string") {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error.code)
    };
  }
  return {
    code: "ELECTRON_EFFECT_FAILED",
    message: error instanceof Error ? error.message : String(error)
  };
}
