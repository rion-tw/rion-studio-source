import { createContext, useContext, useLayoutEffect, useRef } from "react";

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

export const ApplicationQuitGuardContext =
  createContext<UpdateApplicationQuitBlocker | null>(null);

export function useApplicationQuitBlocker(
  enabled: boolean,
  locked: boolean,
  options: ConfirmationOptions
): void {
  const updateBlocker = useContext(ApplicationQuitGuardContext);
  const idRef = useRef(Symbol("application-quit-blocker"));

  useLayoutEffect(() => {
    if (!updateBlocker) {
      return;
    }

    const id = idRef.current;
    updateBlocker(id, { enabled, locked, options });
    return () => updateBlocker(id, null);
  }, [enabled, locked, options, updateBlocker]);
}
