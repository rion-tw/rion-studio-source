import type { Screen } from "electron";

import { normalizeRionBridgeError } from "../ipc/errors";
import { ElectronDisplayTopologyController } from
  "./electronDisplayTopologyController";

/** Installs the event-bound native screen projection and its semantic revision. */
export function startElectronDisplayTopology(
  screen: Pick<Screen, "getAllDisplays" | "getPrimaryDisplay" | "on">,
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void
): ElectronDisplayTopologyController {
  const controller = new ElectronDisplayTopologyController({
    capture: () => ({
      displays: screen.getAllDisplays(),
      primaryDisplayId: screen.getPrimaryDisplay().id
    }),
    onListenerError: (error) => onError(normalizeRionBridgeError(
      error,
      "ELECTRON_DISPLAY_TOPOLOGY_LISTENER_FAILED"
    ))
  });
  controller.refresh("electron-initial");
  const refresh = (cause: string): void => {
    try {
      controller.refresh(cause);
    } catch (error) {
      onError(normalizeRionBridgeError(
        error,
        "ELECTRON_DISPLAY_TOPOLOGY_REFRESH_FAILED"
      ));
    }
  };
  screen.on("display-added", () => refresh("screen-display-added"));
  screen.on("display-removed", () => refresh("screen-display-removed"));
  screen.on("display-metrics-changed", () => {
    refresh("screen-display-metrics-changed");
  });
  return controller;
}
