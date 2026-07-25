import type { PixelBounds } from "../../../shared/types";

export type WebSurfaceLifecycleEvent =
  | { type: "audioChanged"; audible: boolean }
  | { type: "crashed"; reason?: string }
  | { type: "navigationCompleted"; url: string }
  | { type: "navigationFailed"; url: string; errorCode?: string }
  | { type: "popupRequested"; url: string };

/**
 * Engine-neutral lifecycle and page surface contract.
 *
 * This is intentionally smaller than Electron WebContents, WebView2 CoreWebView2,
 * or WKWebView. Platform-only objects must stay inside their adapter.
 */
export interface WebSurfacePort {
  clearStorage: (storageKinds: readonly string[]) => Promise<void>;
  destroy: () => Promise<void>;
  evaluate: <T = unknown>(source: string) => Promise<T>;
  focus: () => Promise<void>;
  loadUrl: (url: string) => Promise<void>;
  onLifecycleEvent: (listener: (event: WebSurfaceLifecycleEvent) => void) => () => void;
  setAudioMuted: (muted: boolean) => Promise<void>;
  setBounds: (bounds: PixelBounds) => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  setZoomFactor: (factor: number) => Promise<void>;
}
