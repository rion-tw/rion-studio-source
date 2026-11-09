import type { CoreEvent } from "../../shared/generated";
import type { GameEffectRuntimeSettings } from "../../shared/gameEffects";
import { CHROMIUM_ROLE_GAME_EFFECTS_SYNC_CHANNEL } from
  "../ipc/chromiumRolePagePresentationProtocol";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import {
  ChromiumRolePagePresentation,
  type ChromiumRuntimeBootstrapPresentationPort
} from "./chromiumRolePagePresentation";
import type { ChromiumRoleSurfaceRegistry } from "./chromiumRoleSurfaceRegistry";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";

interface SyncIpcEvent { returnValue: unknown }

export interface ElectronRolePagePresentationCompositionInput {
  readonly core: ElectronCoreCommandPort & {
    subscribeCoreEvents: (listener: (event: CoreEvent) => void) => () => void;
  };
  readonly ipcMain: {
    on: (channel: string, listener: (event: SyncIpcEvent) => void) => unknown;
    removeListener: (channel: string, listener: (event: SyncIpcEvent) => void) => unknown;
  };
  readonly snapshot: () => ChromiumRuntimeExecutorSnapshot | null;
  /** Diagnostic record of the projection each session starts with or changes to. */
  readonly log?: (effects: GameEffectRuntimeSettings) => void;
}

export interface ElectronRolePagePresentationComposition {
  readonly presentation: ChromiumRolePagePresentation;
  readonly bootstrapPort: ChromiumRuntimeBootstrapPresentationPort;
  /** Resolves after the first authoritative settings read. */
  readonly start: () => Promise<void>;
  readonly dispose: () => void;
}

/**
 * Settings follow Core `stateChanged` events through one coalescing read
 * lane; role documents read the cached projection synchronously at start.
 */
export function createElectronRolePagePresentation(
  input: ElectronRolePagePresentationCompositionInput
): ElectronRolePagePresentationComposition {
  let surfaces: Pick<ChromiumRoleSurfaceRegistry, "sendPagePresentation"> | null = null;
  const presentation = new ChromiumRolePagePresentation({
    send: (roleId, generation, message) =>
      surfaces?.sendPagePresentation(roleId, generation, message) ?? false,
    snapshot: input.snapshot
  });
  const onSync = (event: SyncIpcEvent) => {
    // A synchronous request must always receive an answer.
    try {
      event.returnValue = presentation.effectsForDocumentStart();
    } catch {
      event.returnValue = null;
    }
  };
  let requested = 0;
  let logged = false;
  let running: Promise<void> | null = null;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const refresh = (): Promise<void> => {
    requested += 1;
    if (running) return running;
    running = (async () => {
      try {
        while (!disposed) {
          const target = requested;
          try {
            const settings = await input.core.invoke({ type: "gameBrowserSettingsGet" });
            const before = presentation.effectsForDocumentStart();
            presentation.observeGameBrowserSettings(settings);
            const after = presentation.effectsForDocumentStart();
            if (!logged || after !== before) input.log?.(after);
            logged = true;
          } catch {
            // The next state change retries; the cached projection stays valid.
          }
          if (target === requested) break;
        }
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return Object.freeze({
    presentation,
    bootstrapPort: Object.freeze<ChromiumRuntimeBootstrapPresentationPort>({
      attachSurfaces: (registry) => { surfaces = registry; }
    }),
    start: () => {
      if (!unsubscribe && !disposed) {
        input.ipcMain.on(CHROMIUM_ROLE_GAME_EFFECTS_SYNC_CHANNEL, onSync);
        unsubscribe = input.core.subscribeCoreEvents((event) => {
          if (event.type === "stateChanged") void refresh();
        });
      }
      return refresh();
    },
    dispose: () => {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      input.ipcMain.removeListener(CHROMIUM_ROLE_GAME_EFFECTS_SYNC_CHANNEL, onSync);
    }
  });
}
