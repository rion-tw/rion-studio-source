import { useCallback, useRef, useState } from "react";

import { BusyIdTracker } from "../app/operationState";

export function useBusyIds() {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const trackerRef = useRef<BusyIdTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new BusyIdTracker(setBusyIds);
  }

  const beginBusy = useCallback((id: string): (() => void) | undefined => {
    return trackerRef.current?.begin(id);
  }, []);

  return { beginBusy, busyIds };
}
