import type { ChromiumViewParentBinding } from "./chromiumViewAttachmentCoordinator";
import type { WindowsChromiumInputRuntimeParentBinding } from "./windowsChromiumInputSurfaceAttachmentCoordinator";
import type { WindowsRuntimeForegroundProbePort } from "./windowsRuntimeWindowState";

/** Public Electron View ownership plus the existing read-only foreground proof. */
export function windowsChromiumViewParentBinding(
  binding: WindowsChromiumInputRuntimeParentBinding,
  probe: WindowsRuntimeForegroundProbePort,
  focusedWebContentsId: () => number | null
): ChromiumViewParentBinding {
  const window = binding.window;
  return {
    parent: window,
    nativeGeneration: binding.identity.nativeGeneration,
    revision: binding.identity.ownerRevision,
    children: () => window.contentView.children,
    contentsFocused: view => view.webContents.isFocused?.() === true,
    read: () => {
      const native = probe.readWindowsRuntimeForeground(window.getNativeWindowHandle());
      return { parentIdentity: native.parentIdentity, focusIdentity: native.focusIdentity,
        parentForeground: native.parentWasForeground && window.isFocused(),
        parentVisible: native.parentVisible && window.isVisible(), parentMinimized: native.parentMinimized,
        focusedWebContentsId: focusedWebContentsId() };
    },
    subscribe: listener => {
      const subscriptions: Array<() => void> = [];
      const dispose = () => { for (const remove of subscriptions.splice(0)) remove(); };
      try {
        for (const event of ["move", "resize", "show", "hide", "minimize", "restore", "focus", "blur", "closed"] as const) {
          const callback = () => listener(event === "closed" ? "closed" : "changed");
          window.on(event, callback);
          subscriptions.push(() => { window.removeListener(event, callback); });
        }
      } catch (error) { dispose(); throw error; }
      return dispose;
    }
  };
}
