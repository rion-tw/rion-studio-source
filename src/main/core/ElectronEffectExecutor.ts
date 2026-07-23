import type {
  CoreEffectDispatchReport,
  CoreEffectRequest,
  CoreEffectResult,
  CoreJsonValue,
  StatePixelBoundsRecord
} from "../../shared/generated";

export interface ElectronWindowEffectHandle {
  close?: () => void;
  contentView?: {
    addChildView: (view: ElectronViewEffectHandle) => void;
    removeChildView: (view: ElectronViewEffectHandle) => void;
  };
  destroy?: () => void;
  focus: () => void;
  hide?: () => void;
  setBounds: (bounds: StatePixelBoundsRecord) => void;
  show?: () => void;
}

export interface ElectronViewEffectHandle {
  destroy?: () => void;
  setBounds: (bounds: StatePixelBoundsRecord) => void;
  webContents: ElectronWebContentsEffectHandle;
}

export interface ElectronWebContentsEffectHandle {
  close?: () => void;
  destroy?: () => void;
  executeJavaScript: (source: string) => Promise<CoreJsonValue>;
  focus: () => void;
  loadURL: (url: string) => Promise<void>;
  setAudioMuted: (muted: boolean) => void;
}

export interface ElectronSessionEffectHandle {
  readonly partition: string;
}

export type ElectronEffectHandle =
  | ElectronSessionEffectHandle
  | ElectronViewEffectHandle
  | ElectronWebContentsEffectHandle
  | ElectronWindowEffectHandle;

export class ElectronHandleRegistry {
  private readonly handles = new Map<string, ElectronEffectHandle>();

  register(handleId: string, handle: ElectronEffectHandle): void {
    if (!handleId) throw effectError("ELECTRON_EFFECT_HANDLE_INVALID", "Effect handle ID is required.");
    if (this.handles.has(handleId)) {
      throw effectError(
        "ELECTRON_EFFECT_HANDLE_DUPLICATE",
        `Electron effect handle already exists: ${handleId}`
      );
    }
    this.handles.set(handleId, handle);
  }

  replace(handleId: string, handle: ElectronEffectHandle): void {
    if (!handleId) throw effectError("ELECTRON_EFFECT_HANDLE_INVALID", "Effect handle ID is required.");
    this.handles.set(handleId, handle);
  }

  get(handleId: string): ElectronEffectHandle | undefined {
    return this.handles.get(handleId);
  }

  require(handleId: string): ElectronEffectHandle {
    const handle = this.handles.get(handleId);
    if (!handle) {
      throw effectError(
        "ELECTRON_EFFECT_TARGET_NOT_FOUND",
        `Electron effect target was not found: ${handleId}`
      );
    }
    return handle;
  }

  unregister(handleId: string): ElectronEffectHandle | undefined {
    const handle = this.handles.get(handleId);
    this.handles.delete(handleId);
    return handle;
  }

  clear(): void {
    this.handles.clear();
  }
}

export interface ElectronEffectExecutorOptions {
  clearSessionStorage: (
    session: ElectronSessionEffectHandle,
    storages: string[]
  ) => Promise<void>;
  createView: (optionsJson: string) => ElectronViewEffectHandle;
  createWindow: (optionsJson: string) => ElectronWindowEffectHandle;
  dispatchResults: (results: CoreEffectResult[]) => Promise<CoreEffectDispatchReport>;
  executeEmbeddedEffect?: (
    effect: CoreEffectRequest & { action: EmbeddedCoreEffectAction }
  ) => Promise<CoreJsonValue | undefined>;
  sendDebuggerCommand: (
    webContents: ElectronWebContentsEffectHandle,
    method: string,
    params: Record<string, CoreJsonValue>
  ) => Promise<CoreJsonValue>;
  setCookie: (session: ElectronSessionEffectHandle, cookieJson: string) => Promise<void>;
}

/**
 * Applies Electron-only effects. Operation ordering, deadlines, retries,
 * cancellation, and compensation remain authoritative in the Rust actor.
 */
export class ElectronEffectExecutor {
  constructor(
    readonly handles: ElectronHandleRegistry,
    private readonly options: ElectronEffectExecutorOptions
  ) {}

  async executeAndDispatch(effects: CoreEffectRequest[]): Promise<CoreEffectDispatchReport> {
    const results = await Promise.all(effects.map((effect) => this.execute(effect)));
    return this.options.dispatchResults(results);
  }

  async execute(effect: CoreEffectRequest): Promise<CoreEffectResult> {
    try {
      const value = await this.apply(effect);
      return {
        effectId: effect.effectId,
        operationId: effect.operationId,
        ok: true,
        valueJson: value === undefined ? null : JSON.stringify(value),
        error: null
      };
    } catch (error) {
      const normalized = normalizeEffectError(error);
      return {
        effectId: effect.effectId,
        operationId: effect.operationId,
        ok: false,
        valueJson: null,
        error: normalized
      };
    }
  }

  private async apply(effect: CoreEffectRequest): Promise<CoreJsonValue | undefined> {
    const { action, target } = effect;
    if (action.type === "createWindow") {
      this.handles.register(target.handleId, this.options.createWindow(action.optionsJson));
      return undefined;
    }
    if (action.type === "createView") {
      this.handles.register(target.handleId, this.options.createView(action.optionsJson));
      return undefined;
    }
    if (isEmbeddedEffectAction(action)) {
      if (!this.options.executeEmbeddedEffect) {
        throw effectError(
          "ELECTRON_EFFECT_UNSUPPORTED",
          "The embedded browser effect adapter is unavailable."
        );
      }
      return this.options.executeEmbeddedEffect({ ...effect, action });
    }

    const handle = this.handles.require(target.handleId);
    switch (action.type) {
      case "attachView": {
        const window = requireWindow(handle);
        const view = requireView(this.handles.require(action.childHandleId));
        if (!window.contentView) {
          throw effectError(
            "ELECTRON_EFFECT_UNSUPPORTED",
            "The target window cannot attach child views."
          );
        }
        window.contentView.addChildView(view);
        return undefined;
      }
      case "detachView": {
        const window = requireWindow(handle);
        const view = requireView(this.handles.require(action.childHandleId));
        if (!window.contentView) {
          throw effectError(
            "ELECTRON_EFFECT_UNSUPPORTED",
            "The target window cannot detach child views."
          );
        }
        window.contentView.removeChildView(view);
        return undefined;
      }
      case "destroy":
        destroyHandle(handle);
        this.handles.unregister(target.handleId);
        return undefined;
      case "loadUrl":
        await webContentsOf(handle).loadURL(action.url);
        return undefined;
      case "setBounds":
        boundsTargetOf(handle).setBounds(action.bounds);
        return undefined;
      case "setVisible": {
        const window = requireWindow(handle);
        const method = action.visible ? window.show : window.hide;
        if (!method) {
          throw effectError(
            "ELECTRON_EFFECT_UNSUPPORTED",
            "The target window cannot change visibility."
          );
        }
        method.call(window);
        return undefined;
      }
      case "focus":
        focusTargetOf(handle).focus();
        return undefined;
      case "evaluate":
        return webContentsOf(handle).executeJavaScript(action.source);
      case "debuggerCommand":
        return this.options.sendDebuggerCommand(
          webContentsOf(handle),
          action.method,
          parseJsonRecord(action.paramsJson)
        );
      case "sessionClearStorage":
        await this.options.clearSessionStorage(requireSession(handle), action.storages);
        return undefined;
      case "cookieSet":
        await this.options.setCookie(requireSession(handle), action.cookieJson);
        return undefined;
      case "setAudioMuted":
        webContentsOf(handle).setAudioMuted(action.muted);
        return undefined;
    }
  }
}

type EmbeddedCoreEffectAction = Extract<
  CoreEffectRequest["action"],
  {
    type:
      | "embeddedActivateResources"
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

function isEmbeddedEffectAction(
  action: CoreEffectRequest["action"]
): action is EmbeddedCoreEffectAction {
  return action.type.startsWith("embedded");
}

function webContentsOf(handle: ElectronEffectHandle): ElectronWebContentsEffectHandle {
  if ("webContents" in handle) return handle.webContents;
  if ("loadURL" in handle) return handle;
  throw effectError(
    "ELECTRON_EFFECT_TARGET_TYPE",
    "The Electron effect target has no web contents."
  );
}

function requireWindow(handle: ElectronEffectHandle): ElectronWindowEffectHandle {
  if ("setBounds" in handle && "focus" in handle && !("webContents" in handle)) return handle;
  throw effectError("ELECTRON_EFFECT_TARGET_TYPE", "The Electron effect target is not a window.");
}

function requireView(handle: ElectronEffectHandle): ElectronViewEffectHandle {
  if ("webContents" in handle) return handle;
  throw effectError("ELECTRON_EFFECT_TARGET_TYPE", "The Electron effect target is not a view.");
}

function requireSession(handle: ElectronEffectHandle): ElectronSessionEffectHandle {
  if ("partition" in handle) return handle;
  throw effectError("ELECTRON_EFFECT_TARGET_TYPE", "The Electron effect target is not a session.");
}

function boundsTargetOf(
  handle: ElectronEffectHandle
): ElectronWindowEffectHandle | ElectronViewEffectHandle {
  if ("setBounds" in handle) return handle;
  throw effectError(
    "ELECTRON_EFFECT_TARGET_TYPE",
    "The Electron effect target does not support bounds."
  );
}

function focusTargetOf(
  handle: ElectronEffectHandle
): ElectronWindowEffectHandle | ElectronWebContentsEffectHandle {
  if ("focus" in handle) return handle;
  if ("webContents" in handle) return handle.webContents;
  throw effectError(
    "ELECTRON_EFFECT_TARGET_TYPE",
    "The Electron effect target does not support focus."
  );
}

function destroyHandle(handle: ElectronEffectHandle): void {
  if ("destroy" in handle && handle.destroy) {
    handle.destroy();
    return;
  }
  if ("close" in handle && handle.close) {
    handle.close();
    return;
  }
  throw effectError(
    "ELECTRON_EFFECT_UNSUPPORTED",
    "The Electron effect target cannot be destroyed."
  );
}

function parseJsonRecord(value: string): Record<string, CoreJsonValue> {
  const parsed = JSON.parse(value) as CoreJsonValue;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw effectError(
      "ELECTRON_EFFECT_PAYLOAD_INVALID",
      "Electron effect parameters must be a JSON object."
    );
  }
  return parsed;
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
