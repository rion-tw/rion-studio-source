import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { useConfirmation } from "./confirmation";
import {
  ApplicationQuitGuardContext,
  type ApplicationQuitBlocker,
  type RequestGuardedApplicationAction,
  type UpdateApplicationQuitBlocker
} from "./applicationQuitGuardRegistry";

interface PendingGuardedAction {
  action: () => Promise<unknown>;
  promise: Promise<boolean>;
  reject: (error: unknown) => void;
  resolve: (confirmed: boolean) => void;
}

export function ApplicationQuitGuardProvider({ children }: { children: ReactNode }): JSX.Element {
  const blockersRef = useRef(new Map<symbol, ApplicationQuitBlocker>());
  const pendingActionRef = useRef<PendingGuardedAction | null>(null);
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

  const requestAction = useCallback<RequestGuardedApplicationAction>((action) => {
    const pending = pendingActionRef.current;
    if (pending) {
      return pending.promise;
    }
    let resolve!: (confirmed: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    pendingActionRef.current = { action, promise, reject, resolve };
    setRevision((current) => current + 1);
    return promise;
  }, []);

  useEffect(() => {
    const api = window.rionStudio;
    if (!api?.onApplicationQuitRequested) {
      return;
    }

    return api.onApplicationQuitRequested(() => {
      void requestAction(() => window.rionStudio.confirmApplicationQuit()).catch(() => undefined);
    });
  }, [requestAction]);

  useEffect(() => {
    const pending = pendingActionRef.current;
    if (!pending || promptingRef.current) {
      return;
    }

    const blockers = [...blockersRef.current.values()];
    if (blockers.some((blocker) => blocker.locked)) {
      return;
    }

    const dirtyBlocker = blockers.find((blocker) => blocker.enabled);
    if (!dirtyBlocker) {
      pendingActionRef.current = null;
      void pending.action().then(() => pending.resolve(true), pending.reject);
      return;
    }

    promptingRef.current = true;
    void confirm(dirtyBlocker.options)
      .then((confirmed) => {
        pendingActionRef.current = null;
        if (!confirmed) {
          pending.resolve(false);
          return undefined;
        }
        return pending.action().then(() => pending.resolve(true), pending.reject);
      }, (error: unknown) => {
        pendingActionRef.current = null;
        pending.reject(error);
      })
      .finally(() => {
        promptingRef.current = false;
        setRevision((current) => current + 1);
      });
  }, [confirm, revision]);

  const value = useMemo(() => ({ requestAction, updateBlocker }), [requestAction, updateBlocker]);

  return (
    <ApplicationQuitGuardContext.Provider value={value}>
      {children}
    </ApplicationQuitGuardContext.Provider>
  );
}
