import type { IpcMain } from "electron";

import type { LoadedRionNodeAddon } from "./electronCoreBootstrap";
import { ChromiumCdpInputTransport } from "./chromiumCdpInputTransport";
import type { MacosAppKitRuntimeBootstrapAdapter } from "./chromiumRuntimeBootstrap";
import { ChromiumTrustedInputCoordinator } from "./chromiumTrustedInputCoordinator";
import type { MacosAppKitInputSurfaceAttachmentCoordinator } from
  "./macosAppKitInputSurfaceAttachmentCoordinator";
import { MacosAppKitTrustedInputAdapter } from "./macosAppKitTrustedInputAdapter";

type CreateTrustedInput = NonNullable<MacosAppKitRuntimeBootstrapAdapter["createTrustedInput"]>;
type CreateTrustedInputArguments = Parameters<CreateTrustedInput>;

/** Composes AppKit-native trusted input with in-process CDP submission. */
export function createMacosAppKitTrustedInput(input: Readonly<{
  addon: LoadedRionNodeAddon;
  attachments: MacosAppKitInputSurfaceAttachmentCoordinator;
  ipcMain: IpcMain;
  surfaces: CreateTrustedInputArguments[0];
  onRecoveryProof: CreateTrustedInputArguments[2];
  embeddedInput: CreateTrustedInputArguments[3];
}>): ReturnType<CreateTrustedInput> {
  const { addon, attachments, surfaces, onRecoveryProof, embeddedInput } = input;
  const cdp = new ChromiumCdpInputTransport({ platform: "darwin", surfaces });
  const native = new MacosAppKitTrustedInputAdapter({
    hosts: {
      resolve: (roleId, generation) => {
        const binding = attachments.resolveOwnedInputHost(roleId, generation);
        return binding ? Object.freeze({ identity: binding.identity,
          native: binding.native }) : null;
      }
    },
    surfaces,
    cdp,
    clicks: { resolve: (request, frame) =>
      surfaces.resolveTrustedInputClick(request, frame) },
    nowMs: addon.macroInputEpochMillis,
    compatibility: surfaces
  });
  const disposeInput = () => { try { native.dispose(); } finally { cdp.dispose(); } };
  try {
    native.register(input.ipcMain);
  } catch (error) { disposeInput(); throw error; }
  const coordinator = new ChromiumTrustedInputCoordinator({
    native,
    surfaces,
    embeddedInput,
    platform: "darwin",
    nowMs: addon.macroInputEpochMillis,
    onRecoveryProof
  });
  return {
    execute: (request) => coordinator.execute(request),
    observeMacroKey: coordinator.observeMacroKey.bind(coordinator),
    retireSurface: coordinator.retireSurface.bind(coordinator),
    retireSurfaceForDestruction: coordinator.retireSurfaceForDestruction.bind(coordinator),
    resumeAfterDocumentReplacement: (roleId, generation) =>
      coordinator.resumeAfterDocumentReplacement(roleId, generation),
    prepareControlledDocumentReplacement: (lease) =>
      coordinator.prepareControlledDocumentReplacement(lease),
    confirmControlledDocumentReplacementNeutral: (lease) =>
      coordinator.confirmControlledDocumentReplacementNeutral(lease),
    resumeControlledDocumentReplacement: (lease, nextDocumentInstanceId) =>
      coordinator.resumeControlledDocumentReplacement(
        lease,
        nextDocumentInstanceId
      ),
    supersedeControlledDocumentReplacement: (lease, submitted) =>
      coordinator.supersedeControlledDocumentReplacement(lease, submitted),
    dispose: async () => {
      try { await coordinator.dispose(); } finally { disposeInput(); }
    }
  };
}
