import { RionBridgeError } from "../ipc/errors";

/** Early native input must fail explicitly until the Core action lane is wired. */
export function dispatchRuntimeTabShortcut(
  action: "QUICK_ACCESS" | "FULLSCREEN", dispatch: ((tabId: string) => void) | null, tabId: string
): void {
  if (!dispatch) throw new RionBridgeError({
    code: `ELECTRON_CHROMIUM_${action}_NOT_READY`,
    message: `The managed Chromium ${action === "QUICK_ACCESS" ? "Quick Access" : "fullscreen"} lane is not ready.`
  });
  dispatch(tabId);
}
