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

      const [
        nextRoles,
        nextStatuses,
        nextAuthStatuses,
        nextWorkspaces,
        nextMacros,
        nextMacroStatuses,
        nextWorkspaceDisplays
      ] = await Promise.all([
        window.rionStudio.listRoles(),
        window.rionStudio.listRoleStatuses(),
        window.rionStudio.listAuthStatuses(),
        window.rionStudio.listLaunchWorkspaces(),
        window.rionStudio.listMacros(),
        window.rionStudio.listMacroStatuses(),
        window.rionStudio.listWorkspaceDisplays()
      ]);
      commitRolesRequest(rolesRequest, nextRoles);
      commitStatusesRequest(statusesRequest, nextStatuses);
      commitAuthStatusesRequest(authStatusesRequest, nextAuthStatuses);
      commitWorkspacesRequest(workspacesRequest, nextWorkspaces);
      commitMacrosRequest(macrosRequest, nextMacros);
      commitMacroStatusesRequest(macroStatusesRequest, nextMacroStatuses);
      commitWorkspaceDisplaysRequest(workspaceDisplaysRequest, nextWorkspaceDisplays);
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
      const rolesRequest = beginRolesRequest();
      const workspacesRequest = beginWorkspacesRequest();
      const reportError = captureErrorReporter();
      void Promise.all([window.rionStudio.listRoles(), window.rionStudio.listLaunchWorkspaces()])
        .then(([nextRoles, nextWorkspaces]) => {
          commitRolesRequest(rolesRequest, nextRoles);
          commitWorkspacesRequest(workspacesRequest, nextWorkspaces);
        })
        .catch(reportError);
    });
  }, [
    beginRolesRequest,
    beginWorkspacesRequest,
    captureErrorReporter,
    commitRolesRequest,
    commitWorkspacesRequest,
    loadData,
    setStatuses
  ]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onAuthStatusChanged((nextStatuses) => {
      setAuthStatuses(nextStatuses);
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
      const macrosRequest = beginMacrosRequest();
      const reportError = captureErrorReporter();
      void window.rionStudio.listMacros().then((nextMacros) => {
        commitMacrosRequest(macrosRequest, nextMacros);
      }).catch(reportError);
    });
  }, [beginMacrosRequest, captureErrorReporter, commitMacrosRequest, setMacroStatuses]);

  return {
    authStatusByRole,
    authStatuses,
    beginErrorOperation,
    error,
    initialLoadState,
    loadData,
    macros,
    macroStatuses,
    macroStatusByRun,
    roles,
    roleStats,
    setAuthStatuses,
    setError,
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
