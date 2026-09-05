import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";

import type { ConfirmationOptions } from "./confirmation";

export interface ApplicationQuitBlocker {
  allowTerminalAction: () => void;
  enabled: boolean;
  locked: boolean;
  options: ConfirmationOptions;
  restoreAfterTerminalActionFailure: () => void;
}

export type UpdateApplicationQuitBlocker = (
  id: symbol,
  blocker: ApplicationQuitBlocker | null
) => void;

export type RequestGuardedApplicationAction = (
  action: () => Promise<unknown>
) => Promise<boolean>;

interface ApplicationQuitGuardApi {
  requestAction: RequestGuardedApplicationAction;
  updateBlocker: UpdateApplicationQuitBlocker;
}

export const ApplicationQuitGuardContext =
  createContext<ApplicationQuitGuardApi | null>(null);

export function useGuardedApplicationAction(): RequestGuardedApplicationAction {
  const guard = useContext(ApplicationQuitGuardContext);
  return useCallback(
    (action: () => Promise<unknown>) => guard?.requestAction(action) ?? action().then(() => true),
    [guard]
  );
}

export function useApplicationQuitBlocker(
  enabled: boolean,
  locked: boolean,
  options: ConfirmationOptions,
  allowTerminalAction: () => void,
  restoreAfterTerminalActionFailure: () => void
): void {
  const guard = useContext(ApplicationQuitGuardContext);
  const idRef = useRef(Symbol("application-quit-blocker"));

  useLayoutEffect(() => {
    if (!guard) {
      return;
    }

    const id = idRef.current;
    guard.updateBlocker(id, {
      allowTerminalAction,
      enabled,
      locked,
      options,
      restoreAfterTerminalActionFailure
    });
    return () => guard.updateBlocker(id, null);
  }, [
    allowTerminalAction,
    enabled,
    guard,
    locked,
    options,
    restoreAfterTerminalActionFailure
  ]);
}
