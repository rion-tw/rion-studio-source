import { readFile } from "node:fs/promises";

import type { BaseWindow, Session, WebContents } from "electron";
import type {
  ExtensionPackageRecord,
  ExtensionRoleRecord,
  LogLevel
} from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import {
  recordChromiumExtensionRuntimeDiagnostic,
  type ChromiumExtensionRuntimeStage,
  type ChromiumExtensionRuntimeStatus
} from "./chromiumExtensionRuntimeDiagnostics";
import type { ChromiumRoleSessionHandle } from "./chromiumRoleSessionRegistry";
import type { ChromiumRoleExtensionSurfacePort } from "./chromiumRoleSessionRegistry";
import {
  RionChromeExtensions
} from "../../../third_party/electron-chrome-extensions/src/browser/rion";
import type {
  CompatibilityReadyCallback
} from "../../../third_party/electron-chrome-extensions/src/browser/api/compatibility";

import { ChromiumExtensionBootstrap } from "./chromiumExtensionBootstrap";

const EXTENSION_DEADLINE_MS = 15_000;
const REQUIRED_COMPATIBILITY_APIS = Object.freeze([
  "action",
  "alarms",
  "commands",
  "contextMenus",
  "notifications",
  "offscreen",
  "permissions",
  "storage.session",
  "tabs",
  "webNavigation"
]);
const FATAL_PERMISSIONS = new Set([
  "debugger",
  "enterprise.deviceAttributes",
  "enterprise.hardwarePlatform",
  "enterprise.networkingAttributes",
  "management",
  "nativeMessaging",
  "proxy",
  "vpnProvider"
]);

interface CompatibilityHostPort {
  addTab: (tab: WebContents, window: BaseWindow) => void;
  removeTab: (tab: WebContents) => void;
}

interface ExtensionLoggerPort {
  extensionDiagnostic: (
    level: Extract<LogLevel, "debug" | "info" | "warn" | "error">,
    event: string,
    message: string,
    context: Readonly<Record<string, unknown>>,
    error?: unknown,
    fallbackCode?: string
  ) => void;
}

export interface ChromiumExtensionSessionsInput {
  readonly compatibilityPreloadPath?: string;
  readonly createCompatibilityHost?: (
    session: Session,
    onReady: CompatibilityReadyCallback
  ) => CompatibilityHostPort;
  readonly deadlineMs?: number;
  readonly logger?: ExtensionLoggerPort;
  readonly now?: () => string;
}

interface Entry {
  compatibilityError: string | null;
  handle: ChromiumRoleSessionHandle;
  host: CompatibilityHostPort | null;
  lease: ExtensionRoleRecord | null;
  ready: Promise<void>;
  released: boolean;
  surface: ChromiumRoleExtensionSurfacePort | null;
  surfaceState: "pending" | "registered" | "retired";
}

interface ManifestSummary {
  readonly hasServiceWorker: boolean;
  readonly staticRulesetCount: number;
}

type DeadlineResult<Value> =
  | Readonly<{ status: "completed"; value: Value }>
  | Readonly<{ status: "failed"; error: unknown }>
  | Readonly<{ status: "indeterminate" }>;

function stableErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,95}$/u.test(message) ? message : fallback;
}

async function readManifestSummary(directory: string): Promise<ManifestSummary | null> {
  try {
    const raw = await readFile(`${directory}/manifest.json`, "utf8");
    if (raw.length > 2 * 1024 * 1024) return null;
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    const background = manifest.background;
    const declarative = manifest.declarative_net_request;
    const rules = declarative && typeof declarative === "object"
      ? (declarative as { rule_resources?: unknown }).rule_resources
      : undefined;
    return Object.freeze({
      hasServiceWorker: Boolean(
        background && typeof background === "object" &&
        typeof (background as { service_worker?: unknown }).service_worker === "string"
      ),
      staticRulesetCount: Array.isArray(rules) ? rules.filter(rule =>
        rule && typeof rule === "object" && rule.enabled !== false && typeof rule.id === "string"
      ).length : 0
    });
  } catch {
    return null;
  }
}

/** Native follower: Core alone selects packages and issues each role lease. */
export class ChromiumExtensionSessions {
  readonly #entries = new Map<string, Entry>();
  readonly #pendingUnloads = new Set<(reason: string) => void>();
  #abandoned = false;
  readonly #hosts = new WeakMap<Session, CompatibilityHostPort>();
  readonly #poisonedSessions = new WeakSet<Session>();
  readonly #bootstraps = new WeakMap<
    Session,
    Map<string, ChromiumExtensionBootstrap>
  >();
  readonly #input: ChromiumExtensionSessionsInput;

  constructor(
    private readonly core: ElectronCoreCommandPort,
    input: ChromiumExtensionSessionsInput = {}
  ) {
    this.#input = input;
  }

  prepare = (
    handle: ChromiumRoleSessionHandle,
    surface: ChromiumRoleExtensionSurfacePort | null = null
  ): Promise<void> => {
    const existing = this.#entries.get(handle.roleId);
    if (existing) {
      if (existing.handle !== handle || existing.released) {
        return Promise.reject(new Error("EXTENSIONS_STALE_SESSION"));
      }
      return existing.ready;
    }
    const entry: Entry = {
      compatibilityError: null,
      handle,
      host: null,
      lease: null,
      ready: Promise.resolve(),
      released: false,
      surface,
      surfaceState: surface ? "pending" : "retired"
    };
    this.#entries.set(handle.roleId, entry);
    entry.ready = this.#load(entry);
    return entry.ready;
  };

  async #load(entry: Entry): Promise<void> {
    const { handle } = entry;
    const session = handle.session as Session;
    const native = session.extensions;
    const result = await this.core.invoke({
      type: "extensions",
      command: { type: "acquire", roleId: handle.roleId }
    });
    if (!result.lease) throw new Error("EXTENSIONS_LEASE_MISSING");
    entry.lease = result.lease;
    try {
      if (!native) throw new Error("EXTENSIONS_SESSION_UNSUPPORTED");
      for (const extension of native.getAllExtensions()) {
        await this.#unload(native, extension.id);
      }

      try {
        entry.host = this.#prepareCompatibilityHost(session, entry);
      } catch (error) {
        entry.compatibilityError = stableErrorCode(
          error,
          "ELECTRON_EXTENSION_COMPATIBILITY_HOST_FAILED"
        );
      }
      let degraded = false;
      for (const id of result.lease.extensionIds) {
        if (entry.released) throw new Error("EXTENSIONS_SESSION_RELEASED");
        const packageRecord = result.snapshot.installed.find(
          (candidate) => candidate.id === id && !candidate.removed
        );
        if (!packageRecord) throw new Error("EXTENSIONS_PACKAGE_UNAVAILABLE");
        const outcome = await this.#loadPackage(entry, native, packageRecord);
        degraded ||= outcome === "degraded";
      }
      if (entry.released) throw new Error("EXTENSIONS_SESSION_RELEASED");
      await this.core.invoke({
        type: "extensions",
        command: {
          type: "complete",
          roleId: handle.roleId,
          leaseId: result.lease.leaseId,
          status: degraded ? "degraded" : "loaded"
        }
      });
    } catch (error) {
      await this.core.invoke({
        type: "extensions",
        command: {
          type: "complete",
          roleId: handle.roleId,
          leaseId: result.lease.leaseId,
          status: stableErrorCode(error, "EXTENSIONS_LOAD_FAILED") ===
            "EXTENSIONS_LOAD_INDETERMINATE" ? "indeterminate" : "failed"
        }
      });
      throw error;
    }
  }

  async #loadPackage(
    entry: Entry,
    native: Session["extensions"],
    packageRecord: ExtensionPackageRecord
  ): Promise<"loaded" | "degraded"> {
    if (!Array.isArray(packageRecord.requiredApiPermissions)) {
      this.#record(entry, packageRecord.id, "classification", "degraded",
        "ELECTRON_EXTENSION_PERMISSION_METADATA_UNAVAILABLE");
      return "degraded";
    }
    const blockedPermission = packageRecord.requiredApiPermissions.find((permission) =>
      FATAL_PERMISSIONS.has(permission) || permission.startsWith("enterprise.")
    );
    if (blockedPermission) {
      this.#record(entry, packageRecord.id, "classification", "blocked",
        "ELECTRON_EXTENSION_PERMISSION_BLOCKED", blockedPermission);
      return "degraded";
    }
    if (entry.compatibilityError) {
      this.#record(entry, packageRecord.id, "bootstrap", "degraded",
        entry.compatibilityError);
      return "degraded";
    }

    const manifest = entry.host
      ? await readManifestSummary(packageRecord.directory)
      : null;
    if (entry.host && !manifest) {
      this.#record(entry, packageRecord.id, "classification", "degraded",
        "ELECTRON_EXTENSION_MANIFEST_UNREADABLE");
      return "degraded";
    }
    if (entry.released) throw new Error("EXTENSIONS_SESSION_RELEASED");
    const readiness = manifest?.hasServiceWorker && entry.host
      ? this.#beginBootstrap(entry.handle.session as Session, packageRecord.id)
      : null;
    const loadPromise = (async () => native.loadExtension(packageRecord.directory, {
      allowFileAccess: false
    }))();
    const loaded = await this.#deadline(loadPromise);
    if (loaded.status === "indeterminate") {
      this.#clearBootstrap(entry.handle.session as Session, packageRecord.id);
      this.#record(entry, packageRecord.id, "load", "indeterminate",
        "ELECTRON_EXTENSION_LOAD_INDETERMINATE");
      void loadPromise.then((extension) => this.#unload(native, extension.id)).catch(() => undefined);
      throw new Error("EXTENSIONS_LOAD_INDETERMINATE");
    }
    if (loaded.status === "failed") {
      this.#clearBootstrap(entry.handle.session as Session, packageRecord.id);
      if (readiness?.outcome?.status === "failed") {
        this.#record(entry, packageRecord.id, "bootstrap", "degraded",
          readiness.outcome.code, undefined, readiness.outcome);
      } else {
        this.#record(entry, packageRecord.id, "load", "degraded",
          stableErrorCode(loaded.error, "ELECTRON_EXTENSION_LOAD_FAILED"));
      }
      return "degraded";
    }
    if (loaded.value.id !== packageRecord.id) {
      this.#clearBootstrap(entry.handle.session as Session, packageRecord.id);
      await this.#unload(native, loaded.value.id);
      this.#record(entry, packageRecord.id, "load", "degraded",
        "ELECTRON_EXTENSION_ID_MISMATCH");
      return "degraded";
    }

    if (readiness) {
      readiness.nativeLoaded();
      const bootstrapped = await this.#deadline(readiness.result);
      this.#clearBootstrap(entry.handle.session as Session, packageRecord.id);
      if (bootstrapped.status !== "completed") {
        this.#input.logger?.extensionDiagnostic("warn", "extension_bootstrap_incomplete",
          "The extension bootstrap did not receive every required native acknowledgement.",
          { extensionId: packageRecord.id, roleId: entry.handle.roleId, ...readiness.inspect() });
        await this.#unload(native, packageRecord.id);
        this.#record(entry, packageRecord.id, "bootstrap", "degraded",
          bootstrapped.status === "indeterminate"
            ? "ELECTRON_EXTENSION_BOOTSTRAP_DEADLINE_EXCEEDED"
            : "ELECTRON_EXTENSION_BOOTSTRAP_FAILED");
        return "degraded";
      }
      if (bootstrapped.value.status === "cancelled") {
        await this.#unload(native, packageRecord.id);
        throw new Error(bootstrapped.value.code);
      }
      if (bootstrapped.value.status === "failed") {
        await this.#unload(native, packageRecord.id);
        this.#record(entry, packageRecord.id, "bootstrap", "degraded",
          bootstrapped.value.code, undefined, bootstrapped.value);
        return "degraded";
      }
      const receipt = bootstrapped.value.receipt;
      if (
        REQUIRED_COMPATIBILITY_APIS.some((api) =>
          !receipt.availableApis.includes(api)
        ) ||
        receipt.staticRulesetCount !== manifest?.staticRulesetCount
      ) {
        await this.#unload(native, packageRecord.id);
        this.#record(entry, packageRecord.id, "bootstrap", "degraded",
          "ELECTRON_EXTENSION_COMPATIBILITY_RECEIPT_INVALID");
        return "degraded";
      }
      if (
        manifest && manifest.staticRulesetCount > 0 &&
        receipt.staticRulesetStatus !== "enabled"
      ) {
        await this.#unload(native, packageRecord.id);
        this.#record(entry, packageRecord.id, "rulesets", "degraded",
          "ELECTRON_EXTENSION_STATIC_RULESETS_UNAVAILABLE");
        return "degraded";
      }
    }

    this.#record(entry, packageRecord.id, "bootstrap", "loaded",
      "ELECTRON_EXTENSION_READY");
    return "loaded";
  }

  #prepareCompatibilityHost(
    session: Session,
    entry: Entry
  ): CompatibilityHostPort | null {
    const surface = entry.surface;
    if (entry.released || entry.surfaceState === "retired") return null;
    if (!surface?.window) return null;
    if (this.#poisonedSessions.has(session)) {
      throw new Error("ELECTRON_EXTENSION_COMPATIBILITY_HOST_DISABLED");
    }
    let host = this.#hosts.get(session);
    if (!host) {
      const onReady: CompatibilityReadyCallback = (extensionId, record, versionId) => {
        this.#bootstraps.get(session)?.get(extensionId)?.compatibilityReady(record, versionId);
      };
      if (this.#input.createCompatibilityHost) {
        host = this.#input.createCompatibilityHost(session, onReady);
      } else if (this.#input.compatibilityPreloadPath) {
        host = new RionChromeExtensions({
          license: "GPL-3.0",
          onCompatibilityReady: onReady,
          preloadPath: this.#input.compatibilityPreloadPath,
          requestPermissions: async () => false,
          session
        });
      } else {
        return null;
      }
      this.#hosts.set(session, host);
    }
    host.addTab(surface.contents as WebContents, surface.window as BaseWindow);
    entry.surfaceState = "registered";
    return host;
  }

  retireSurface = (
    handle: ChromiumRoleSessionHandle,
    surface: ChromiumRoleExtensionSurfacePort,
    alreadyDestroyed: boolean
  ): void => {
    const entry = this.#entries.get(handle.roleId);
    if (!entry) return;
    if (entry.handle !== handle) {
      this.#recordSurfaceRetirementFailure(entry, "surface_identity_mismatch");
      return;
    }
    if (entry.surfaceState === "retired") return;
    if (
      entry.surface?.contents !== surface.contents ||
      entry.surface?.window !== surface.window
    ) {
      this.#recordSurfaceRetirementFailure(entry, "surface_identity_mismatch");
      return;
    }
    const registered = entry.surfaceState === "registered";
    const host = entry.host;
    entry.surfaceState = "retired";
    entry.surface = null;
    if (!registered || !host) return;
    if (alreadyDestroyed) {
      this.#disableCompatibilityHost(entry, "surface_already_destroyed");
      return;
    }
    try {
      host.removeTab(surface.contents as WebContents);
    } catch {
      this.#disableCompatibilityHost(entry, "remove_tab_failed");
    }
  };

  #disableCompatibilityHost(entry: Entry, reason: string): void {
    const session = entry.handle.session as Session;
    this.#poisonedSessions.add(session);
    this.#hosts.delete(session);
    this.#cancelBootstraps(session, "ELECTRON_EXTENSION_COMPATIBILITY_TAB_RETIRE_FAILED");
    entry.compatibilityError = "ELECTRON_EXTENSION_COMPATIBILITY_TAB_RETIRE_FAILED";
    this.#recordSurfaceRetirementFailure(entry, reason);
  }

  #recordSurfaceRetirementFailure(entry: Entry, reason: string): void {
    const code = "ELECTRON_EXTENSION_COMPATIBILITY_TAB_RETIRE_FAILED";
    this.#input.logger?.extensionDiagnostic(
      "error",
      "extension_compatibility_tab_retire_failed",
      "The extension compatibility tab could not retire from its live Role surface.",
      {
        code,
        reason,
        roleId: entry.handle.roleId
      },
      new Error(code),
      code
    );
  }

  #beginBootstrap(session: Session, extensionId: string): ChromiumExtensionBootstrap {
    let pending = this.#bootstraps.get(session);
    if (!pending) {
      pending = new Map();
      this.#bootstraps.set(session, pending);
    }
    const bootstrap = new ChromiumExtensionBootstrap(session.serviceWorkers, extensionId);
    pending.set(extensionId, bootstrap);
    return bootstrap;
  }

  #clearBootstrap(session: Session, extensionId: string): void {
    const pending = this.#bootstraps.get(session);
    pending?.get(extensionId)?.cancel();
    pending?.delete(extensionId);
  }

  #cancelBootstraps(session: Session, code: string): void {
    for (const bootstrap of this.#bootstraps.get(session)?.values() ?? []) bootstrap.cancel(code);
    this.#bootstraps.delete(session);
  }

  #deadline<Value>(promise: Promise<Value>): Promise<DeadlineResult<Value>> {
    const duration = this.#input.deadlineMs ?? EXTENSION_DEADLINE_MS;
    // DeadlineBound: an unknown external Chromium load/bootstrap acknowledgement
    // terminalizes as indeterminate; elapsed time is never success.
    return new Promise((resolve) => {
      let settled = false;
      // event-topology-exception: chromium-extension-bootstrap-deadline
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(Object.freeze({ status: "indeterminate" }));
      }, duration);
      promise.then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Object.freeze({ status: "completed", value }));
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Object.freeze({ status: "failed", error }));
      });
    });
  }

  #record(
    entry: Entry,
    extensionId: string,
    stage: ChromiumExtensionRuntimeStage,
    status: ChromiumExtensionRuntimeStatus,
    code: string,
    api?: string,
    location?: { relativeFile?: string; line?: number }
  ): void {
    const record = recordChromiumExtensionRuntimeDiagnostic({
      api,
      relativeFile: location?.relativeFile,
      line: location?.line,
      capturedAt: (this.#input.now ?? (() => new Date().toISOString()))(),
      code,
      extensionId,
      roleId: entry.handle.roleId,
      stage,
      status
    });
    const level = status === "loaded" ? "info" : status === "failed" ? "error" : "warn";
    this.#input.logger?.extensionDiagnostic(
      level,
      "extension_runtime_terminal",
      status === "loaded"
        ? "A Chromium extension reached compatibility readiness."
        : "A Chromium extension reached a non-ready compatibility outcome.",
      { ...record }
    );
  }

  release = async (handle: ChromiumRoleSessionHandle): Promise<void> => {
    const entry = this.#entries.get(handle.roleId);
    if (!entry) return;
    if (entry.handle !== handle) throw new Error("EXTENSIONS_STALE_SESSION");
    entry.released = true;
    this.#cancelBootstraps(handle.session as Session, "EXTENSIONS_SESSION_RELEASED");
    if (entry.surfaceState !== "retired") {
      entry.surfaceState = "retired";
      entry.surface = null;
      this.#disableCompatibilityHost(entry, "surface_retirement_missing");
    }
    // The entry is dropped on every terminal, including failure: retaining a
    // released entry would fail every later prepare() for this role with
    // EXTENSIONS_STALE_SESSION and quarantine the role surface for the session.
    try {
      await entry.ready.catch(() => undefined);
      const native = (handle.session as Session).extensions;
      if (native) {
        for (const extension of native.getAllExtensions()) {
          await this.#unload(native, extension.id);
        }
      }
      if (entry.lease) {
        await this.core.invoke({
          type: "extensions",
          command: {
            type: "release",
            roleId: handle.roleId,
            leaseId: entry.lease.leaseId
          }
        });
      }
    } finally {
      if (this.#entries.get(handle.roleId) === entry) {
        this.#entries.delete(handle.roleId);
      }
    }
  };

  /**
   * Abandons every outstanding native unload wait. This is the actor-stop edge
   * for the EventBound release: the owner has given up on Chromium ever
   * confirming, so the wait must not keep holding the shutdown path. It is an
   * explicit indeterminate terminal, never a synthesized unload confirmation.
   */
  abandonNativeReleases(reason = "EXTENSIONS_RELEASE_ABANDONED"): void {
    this.#abandoned = true;
    for (const abandon of [...this.#pendingUnloads]) abandon(reason);
    this.#pendingUnloads.clear();
  }

  #unload(native: Session["extensions"], id: string): Promise<void> {
    if (this.#abandoned) {
      return Promise.reject(new Error("EXTENSIONS_RELEASE_ABANDONED"));
    }
    // EventBound: the exact extension-unloaded event releases the native
    // resource. Cancellation edge: abandonNativeReleases() terminalizes the
    // wait as indeterminate when the owner stops. Elapsed time never does.
    return new Promise((resolve, reject) => {
      let settled = false;
      const detach = (): void => {
        if (settled) return;
        settled = true;
        native.removeListener("extension-unloaded", listener);
        this.#pendingUnloads.delete(abandon);
      };
      const listener: Parameters<typeof native.on>[1] = (_event, extension) => {
        if (extension.id !== id) return;
        detach();
        resolve();
      };
      const abandon = (reason: string): void => {
        if (settled) return;
        detach();
        reject(new Error(reason));
      };
      this.#pendingUnloads.add(abandon);
      native.on("extension-unloaded", listener);
      try {
        native.removeExtension(id);
      } catch (error) {
        detach();
        reject(error);
      }
    });
  }
}
