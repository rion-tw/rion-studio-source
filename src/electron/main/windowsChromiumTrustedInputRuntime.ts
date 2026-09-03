import type { EngineCapabilitySnapshotRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeTrustedInputPort } from
  "./chromiumRuntimeEffectExecutor";
import {
  ChromiumTrustedInputCoordinator,
  type ChromiumTrustedInputRecoveryProof,
  type ChromiumTrustedInputSurfacePort
} from "./chromiumTrustedInputCoordinator";
import {
  WindowsChromiumInputSurfaceAttachmentCoordinator,
  type RawWindowsChromiumTrustedInputAddon,
  type WindowsChromiumInputBaseWindowFactoryPort,
  type WindowsChromiumInputRuntimeParentResolverPort
} from "./windowsChromiumInputSurfaceAttachmentCoordinator";
import {
  WindowsChromiumTrustedInputAdapter,
  type WindowsChromiumTrustedInputDeadlinePort,
  type WindowsChromiumTrustedInputIpcMainPort
} from "./windowsChromiumTrustedInputAdapter";
import type {
  WindowsChromiumTrustedInputClickResolverPort,
  WindowsChromiumTrustedInputSurfacePort
} from "./windowsChromiumTrustedInputContract";

export interface WindowsChromiumTrustedInputRuntimeSurfacePort
  extends WindowsChromiumTrustedInputSurfacePort {
  resolveInputSurface: ChromiumTrustedInputSurfacePort["resolveInputSurface"];
  resolveTrustedInputClick:
    WindowsChromiumTrustedInputClickResolverPort["resolve"];
}

export interface WindowsChromiumTrustedInputRuntimeConfiguration {
  readonly addon: RawWindowsChromiumTrustedInputAddon;
  readonly baseWindows: WindowsChromiumInputBaseWindowFactoryPort;
  readonly deadlines: WindowsChromiumTrustedInputDeadlinePort;
  readonly ipcMain: WindowsChromiumTrustedInputIpcMainPort;
}

export interface WindowsChromiumTrustedInputRuntimeAdapter {
  readonly nativeAttachments: WindowsChromiumInputSurfaceAttachmentCoordinator;
  createTrustedInput: (
    surfaces: WindowsChromiumTrustedInputRuntimeSurfacePort,
    preflightAutomaticInputContext?: (
      roleId: string,
      surfaceGeneration: number
    ) => void | Promise<void>,
    onRecoveryProof?: (proof: ChromiumTrustedInputRecoveryProof) => void
  ) => ChromiumRuntimeTrustedInputPort;
  dispose: () => Promise<void>;
}

function runtimeError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

/** Composes exact foreground and same-runtime-window hidden-role trusted input. */
export function createWindowsChromiumTrustedInputRuntime(input: Readonly<{
  capabilities: Pick<
    EngineCapabilitySnapshotRecord,
    "trustedInput" | "backgroundInput"
  >;
  configuration?: WindowsChromiumTrustedInputRuntimeConfiguration;
  nowMs: () => number;
  onError: (error: RionBridgeError) => void;
  parents: WindowsChromiumInputRuntimeParentResolverPort;
}>): WindowsChromiumTrustedInputRuntimeAdapter | null {
  const trustedSupported = input.capabilities.trustedInput === "supported";
  const backgroundSupported = input.capabilities.backgroundInput === "supported";
  if (!trustedSupported && !backgroundSupported) return null;
  if (!trustedSupported) {
    throw runtimeError(
      "ELECTRON_WINDOWS_INPUT_CAPABILITY_INCONSISTENT",
      "Windows Chromium background input cannot be enabled without trusted input."
    );
  }
  if (!input.configuration) {
    throw runtimeError(
      "ELECTRON_WINDOWS_INPUT_RUNTIME_MISSING",
      "Supported Windows input requires its exact BaseWindow and Win32 addon lane."
    );
  }
  const configuration = input.configuration;

  const attachments = new WindowsChromiumInputSurfaceAttachmentCoordinator({
    addon: configuration.addon,
    baseWindows: configuration.baseWindows,
    deadlines: configuration.deadlines,
    nowMs: input.nowMs,
    parents: input.parents,
    onError: input.onError
  });
  let created = false;
  let disposed = false;

  return Object.freeze({
    nativeAttachments: attachments,
    createTrustedInput: (
      surfaces: WindowsChromiumTrustedInputRuntimeSurfacePort,
      preflightAutomaticInputContext: (
        roleId: string,
        surfaceGeneration: number
      ) => void | Promise<void> = () => undefined,
      onRecoveryProof?: (proof: ChromiumTrustedInputRecoveryProof) => void
    ) => {
      if (created || disposed) {
        throw runtimeError(
          "ELECTRON_WINDOWS_INPUT_RUNTIME_CONFLICT",
          "The Windows trusted-input runtime cannot be created twice or after disposal."
        );
      }
      created = true;
      const native = new WindowsChromiumTrustedInputAdapter({
        hosts: attachments,
        surfaces,
        clicks: {
          resolve: (request, frame) =>
            surfaces.resolveTrustedInputClick(request, frame)
        },
        nowMs: input.nowMs,
        deadlines: configuration.deadlines,
        backgroundSupported
      });
      try {
        native.register(configuration.ipcMain);
      } catch (error) {
        native.dispose();
        throw error;
      }
      const coordinator = new ChromiumTrustedInputCoordinator({
        native,
        surfaces,
        nowMs: input.nowMs,
        preflightAutomaticInputContext,
        ...(onRecoveryProof ? { onRecoveryProof } : {})
      });
      return Object.freeze({
        execute: (
          request: Parameters<ChromiumRuntimeTrustedInputPort["execute"]>[0]
        ) => coordinator.execute(request),
        retireSurface: (roleId: string, generation: number) =>
          coordinator.retireSurface(roleId, generation),
        retireSurfaceForDestruction: (roleId: string, generation: number) =>
          coordinator.retireSurfaceForDestruction(roleId, generation),
        resumeAfterDocumentReplacement: (roleId: string, generation: number) =>
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
          if (disposed) return;
          disposed = true;
          try {
            await coordinator.dispose();
          } finally {
            native.dispose();
            await attachments.dispose();
          }
        }
      } satisfies ChromiumRuntimeTrustedInputPort);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await attachments.dispose();
    }
  });
}
