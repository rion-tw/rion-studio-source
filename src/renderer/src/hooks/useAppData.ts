import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AuthFlowStatus,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../../../shared/types";
import { createRoleStats } from "../app/statusUtils";

export type InitialLoadState = "loading" | "ready" | "failed";

export function useAppData() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [workspaces, setWorkspaces] = useState<LaunchWorkspace[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [statuses, setStatuses] = useState<RoleStatus[]>([]);
  const [authStatuses, setAuthStatuses] = useState<AuthFlowStatus[]>([]);
  const [macroStatuses, setMacroStatuses] = useState<MacroRunStatus[]>([]);
  const [error, setError] = useState<unknown | null>(null);
  const [initialLoadState, setInitialLoadState] = useState<InitialLoadState>("loading");

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
    if (options.resetError ?? true) {
      setError(null);
    }

    if (options.markInitialLoad) {
      setInitialLoadState("loading");
    }

    try {
      if (!window.rionStudio) {
        throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
      }

      const [nextRoles, nextStatuses, nextAuthStatuses, nextWorkspaces, nextMacros, nextMacroStatuses] = await Promise.all([
        window.rionStudio.listRoles(),
        window.rionStudio.listRoleStatuses(),
        window.rionStudio.listAuthStatuses(),
        window.rionStudio.listLaunchWorkspaces(),
        window.rionStudio.listMacros(),
        window.rionStudio.listMacroStatuses()
      ]);
      setRoles(nextRoles);
      setStatuses(nextStatuses);
      setAuthStatuses(nextAuthStatuses);
      setWorkspaces(nextWorkspaces);
      setMacros(nextMacros);
      setMacroStatuses(nextMacroStatuses);
      if (options.markInitialLoad) {
        setInitialLoadState("ready");
      }
    } catch (loadError) {
      setError(loadError);
      if (options.markInitialLoad) {
        setInitialLoadState("failed");
      }
    }
  }, []);

  useEffect(() => {
    void loadData({ markInitialLoad: true });

    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onRoleStatusChanged((nextStatuses) => {
      setStatuses(nextStatuses);
      void Promise.all([window.rionStudio.listRoles(), window.rionStudio.listLaunchWorkspaces()])
        .then(([nextRoles, nextWorkspaces]) => {
          setRoles(nextRoles);
          setWorkspaces(nextWorkspaces);
        })
        .catch((statusError) => {
          setError(statusError);
        });
    });
  }, [loadData]);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onAuthStatusChanged((nextStatuses) => {
      setAuthStatuses(nextStatuses);
      void window.rionStudio.listRoles().then(setRoles).catch((authError) => {
        setError(authError);
      });
    });
  }, []);

  useEffect(() => {
    if (!window.rionStudio) {
      return;
    }

    return window.rionStudio.onMacroStatusChanged((nextStatuses) => {
      setMacroStatuses(nextStatuses);
      void window.rionStudio.listMacros().then(setMacros).catch((macroError) => {
        setError(macroError);
      });
    });
  }, []);

  return {
    authStatusByRole,
    authStatuses,
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
    workspaces
  };
}
