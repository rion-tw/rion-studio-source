import type { RuntimeHostWebContentsEventMap } from "./windowsRuntimeHostNativePorts";
import type { WindowsRuntimeHostChromeController } from "./windowsRuntimeHostChromeController";

/** Native View boundaries need not dispatch pointerleave to the host DOM toolbar. */
export function windowsRuntimePointerLeave(
  chrome: WindowsRuntimeHostChromeController,
  isCurrent: () => boolean,
  onError: (error: unknown) => void
): RuntimeHostWebContentsEventMap["before-mouse-event"] {
  return (_event, input) => {
    if (input.type !== "mouseLeave") return;
    void chrome.nativePointerLeft(isCurrent).catch(onError);
  };
}
