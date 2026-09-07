import type { Session } from "electron";
import type { ExtensionRoleRecord } from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ChromiumRoleSessionHandle } from "./chromiumRoleSessionRegistry";

interface Entry {
  handle: ChromiumRoleSessionHandle;
  lease: ExtensionRoleRecord | null;
  ready: Promise<void>;
  released: boolean;
}

/** Native follower: Core alone selects packages and issues each role lease. */
export class ChromiumExtensionSessions {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly core: ElectronCoreCommandPort) {}

  prepare = (handle: ChromiumRoleSessionHandle): Promise<void> => {
    const existing = this.#entries.get(handle.roleId);
    if (existing) {
      if (existing.handle !== handle || existing.released) return Promise.reject(new Error("EXTENSIONS_STALE_SESSION"));
      return existing.ready;
    }
    const entry: Entry = { handle, lease: null, ready: Promise.resolve(), released: false };
    this.#entries.set(handle.roleId, entry);
    entry.ready = this.#load(entry);
    return entry.ready;
  };

  async #load(entry: Entry): Promise<void> {
    const { handle } = entry;
    const native = (handle.session as Session).extensions;
    const result = await this.core.invoke({ type: "extensions", command: { type: "acquire", roleId: handle.roleId } });
    if (!result.lease) throw new Error("EXTENSIONS_LEASE_MISSING");
    entry.lease = result.lease;
    try {
      if (!native) throw new Error("EXTENSIONS_SESSION_UNSUPPORTED");
      // Native Session identities may survive a role closing; never retain a prior configuration.
      for (const extension of native.getAllExtensions()) await this.#unload(native, extension.id);
      for (const id of result.lease.extensionIds) {
        if (entry.released) throw new Error("EXTENSIONS_SESSION_RELEASED");
        const packageRecord = result.snapshot.installed.find(p => p.id === id && !p.removed);
        if (!packageRecord) throw new Error("EXTENSIONS_PACKAGE_UNAVAILABLE");
        const extension = await native.loadExtension(packageRecord.directory, { allowFileAccess: false });
        if (extension.id !== id) throw new Error("EXTENSIONS_ID_MISMATCH");
      }
      if (entry.released) throw new Error("EXTENSIONS_SESSION_RELEASED");
      await this.core.invoke({ type: "extensions", command: {
        type: "complete", roleId: handle.roleId, leaseId: result.lease.leaseId, status: "loaded"
      } });
    } catch (error) {
      await this.core.invoke({ type: "extensions", command: {
        type: "complete", roleId: handle.roleId, leaseId: result.lease.leaseId, status: "failed"
      } });
      throw error;
    }
  }

  release = async (handle: ChromiumRoleSessionHandle): Promise<void> => {
    const entry = this.#entries.get(handle.roleId);
    if (!entry) return;
    if (entry.handle !== handle) throw new Error("EXTENSIONS_STALE_SESSION");
    entry.released = true;
    await entry.ready.catch(() => undefined);
    const native = (handle.session as Session).extensions;
    if (native) for (const extension of native.getAllExtensions()) await this.#unload(native, extension.id);
    if (entry.lease) await this.core.invoke({ type: "extensions", command: {
      type: "release", roleId: handle.roleId, leaseId: entry.lease.leaseId
    } });
    this.#entries.delete(handle.roleId);
  };

  #unload(native: Session["extensions"], id: string): Promise<void> {
    // EventBound: the exact extension-unloaded event releases the native resource.
    return new Promise((resolve, reject) => {
      const listener: Parameters<typeof native.on>[1] = (_event, extension) => {
        if (extension.id !== id) return;
        native.removeListener("extension-unloaded", listener);
        resolve();
      };
      native.on("extension-unloaded", listener);
      try { native.removeExtension(id); }
      catch (error) { native.removeListener("extension-unloaded", listener); reject(error); }
    });
  }
}
