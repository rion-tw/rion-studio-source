import type { ElectronBrowserRuntime } from "./ElectronBrowserRuntime";
import type { RuntimeSessionManager } from "./RuntimeSessionManager";

export async function saveRuntimeSessionThenStopAll({
  browserManager,
  onSaveError,
  onStopError,
  sessionManager
}: {
  browserManager: Pick<ElectronBrowserRuntime, "stopAll"> | null;
  onSaveError: (error: unknown) => void;
  onStopError: (error: unknown) => void;
  sessionManager: Pick<RuntimeSessionManager, "flushForQuit"> | null;
}): Promise<void> {
  try {
    await sessionManager?.flushForQuit();
  } catch (error) {
    onSaveError(error);
  }
  try {
    await browserManager?.stopAll();
  } catch (error) {
    onStopError(error);
  }
}
