import type { BrowserWindow } from "electron";

type RendererWindow = Pick<BrowserWindow, "isDestroyed" | "webContents">;

export function sendToWindowIfAvailable(
  window: RendererWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;

  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch (error) {
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      (error instanceof Error && error.message.includes("Object has been destroyed"))
    ) {
      return false;
    }
    throw error;
  }
}
