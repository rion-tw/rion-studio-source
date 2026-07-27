import { useEffect, type JSX } from "react";

import { notifyRendererReadyAfterPaint } from "../app/rendererReady";

export function RendererReadyReporter({
  onFailure
}: {
  onFailure: (error: unknown) => void;
}): JSX.Element | null {
  useEffect(() => {
    if (!window.rionStudio) return;
    return notifyRendererReadyAfterPaint(
      () => window.rionStudio.notifyRendererReady(),
      onFailure
    );
  }, [onFailure]);

  return null;
}
