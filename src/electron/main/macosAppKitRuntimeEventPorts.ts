import { RionBridgeError } from "../ipc/errors";
import type { AppKitRuntimeHostObservationRecord } from "../../shared/generated";
import type { MacosAppKitRuntimeHostFactoryPort } from "./chromiumRuntimeHostFactory";
import type { MacosAppKitInputSurfaceAttachmentCoordinator } from "./macosAppKitInputSurfaceAttachmentCoordinator";

export async function capturePassiveAppKitHosts(factory: MacosAppKitRuntimeHostFactoryPort | null,
  captured: readonly AppKitRuntimeHostObservationRecord[]) {
  if (!factory) throw new RionBridgeError({ code: "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE",
    message: "The AppKit event host is unavailable." });
  return factory.captureHostObservations(captured.map(host => host.identity.logicalWindowId));
}

export function closeAppKitInputHost(attachments: MacosAppKitInputSurfaceAttachmentCoordinator | null,
  binding: Parameters<MacosAppKitInputSurfaceAttachmentCoordinator["closeHost"]>[0]) {
  if (!attachments) return Promise.reject(new RionBridgeError({ code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_UNAVAILABLE",
    message: "The AppKit input host is unavailable." }));
  return attachments.closeHost(binding);
}
