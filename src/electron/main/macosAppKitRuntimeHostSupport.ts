import type {
  AppKitRuntimeHostObservationRecord,
  AppKitRuntimeTabProjectionRecord,
  CoreErrorPayload,
  EmbeddedTabEffectRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  MacosAppKitInputHostBinding,
  RawNativeAppKitInputSurfaceHost
} from
  "./macosAppKitInputSurfaceAttachmentCoordinator";
import type {
  AppKitRuntimeActionEvent,
  AppKitRuntimeHostIdentity,
  AppKitRuntimeLayoutEvent,
  MacosAppKitBaseWindowFactoryPort,
  MacosAppKitDisplayResolverPort,
  RawAppKitRuntimeAddon,
  RawNativeAppKitRuntimeHost
} from "./macosAppKitRuntimePorts";

export interface MacosAppKitRuntimeHostFactoryInput {
  readonly addon: RawAppKitRuntimeAddon;
  readonly displays: MacosAppKitDisplayResolverPort;
  readonly lifecycleEpoch?: () => number;
  readonly windows: MacosAppKitBaseWindowFactoryPort;
  readonly onAction: (event: AppKitRuntimeActionEvent) => void;
  readonly onCloseRequested: (
    identity: AppKitRuntimeHostIdentity,
    hosts: readonly AppKitRuntimeHostObservationRecord[]
  ) => void;
  readonly onError: (error: CoreErrorPayload) => void;
  readonly onHostClosing?: (
    binding: MacosAppKitInputHostBinding
  ) => Promise<void>;
  readonly onLayout?: (event: AppKitRuntimeLayoutEvent) => void;
}

export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function hostError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function fail(code: string, message: string): never {
  throw hostError(code, message);
}

export function supportsNativeInputSurface(
  controller: RawNativeAppKitRuntimeHost
): controller is RawNativeAppKitRuntimeHost & RawNativeAppKitInputSurfaceHost {
  const candidate = controller as unknown as Record<string, unknown>;
  return typeof candidate.beginInputSurfaceCapture === "function" &&
    typeof candidate.commitInputSurfaceCapture === "function" &&
    typeof candidate.cancelInputSurfaceCapture === "function" &&
    typeof candidate.retireInputSurface === "function";
}

export function supportsWorkspaceDividerProjection(
  controller: RawNativeAppKitRuntimeHost
): boolean {
  const candidate = controller as unknown as Record<string, unknown>;
  return typeof candidate.applyWorkspaceDividerProjection === "function" &&
    typeof candidate.restoreLastVerifiedWorkspaceDividerProjection === "function";
}

export function tabProjection(
  tab: EmbeddedTabEffectRecord
): AppKitRuntimeTabProjectionRecord {
  return Object.freeze({
    tabId: tab.tabId,
    name: tab.name,
    phase: "activating",
    tabType: tab.workspaceId === undefined ? "role" : "workspace",
    ...(tab.workspaceTemplate === undefined
      ? {}
      : { workspaceTemplate: tab.workspaceTemplate }),
    audioMuted: tab.audioMuted
  });
}

export function sameAppKitTabProjection(
  left: ReadonlyMap<string, AppKitRuntimeTabProjectionRecord>,
  right: ReadonlyMap<string, AppKitRuntimeTabProjectionRecord>
): boolean {
  if (left.size !== right.size) return false;
  const leftEntries = [...left];
  const rightEntries = [...right];
  return leftEntries.every(([leftId, leftTab], index) => {
    const rightEntry = rightEntries[index];
    if (!rightEntry) return false;
    const [rightId, rightTab] = rightEntry;
    return leftId === rightId && leftTab.tabId === rightTab.tabId &&
      leftTab.name === rightTab.name && leftTab.phase === rightTab.phase &&
      leftTab.tabType === rightTab.tabType &&
      leftTab.workspaceTemplate === rightTab.workspaceTemplate &&
      leftTab.audioMuted === rightTab.audioMuted;
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
