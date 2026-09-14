import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { WorkspaceResizeIndicatorRecord } from "../../shared/generated";

export interface WorkspaceResizeIndicatorPort {
  update: (indicators: readonly WorkspaceResizeIndicatorRecord[]) => void;
}

/** A local, non-focusable native child paints above Chromium child Views. */
export function createWindowsWorkspaceResizeIndicators(
  parent: BrowserWindow,
  create: (options: BrowserWindowConstructorOptions) => BrowserWindow,
  onError: (error: unknown) => void
): WorkspaceResizeIndicatorPort {
  let overlay: BrowserWindow | null = null;
  let ready = false;
  let version = 0;
  let desired: readonly WorkspaceResizeIndicatorRecord[] = [];
  const paint = (): void => {
    const host = overlay;
    const revision = version;
    if (!host || !ready || host.isDestroyed() || parent.isDestroyed()) return;
    if (desired.length === 0 || !parent.isVisible() || parent.isMinimized()) {
      host.hide();
      return;
    }
    host.setBounds(parent.getContentBounds());
    // This fixed script runs only in the private script-free local document.
    const script = `document.body.replaceChildren(...${JSON.stringify(desired)}.map(item => {
      const label = document.createElement('div');
      label.textContent = item.label;
      label.setAttribute('role', 'status');
      label.style.cssText = 'position:absolute;box-sizing:border-box;height:28px;line-height:26px;padding:0 10px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:rgba(18,22,31,.94);color:#fafafa;font:600 12px/26px system-ui;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-align:center;transform:translateX(-50%)';
      label.style.left = (item.bounds.x + item.bounds.width / 2) + 'px';
      label.style.top = (item.bounds.y + Math.min(16, Math.max(0, item.bounds.height - 28))) + 'px';
      label.style.maxWidth = item.bounds.width + 'px';
      return label;
    }));`;
    void host.webContents.executeJavaScript(script).then(() => {
      if (version === revision && desired.length > 0 && !host.isDestroyed() &&
          !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()) host.showInactive();
    }, onError);
  };
  parent.on("hide", () => { version += 1; desired = []; overlay?.hide(); });
  parent.on("closed", () => {
    version += 1;
    desired = [];
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null;
  });
  return {
    update: (indicators) => {
      version += 1;
      desired = indicators;
      if (parent.isDestroyed()) return;
      if (indicators.length === 0) { if (overlay && !overlay.isDestroyed()) overlay.hide(); return; }
      if (!overlay) {
        overlay = create({ parent, show: false, frame: false, transparent: true,
          focusable: false, skipTaskbar: true, hasShadow: false, resizable: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
            partition: "rion-workspace-resize-indicators" } });
        overlay.setIgnoreMouseEvents(true);
        overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        overlay.webContents.on("will-navigate", (event) => event.preventDefault());
        overlay.webContents.once("did-finish-load", () => { ready = true; paint(); });
        const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>:root{color-scheme:light dark}body{margin:0;overflow:hidden;pointer-events:none}</style><body>';
        void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(onError);
      }
      paint();
    }
  };
}

export function createWindowsRuntimeWindows(
  Window: new (options: BrowserWindowConstructorOptions) => BrowserWindow,
  icon: string | undefined,
  onError: (error: unknown) => void
): import("./windowsRuntimeHostNativePorts").WindowsBrowserWindowFactoryPort {
  return {
    create: (options) => new Window({ ...options, ...(icon ? { icon } : {}) }) as unknown as
      import("./windowsRuntimeHostNativePorts").WindowsRuntimeHostWindowPort,
    createResizeIndicators: (parent) => createWindowsWorkspaceResizeIndicators(
      parent as unknown as BrowserWindow, (options) => new Window(options), onError)
  };
}
