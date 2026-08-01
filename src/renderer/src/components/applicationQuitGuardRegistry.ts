import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";

import type { ConfirmationOptions } from "./confirmation";

export interface ApplicationQuitBlocker {
  enabled: boolean;
  locked: boolean;
  options: ConfirmationOptions;
}

export type UpdateApplicationQuitBlocker = (
  id: symbol,
  blocker: ApplicationQuitBlocker | null
) => void;

export type RequestGuardedApplicationAction = (
  action: () => Promise<void>
) => Promise<boolean>;

export interface ApplicationQuitGuardApi {
  requestAction: RequestGuardedApplicationAction;
  updateBlocker: UpdateApplicationQuitBlocker;
}

export const ApplicationQuitGuardContext =
  createContext<ApplicationQuitGuardApi | null>(null);

export function useGuardedApplicationAction(): RequestGuardedApplicationAction {
  const guard = useContext(ApplicationQuitGuardContext);
  return useCallback(
    (action: () => Promise<void>) => guard?.requestAction(action) ?? action().then(() => true),
    [guard]
  );
}

export function useApplicationQuitBlocker(
  enabled: boolean,
  locked: boolean,
  options: ConfirmationOptions
): void {
  const guard = useContext(ApplicationQuitGuardContext);
  const idRef = useRef(Symbol("application-quit-blocker"));

  useLayoutEffect(() => {
    if (!guard) {
      return;
    }

    const id = idRef.current;
    guard.updateBlocker(id, { enabled, locked, options });
    return () => guard.updateBlocker(id, null);
  }, [enabled, guard, locked, options]);
}
