import { useCallback, useEffect, useRef } from "react";
import { useBeforeUnload, useBlocker } from "react-router";

import { useConfirmation, type ConfirmationOptions } from "../components/confirmation";

export function useUnsavedChangesGuard(
  enabled: boolean,
  options: ConfirmationOptions,
  isNavigationLocked = false
): () => void {
  const allowNavigationRef = useRef(false);
  const isPromptingRef = useRef(false);
  const confirm = useConfirmation();
  const blocker = useBlocker(
    useCallback(
      () => (enabled || isNavigationLocked) && !allowNavigationRef.current,
      [enabled, isNavigationLocked]
    )
  );

  useEffect(() => {
    if (blocker.state !== "blocked" || isPromptingRef.current) {
      return;
    }

    if (isNavigationLocked) {
      blocker.reset();
      return;
    }

    isPromptingRef.current = true;
    void confirm(options)
      .then((confirmed) => {
        if (confirmed) {
          allowNavigationRef.current = true;
          blocker.proceed();
        } else {
          blocker.reset();
        }
      })
      .finally(() => {
        isPromptingRef.current = false;
      });
  }, [blocker, confirm, isNavigationLocked, options]);

  useBeforeUnload(
    useCallback((event) => {
      if ((enabled || isNavigationLocked) && !allowNavigationRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }, [enabled, isNavigationLocked])
  );

  return useCallback(() => {
    allowNavigationRef.current = true;
  }, []);
}
