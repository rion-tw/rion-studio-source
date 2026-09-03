import { RionBridgeError } from "../ipc/errors";
import type { ElectronWebContentsPort, ElectronWindowPort } from "./electronPorts";

export interface RendererIdentity {
  readonly kind: "main-renderer";
  readonly windowId: number;
  readonly webContentsId: number;
  readonly generation: number;
}

interface RendererRecord {
  identity: RendererIdentity;
  window: ElectronWindowPort;
  contents: ElectronWebContentsPort;
}

type ResolveOwnerWindow = (contents: ElectronWebContentsPort) => ElectronWindowPort | null;

function unauthorized(): never {
  throw new RionBridgeError({
    code: "ELECTRON_IPC_UNAUTHORIZED_SENDER",
    message: "The desktop request did not come from the active Rion Studio window."
  });
}

export class RendererIdentityRegistry {
  readonly #records = new Map<number, RendererRecord>();
  readonly #resolveOwnerWindow: ResolveOwnerWindow;

  constructor(resolveOwnerWindow: ResolveOwnerWindow) {
    this.#resolveOwnerWindow = resolveOwnerWindow;
  }

  registerMainWindow(window: ElectronWindowPort, generation: number): RendererIdentity {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Renderer generation must be a positive safe integer.");
    }
    const contents = window.webContents;
    if (window.isDestroyed() || contents.isDestroyed()) {
      throw new Error("A destroyed Electron window cannot be registered.");
    }
    const existing = this.#records.get(contents.id);
    if (existing && (existing.window !== window || existing.contents !== contents)) {
      throw new Error("The Electron webContents identity is already registered.");
    }
    const identity: RendererIdentity = Object.freeze({
      kind: "main-renderer",
      windowId: window.id,
      webContentsId: contents.id,
      generation
    });
    this.#records.set(contents.id, { identity, window, contents });
    return identity;
  }

  authorize(contents: ElectronWebContentsPort): RendererIdentity {
    const record = this.#records.get(contents.id);
    if (
      !record ||
      record.contents !== contents ||
      record.window.webContents !== contents ||
      record.window.isDestroyed() ||
      contents.isDestroyed() ||
      this.#resolveOwnerWindow(contents) !== record.window
    ) {
      unauthorized();
    }
    return record.identity;
  }

  contentsFor(identity: RendererIdentity): ElectronWebContentsPort | null {
    const record = this.#records.get(identity.webContentsId);
    if (!record || record.identity !== identity) return null;
    try {
      this.authorize(record.contents);
      return record.contents;
    } catch {
      return null;
    }
  }

  release(identity: RendererIdentity): void {
    const record = this.#records.get(identity.webContentsId);
    if (record?.identity === identity) this.#records.delete(identity.webContentsId);
  }
}
