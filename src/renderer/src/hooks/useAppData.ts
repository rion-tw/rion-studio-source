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
  AuthFlowStatus,
  Game,
  GameCompatibilityReport,
  GameCompatibilityRunStatus,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus,
  WorkspaceDisplayInfo
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
  const workspaceState = useVersionedState<LaunchWorkspace[]>([]);
  const workspaceDisplayState = useVersionedState<WorkspaceDisplayInfo[]>([]);
  const macroState = useVersionedState<Macro[]>([]);
  const statusState = useVersionedState<RoleStatus[]>([]);
  const authStatusState = useVersionedState<AuthFlowStatus[]>([]);
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
    beginRequest: beginWorkspaceDisplaysRequest,
    commitRequest: commitWorkspaceDisplaysRequest,
    setValue: setWorkspaceDisplays,
    value: workspaceDisplays
  } = workspaceDisplayState;
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
    beginRequest: beginAuthStatusesRequest,
    commitRequest: commitAuthStatusesRequest,
    setValue: setAuthStatuses,
    value: authStatuses
  } = authStatusState;
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

  const authStatusByRole = useMemo(() => {
    return new Map(authStatuses.map((status) => [status.roleId, status]));
  }, [authStatuses]);

  const macroStatusByRun = useMemo(() => {
    return new Map(macroStatuses.map((status) => [`${status.roleId}:${status.macroId}`, status]));
  }, [macroStatuses]);

  const roleStats = useMemo(() => {
    return createRoleStats(roles, statuses, authStatuses);
  }, [authStatuses, roles, statuses]);

  const loadData = useCallback(async (options: { markInitialLoad?: boolean; resetError?: boolean } = {}) => {
    const gamesRequest = beginGamesRequest();
    const compatibilityReportsRequest = beginCompatibilityReportsRequest();
    const compatibilityStatusesRequest = beginCompatibilityStatusesRequest();
    const rolesRequest = beginRolesRequest();
    const statusesRequest = beginStatusesRequest();
    const authStatusesRequest = beginAuthStatusesRequest();
    const workspacesRequest = beginWorkspacesRequest();
    const macrosRequest = beginMacrosRequest();
    const macroStatusesRequest = beginMacroStatusesRequest();
    const workspaceDisplaysRequest = beginWorkspaceDisplaysRequest();
    const reportError = options.resetError ?? true ? beginErrorOperation() : captureErrorReporter();
    const initialLoadRequest = options.markInitialLoad ? ++initialLoadRequestRef.current : undefined;

    if (options.markInitialLoad) {
      setInitialLoadState("loading");
    }

    try {
      if (!window.rionStudio) {
        throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
      }

      const snapshot = await window.rionStudio.getAppSnapshot();
      commitGamesRequest(gamesRequest, snapshot.games);
      commitCompatibilityReportsRequest(compatibilityReportsRequest, snapshot.gameCompatibilityReports);
      commitCompatibilityStatusesRequest(compatibilityStatusesRequest, snapshot.gameCompatibilityStatuses);
      commitRolesRequest(rolesRequest, snapshot.roles);
      commitStatusesRequest(statusesRequest, snapshot.roleStatuses);
      commitAuthStatusesRequest(authStatusesRequest, snapshot.authStatuses);
      commitWorkspacesRequest(workspacesRequest, snapshot.launchWorkspaces);
      commitMacrosRequest(macrosRequest, snapshot.macros);
      commitMacroStatusesRequest(macroStatusesRequest, snapshot.macroStatuses);
      commitWorkspaceDisplaysRequest(workspaceDisplaysRequest, snapshot.workspaceDisplays);
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
    beginGamesRequest,
    beginAuthStatusesRequest,
    beginErrorOperation,
    beginMacrosRequest,
    beginMacroStatusesRequest,
    beginRolesRequest,
    beginStatusesRequest,
    beginWorkspaceDisplaysRequest,
    beginWorkspacesRequest,
    captureErrorReporter,
    commitAuthStatusesRequest,
    commitCompatibilityReportsRequest,
    commitCompatibilityStatusesRequest,
    commitGamesRequest,
    commitMacrosRequest,
    commitMacroStatusesRequest,
    commitRolesRequest,
    commitStatusesRequest,
    commitWorkspaceDisplaysRequest,
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
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onAuthStatusChanged((nextStatuses) => {
      setAuthStatuses(nextStatuses);
      if (!nextStatuses.some((status) => status.state === "launching" || status.state === "failed")) {
        return;
      }

      const rolesRequest = beginRolesRequest();
      const reportError = captureErrorReporter();
      void window.rionStudio.listRoles().then((nextRoles) => {
        commitRolesRequest(rolesRequest, nextRoles);
      }).catch(reportError);
    });
  }, [beginRolesRequest, captureErrorReporter, commitRolesRequest, setAuthStatuses]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onWorkspaceDisplaysChanged(setWorkspaceDisplays);
  }, [setWorkspaceDisplays]);

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
    authStatusByRole,
    authStatuses,
    beginErrorOperation,
    error,
    gameCompatibilityReports,
    gameCompatibilityStatuses,
    games,
    initialLoadState,
    loadData,
    macros,
    macroStatuses,
    macroStatusByRun,
    roles,
    roleStats,
    setAuthStatuses,
    setError,
    setGames,
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
    workspaceDisplays
  };
}
