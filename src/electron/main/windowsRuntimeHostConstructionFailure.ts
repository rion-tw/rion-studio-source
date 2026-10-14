import { RionBridgeError } from "../ipc/errors";
import type { WindowsRuntimeHostWindowPort } from "./windowsRuntimeHostNativePorts";

/** Retires only this unadmitted native object, from its exact closed event. */
export function retireFailedWindowsRuntimeHostConstruction(input: Readonly<{
  native: WindowsRuntimeHostWindowPort;
  nativeId: number;
  nativeHandle: Buffer;
  error: unknown;
  isOwned: () => boolean;
}>): Promise<never> {
  const { native } = input;
  if (native.isDestroyed()) return Promise.reject(input.error);
  return new Promise<never>((_resolve, reject) => {
    let settled = false;
    const finish = (error: unknown): void => {
      if (settled) return;
      settled = true;
      native.removeListener("closed", closed);
      reject(error);
    };
    const failure = (code: string, message: string): void =>
      finish(new RionBridgeError({ code, message }));
    const closed = (): void => {
      if (!native.isDestroyed()) {
        failure("ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_READBACK_STALE",
          "The failed native host closed without acknowledging its destruction.");
      } else finish(input.error);
    };
    native.on("closed", closed);
    try {
      if (input.isOwned() || native.id !== input.nativeId ||
          !native.getNativeWindowHandle().equals(input.nativeHandle) || input.isOwned()) {
        failure("ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_FENCE_STALE",
          "The failed constructor no longer owns one exact unadmitted native host.");
        return;
      }
    } catch {
      failure("ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_FENCE_STALE",
        "The failed constructor could not verify its exact unadmitted native host.");
      return;
    }
    try { native.destroy(); }
    catch {
      failure("ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_SUBMISSION_FAILED",
        "Electron could not retire the exact failed native host.");
    }
  });
}
