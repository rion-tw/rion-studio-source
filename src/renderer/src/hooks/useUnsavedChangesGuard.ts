import { useCallback, useEffect, useRef } from "react";
import { useBeforeUnload, useBlocker } from "react-router";

import { useConfirmation, type ConfirmationOptions } from "../components/confirmation";
import { useApplicationQuitBlocker } from "../components/applicationQuitGuardRegistry";
import type { RionStudioApi } from "../../../shared/api";

export function useUnsavedChangesGuard(
  enabled: boolean,
  options: ConfirmationOptions,
  isNavigationLocked = false
): () => void {
  const allowNavigationRef = useRef(false);
  const isPromptingRef = useRef(false);
  const confirm = useConfirmation();
  useApplicationQuitBlocker(enabled, isNavigationLocked, options);
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
      if (!(enabled || isNavigationLocked) || allowNavigationRef.current) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";

      if (isNavigationLocked || isPromptingRef.current) {
        return;
      }

      isPromptingRef.current = true;
      void confirm(options)
        .then((confirmed) => {
          if (!confirmed) {
            return;
          }

          allowNavigationRef.current = true;
          const api = (window as Window & {
            rionStudio?: Pick<RionStudioApi, "requestCurrentWindowClose">;
          }).rionStudio;
          if (api) {
            api.requestCurrentWindowClose();
          } else {
            window.close();
          }
        })
        .finally(() => {
          isPromptingRef.current = false;
        });
    }, [confirm, enabled, isNavigationLocked, options])
  );

  return useCallback(() => {
    allowNavigationRef.current = true;
  }, []);
}
