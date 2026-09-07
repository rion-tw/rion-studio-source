import type { CoreRendererEventBridgeInput } from "./coreRendererEventBridge";
import type { RendererIdentity } from "./rendererIdentity";
import type { RionIpcBridgeRegistration } from "./registerIpcBridge";

export function coreRendererPublishers(bridge: () => RionIpcBridgeRegistration | null, identity: () => RendererIdentity | null): Pick<CoreRendererEventBridgeInput,
  "publishAppSnapshot" | "publishExtensions" | "publishLogEntry" | "publishChromeProfileImportProgress" | "publishSessionMigrationRecovery"> {
  const publish: RionIpcBridgeRegistration["publish"] = (_identity, method, ...payload) => bridge()?.publish(_identity, method, ...payload) ?? false;
  return {
    publishAppSnapshot: value => { const target = identity(); if (target) publish(target, "onAppSnapshotChanged", value); },
    publishExtensions: value => { const target = identity(); if (target) publish(target, "onExtensionsChanged", value); },
    publishLogEntry: value => { const target = identity(); if (target) publish(target, "onLogEntryAdded", value); },
    publishChromeProfileImportProgress: value => { const target = identity(); if (target) publish(target, "onChromeProfileImportProgress", value); },
    publishSessionMigrationRecovery: value => { const target = identity(); if (target) publish(target, "onSessionMigrationRecovery", value); }
  };
}
