import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";

import type {
  EmbeddedRuntimeState,
  Game,
  GameCompatibilityReport,
  GameCompatibilityRunStatus,
  GameWindow,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus,
  DisplayInfo
} from "../../../shared/types";
import { LatestRequestGate } from "../app/operationState";
import { createRoleStats } from "../app/statusUtils";

export type InitialLoadState = "loading" | "ready" | "failed";

interface VersionedState<T> {
  beginRequest: () => number;
  commitRequest: (request: number, value: T) => void;
  setValue: Dispatch<SetStateAction<T>>;
  value: T;
}

function useVersionedState<T>(initialValue: T): VersionedState<T> {
  const [value, setRawValue] = useState(initialValue);
  const requestGateRef = useRef(new LatestRequestGate());
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((nextValue) => {
    requestGateRef.current.invalidate();
    setRawValue(nextValue);
  }, []);
  const beginRequest = useCallback(() => {
    return requestGateRef.current.begin();
  }, []);
  const commitRequest = useCallback((request: number, nextValue: T) => {
    if (requestGateRef.current.isCurrent(request)) {
      setRawValue(nextValue);
    }
  }, []);

  return { beginRequest, commitRequest, setValue, value };
}

export function useAppData() {
  const gameState = useVersionedState<Game[]>([]);
  const compatibilityReportState = useVersionedState<GameCompatibilityReport[]>([]);
  const compatibilityStatusState = useVersionedState<GameCompatibilityRunStatus[]>([]);
  const roleState = useVersionedState<Role[]>([]);
  const embeddedRuntimeState = useVersionedState<EmbeddedRuntimeState>({ windows: [], tabs: [] });
  const workspaceState = useVersionedState<LaunchWorkspace[]>([]);
  const gameWindowState = useVersionedState<GameWindow[]>([]);
  const displayState = useVersionedState<DisplayInfo[]>([]);
  const macroState = useVersionedState<Macro[]>([]);
  const statusState = useVersionedState<RoleStatus[]>([]);
  const macroStatusState = useVersionedState<MacroRunStatus[]>([]);
  const [error, setErrorState] = useState<unknown | null>(null);
  const [initialLoadState, setInitialLoadState] = useState<InitialLoadState>("loading");
  const errorVersionRef = useRef(0);
  const initialLoadRequestRef = useRef(0);

  const {
    beginRequest: beginGamesRequest,
    commitRequest: commitGamesRequest,
    setValue: setGames,
    value: games
  } = gameState;
  const {
    beginRequest: beginCompatibilityReportsRequest,
    commitRequest: commitCompatibilityReportsRequest,
    setValue: setCompatibilityReports,
    value: gameCompatibilityReports
  } = compatibilityReportState;
  const {
    beginRequest: beginCompatibilityStatusesRequest,
    commitRequest: commitCompatibilityStatusesRequest,
    setValue: setCompatibilityStatuses,
    value: gameCompatibilityStatuses
  } = compatibilityStatusState;
  const {
    beginRequest: beginEmbeddedRuntimeRequest,
    commitRequest: commitEmbeddedRuntimeRequest,
    setValue: setEmbeddedRuntimeState,
    value: embeddedRuntime
  } = embeddedRuntimeState;
  const {
    beginRequest: beginRolesRequest,
    commitRequest: commitRolesRequest,
    setValue: setRoles,
    value: roles
  } = roleState;
  const {
    beginRequest: beginWorkspacesRequest,
    commitRequest: commitWorkspacesRequest,
    setValue: setWorkspaces,
    value: workspaces
  } = workspaceState;
  const {
    beginRequest: beginGameWindowsRequest,
    commitRequest: commitGameWindowsRequest,
    setValue: setGameWindows,
    value: gameWindows
  } = gameWindowState;
  const {
    beginRequest: beginDisplaysRequest,
    commitRequest: commitDisplaysRequest,
    setValue: setDisplays,
    value: displays
  } = displayState;
  const {
    beginRequest: beginMacrosRequest,
    commitRequest: commitMacrosRequest,
    setValue: setMacros,
    value: macros
  } = macroState;
  const {
    beginRequest: beginStatusesRequest,
    commitRequest: commitStatusesRequest,
    setValue: setStatuses,
    value: statuses
  } = statusState;
  const {
    beginRequest: beginMacroStatusesRequest,
    commitRequest: commitMacroStatusesRequest,
    setValue: setMacroStatuses,
    value: macroStatuses
  } = macroStatusState;

  const setError = useCallback((nextError: unknown | null) => {
    errorVersionRef.current += 1;
    setErrorState(nextError);
  }, []);

  const beginErrorOperation = useCallback(() => {
    const version = ++errorVersionRef.current;
    setErrorState(null);

    return (nextError: unknown) => {
      if (errorVersionRef.current === version) {
        setErrorState(nextError);
      }
    };
  }, []);

  const captureErrorReporter = useCallback(() => {
    const version = errorVersionRef.current;

    return (nextError: unknown) => {
      if (errorVersionRef.current === version) {
        setErrorState(nextError);
      }
    };
  }, []);

  const statusByRole = useMemo(() => {
    return new Map(statuses.map((status) => [status.roleId, status]));
  }, [statuses]);

  const macroStatusByRun = useMemo(() => {
    return new Map(macroStatuses.map((status) => [`${status.roleId}:${status.macroId}`, status]));
  }, [macroStatuses]);

  const roleStats = useMemo(() => {
    return createRoleStats(roles, statuses);
  }, [roles, statuses]);

  const loadData = useCallback(async (options: { markInitialLoad?: boolean; resetError?: boolean } = {}) => {
    const gamesRequest = beginGamesRequest();
    const compatibilityReportsRequest = beginCompatibilityReportsRequest();
    const compatibilityStatusesRequest = beginCompatibilityStatusesRequest();
    const rolesRequest = beginRolesRequest();
    const embeddedRuntimeRequest = beginEmbeddedRuntimeRequest();
    const statusesRequest = beginStatusesRequest();
    const workspacesRequest = beginWorkspacesRequest();
    const gameWindowsRequest = beginGameWindowsRequest();
    const macrosRequest = beginMacrosRequest();
    const macroStatusesRequest = beginMacroStatusesRequest();
    const displaysRequest = beginDisplaysRequest();
    const reportError = options.resetError ?? true ? beginErrorOperation() : captureErrorReporter();
    const initialLoadRequest = options.markInitialLoad ? ++initialLoadRequestRef.current : undefined;

    if (options.markInitialLoad) {
      setInitialLoadState("loading");
    }

    try {
      if (!window.rionStudio) {
        throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
      }

      const snapshot = await window.rionStudio.getAppSnapshot();
      commitEmbeddedRuntimeRequest(embeddedRuntimeRequest, snapshot.embeddedRuntimeState);
      commitGamesRequest(gamesRequest, snapshot.games);
      commitCompatibilityReportsRequest(compatibilityReportsRequest, snapshot.gameCompatibilityReports);
      commitCompatibilityStatusesRequest(compatibilityStatusesRequest, snapshot.gameCompatibilityStatuses);
      commitRolesRequest(rolesRequest, snapshot.roles);
      commitStatusesRequest(statusesRequest, snapshot.roleStatuses);
      commitWorkspacesRequest(workspacesRequest, snapshot.launchWorkspaces);
      commitGameWindowsRequest(gameWindowsRequest, snapshot.gameWindows);
      commitMacrosRequest(macrosRequest, snapshot.macros);
      commitMacroStatusesRequest(macroStatusesRequest, snapshot.macroStatuses);
      commitDisplaysRequest(displaysRequest, snapshot.displays);
      if (initialLoadRequest !== undefined && initialLoadRequestRef.current === initialLoadRequest) {
        setInitialLoadState("ready");
      }
    } catch (loadError) {
      reportError(loadError);
      if (initialLoadRequest !== undefined && initialLoadRequestRef.current === initialLoadRequest) {
        setInitialLoadState("failed");
      }
    }
  }, [
    beginCompatibilityReportsRequest,
    beginCompatibilityStatusesRequest,
    beginEmbeddedRuntimeRequest,
    beginGamesRequest,
    beginGameWindowsRequest,
    beginErrorOperation,
    beginMacrosRequest,
    beginMacroStatusesRequest,
    beginRolesRequest,
    beginStatusesRequest,
    beginDisplaysRequest,
    beginWorkspacesRequest,
    captureErrorReporter,
    commitCompatibilityReportsRequest,
    commitCompatibilityStatusesRequest,
    commitEmbeddedRuntimeRequest,
    commitGamesRequest,
    commitGameWindowsRequest,
    commitMacrosRequest,
    commitMacroStatusesRequest,
    commitRolesRequest,
    commitStatusesRequest,
    commitDisplaysRequest,
    commitWorkspacesRequest
  ]);

  useEffect(() => {
    void loadData({ markInitialLoad: true });

    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onRoleStatusChanged((nextStatuses) => {
      setStatuses(nextStatuses);
    });
  }, [loadData, setStatuses]);

  useEffect(() => {
    if (!window.rionStudio) return;
    return window.rionStudio.onEmbeddedRuntimeStateChanged(setEmbeddedRuntimeState);
  }, [setEmbeddedRuntimeState]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onDisplaysChanged(setDisplays);
  }, [setDisplays]);

  useEffect(() => {
    if (!window.rionStudio) return;
    return window.rionStudio.onGameWindowsChanged(setGameWindows);
  }, [setGameWindows]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onWorkspacesChanged(setWorkspaces);
  }, [setWorkspaces]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onMacroStatusChanged((nextStatuses) => {
      setMacroStatuses(nextStatuses);
    });
  }, [setMacroStatuses]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onMacrosChanged(setMacros);
  }, [setMacros]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onGamesChanged(setGames);
  }, [setGames]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onGameCompatibilityChanged((reports, statuses) => {
      setCompatibilityReports(reports);
      setCompatibilityStatuses(statuses);
    });
  }, [setCompatibilityReports, setCompatibilityStatuses]);

  return {
    beginErrorOperation,
    embeddedRuntime,
    error,
    gameCompatibilityReports,
    gameCompatibilityStatuses,
    gameWindows,
    games,
    initialLoadState,
    loadData,
    macros,
    macroStatuses,
    macroStatusByRun,
    roles,
    roleStats,
    setError,
    setGames,
    setGameWindows,
    setCompatibilityReports,
    setCompatibilityStatuses,
    setMacros,
    setMacroStatuses,
    setRoles,
    setStatuses,
    setWorkspaces,
    statusByRole,
    statuses,
    workspaces,
    displays
  };
}
