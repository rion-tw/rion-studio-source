import { useEffect, useMemo, useState } from "react";

import type { ApplicationLifecycleStatusRecord } from "../../../shared/generated";

interface UseApplicationLifecycleOptions {
  enabled: boolean;
  onError?: (error: unknown) => void;
}

export function isApplicationLifecycleInputAvailable(
  status: ApplicationLifecycleStatusRecord | null
): boolean {
  return status?.state === "active" || status?.state === "degraded";
}

export function useApplicationLifecycle({
  enabled,
  onError
}: UseApplicationLifecycleOptions) {
  const [status, setStatus] = useState<ApplicationLifecycleStatusRecord | null>(null);
  const bridgeSupportsLifecycle = Boolean(
    enabled
      && window.rionStudio
      && typeof window.rionStudio.getApplicationLifecycleStatus === "function"
      && typeof window.rionStudio.onApplicationLifecycleChanged === "function"
  );

  useEffect(() => {
    if (!bridgeSupportsLifecycle || !window.rionStudio) {
      setStatus(null);
      return;
    }
    let disposed = false;
    const commit = (next: ApplicationLifecycleStatusRecord): void => {
      if (disposed) return;
      setStatus((current) => current && current.revision >= next.revision ? current : next);
    };
    const unsubscribe = window.rionStudio.onApplicationLifecycleChanged(commit);
    void window.rionStudio.getApplicationLifecycleStatus().then(commit).catch(onError);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridgeSupportsLifecycle, onError]);

  return useMemo(() => ({
    inputAvailable: !bridgeSupportsLifecycle || isApplicationLifecycleInputAvailable(status),
    status
  }), [bridgeSupportsLifecycle, status]);
}
