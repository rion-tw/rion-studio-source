import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { appSnapshotStore } from "../app/appSnapshotStore";
import { createRoleStats } from "../app/statusUtils";
import { withTimeout } from "../app/withTimeout";

type InitialLoadState = "loading" | "ready" | "failed";
export const INITIAL_APP_DATA_TIMEOUT_MS = 15_000;

export function useAppData() {
  const snapshot = useSyncExternalStore(
    appSnapshotStore.subscribe,
    appSnapshotStore.getSnapshot,
    appSnapshotStore.getSnapshot
  );
  const [error, setErrorState] = useState<unknown | null>(null);
  const [initialLoadState, setInitialLoadState] = useState<InitialLoadState>("loading");
  const errorVersionRef = useRef(0);
  const initialLoadRequestRef = useRef(0);

  const setError = useCallback((nextError: unknown | null) => {
    errorVersionRef.current += 1;
    setErrorState(nextError);
  }, []);

  const beginErrorOperation = useCallback(() => {
    const version = ++errorVersionRef.current;
    setErrorState(null);
    return (nextError: unknown) => {
      if (errorVersionRef.current === version) setErrorState(nextError);
    };
  }, []);

  const loadData = useCallback(async (
    options: { markInitialLoad?: boolean; resetError?: boolean } = {}
  ) => {
    const request = ++initialLoadRequestRef.current;
    if (options.resetError ?? true) setError(null);
    if (options.markInitialLoad) setInitialLoadState("loading");
    try {
      if (!window.rionStudio) {
        throw new Error(
          "Rion Studio desktop bridge is unavailable. Restart the app after rebuilding."
        );
      }
      // event-topology-exception: renderer-bounded-bridge-wait
      const next = await withTimeout(
        window.rionStudio.getAppSnapshot(),
        INITIAL_APP_DATA_TIMEOUT_MS,
        "Rion Studio data did not load within 15 seconds."
      );
      appSnapshotStore.commit(next);
      if (options.markInitialLoad && request === initialLoadRequestRef.current) {
        setInitialLoadState("ready");
      }
    } catch (loadError) {
      if (request === initialLoadRequestRef.current) {
        setErrorState(loadError);
        if (options.markInitialLoad) setInitialLoadState("failed");
      }
    }
  }, [setError]);

  useEffect(() => {
    if (!window.rionStudio) {
      void loadData({ markInitialLoad: true });
      return;
    }
    // Listener-first: bridge replay buffers any event that arrived before React mounted.
    const api = window.rionStudio;
    const legacyUnsubscribers: Array<() => void> = [];
    const unsubscribeSnapshot = api.onAppSnapshotChanged
      ? api.onAppSnapshotChanged(appSnapshotStore.commit)
      : (() => {
          legacyUnsubscribers.push(
            api.onGamesChanged((games) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, games })
            )),
            api.onRolesChanged((roles) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, roles })
            )),
            api.onGameWindowsChanged((gameWindows) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, gameWindows })
            )),
            api.onWorkspacesChanged((launchWorkspaces) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, launchWorkspaces })
            )),
            api.onMacrosChanged((macros) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, macros })
            )),
            api.onRoleStatusChanged((roleStatuses) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, roleStatuses })
            )),
            api.onMacroStatusChanged((macroStatuses) => appSnapshotStore.commitProjection(
              (current) => ({ ...current, macroStatuses })
            )),
            api.onEmbeddedRuntimeStateChanged((embeddedRuntimeState) => {
              appSnapshotStore.commitProjection(
                (current) => ({ ...current, embeddedRuntimeState }),
                embeddedRuntimeState.revision
              );
            }),
            api.onDisplayTopologyChanged((displayTopology) => {
              appSnapshotStore.commitProjection(
                (current) => ({ ...current, displayTopology }),
                displayTopology.revision
              );
            })
          );
          return () => legacyUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
        })();
    const unsubscribeError = window.rionStudio.onShellError?.(setError);
    void loadData({ markInitialLoad: true });
    return () => {
      unsubscribeSnapshot();
      unsubscribeError?.();
    };
  }, [loadData, setError]);

  const statusByRole = useMemo(
    () => new Map(snapshot.roleStatuses.map((status) => [status.roleId, status])),
    [snapshot.roleStatuses]
  );
  const macroStatusByRun = useMemo(
    () => new Map(
      snapshot.macroStatuses.map((status) => [`${status.roleId}:${status.macroId}`, status])
    ),
    [snapshot.macroStatuses]
  );
  const roleStats = useMemo(
    () => createRoleStats(snapshot.roles, snapshot.roleStatuses),
    [snapshot.roles, snapshot.roleStatuses]
  );

  return {
    beginErrorOperation,
    embeddedRuntime: snapshot.embeddedRuntimeState,
    error,
    gameWindows: snapshot.gameWindows,
    games: snapshot.games,
    initialLoadState,
    loadData,
    macros: snapshot.macros,
    macroStatuses: snapshot.macroStatuses,
    macroStatusByRun,
    roles: snapshot.roles,
    roleStats,
    setError,
    statusByRole,
    statuses: snapshot.roleStatuses,
    workspaces: snapshot.launchWorkspaces,
    displays: snapshot.displayTopology.displays
  };
}
