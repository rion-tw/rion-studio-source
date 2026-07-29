import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { useConfirmation } from "./confirmation";
import {
  ApplicationQuitGuardContext,
  type ApplicationQuitBlocker,
  type UpdateApplicationQuitBlocker
} from "./applicationQuitGuardRegistry";

export function ApplicationQuitGuardProvider({ children }: { children: ReactNode }): JSX.Element {
  const blockersRef = useRef(new Map<symbol, ApplicationQuitBlocker>());
  const quitRequestedRef = useRef(false);
  const promptingRef = useRef(false);
  const [revision, setRevision] = useState(0);
  const confirm = useConfirmation();

  const updateBlocker = useCallback<UpdateApplicationQuitBlocker>((id, blocker) => {
    if (blocker) {
      blockersRef.current.set(id, blocker);
    } else {
      blockersRef.current.delete(id);
    }
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    const api = window.rionStudio;
    if (!api?.onApplicationQuitRequested) {
      return;
    }

    return api.onApplicationQuitRequested(() => {
      quitRequestedRef.current = true;
      setRevision((current) => current + 1);
    });
  }, []);

  useEffect(() => {
    if (!quitRequestedRef.current || promptingRef.current) {
      return;
    }

    const blockers = [...blockersRef.current.values()];
    if (blockers.some((blocker) => blocker.locked)) {
      return;
    }

    const dirtyBlocker = blockers.find((blocker) => blocker.enabled);
    if (!dirtyBlocker) {
      quitRequestedRef.current = false;
      void window.rionStudio.confirmApplicationQuit();
      return;
    }

    promptingRef.current = true;
    void confirm(dirtyBlocker.options)
      .then((confirmed) => {
        quitRequestedRef.current = false;
        if (confirmed) {
          return window.rionStudio.confirmApplicationQuit();
        }
        return undefined;
      })
      .finally(() => {
        promptingRef.current = false;
      });
  }, [confirm, revision]);

  return (
    <ApplicationQuitGuardContext.Provider value={updateBlocker}>
      {children}
    </ApplicationQuitGuardContext.Provider>
  );
}
