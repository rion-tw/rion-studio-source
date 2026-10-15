import { RionBridgeError } from "../ipc/errors";
import type { RuntimeWindowProjectionProgress } from "./runtimeWindowProjectionFence";

interface RuntimeProjectionPort {
  observeWindowProjection(windowId: string): RuntimeWindowProjectionProgress;
  waitForProjectionAfter(sequence: number): Promise<number>;
  settleCurrentProjection(): Promise<number>;
}

interface NativeEventProgressPort {
  observeWindowEvents(windowId: string): RuntimeWindowProjectionProgress;
}

export function observeChromiumRuntimeWindowProgress(
  runtime: Pick<RuntimeProjectionPort, "observeWindowProjection"> | null,
  nativeEvents: NativeEventProgressPort | undefined,
  windowId: string
): RuntimeWindowProjectionProgress {
  const projection = runtime?.observeWindowProjection(windowId);
  let events: RuntimeWindowProjectionProgress | undefined;
  try {
    events = nativeEvents?.observeWindowEvents(windowId);
  } catch (error) {
    projection?.dispose();
    throw error;
  }
  return Object.freeze({
    readSequence: () => (projection?.readSequence() ?? 0) + (events?.readSequence() ?? 0),
    dispose: () => {
      try { events?.dispose(); } finally { projection?.dispose(); }
    }
  });
}

export async function waitForChromiumRuntimeProjection(
  runtime: Pick<RuntimeProjectionPort, "waitForProjectionAfter" | "settleCurrentProjection"> | null,
  afterSequence: number
): Promise<number> {
  if (!runtime) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
      message: "The Chromium runtime cannot await its next native projection."
    });
  }
  await runtime.waitForProjectionAfter(afterSequence);
  return runtime.settleCurrentProjection();
}
