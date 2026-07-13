import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { mergeAuthStatus, mergeStatus } from "../app/statusUtils";
import type { RoleFormState, SidebarFilter } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { AuthFlowStatus, Role, RoleStatus } from "../../../shared/types";

interface UseRoleWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  roles: Role[];
  setAuthStatuses: Dispatch<SetStateAction<AuthFlowStatus[]>>;
  setError: (error: unknown | null) => void;
  setNotice?: (message: string | null) => void;
  setRoles: Dispatch<SetStateAction<Role[]>>;
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

export function useRoleWorkflow({
  loadData,
  roles,
  setAuthStatuses,
  setError,
  setNotice,
  setRoles,
  setStatuses,
  statusByRole,
  t
}: UseRoleWorkflowOptions) {
  const confirm = useConfirmation();
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>("all");
  const [query, setQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [isReorderingRoles, setIsReorderingRoles] = useState(false);
  const listScrollTopRef = useRef(0);

  const filteredRoles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return roles.filter((role) => {
      const isActive = statusByRole.has(role.id);

      if (activeFilter === "running" && !isActive) {
        return false;
      }

      if (activeFilter === "stopped" && isActive) {
        return false;
      }

      if (activeFilter === "needsLogin" && role.authState === "authenticated") {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [role.name, role.launchUrl, role.notes, role.launchPreset]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [activeFilter, roles, query, statusByRole]);

  async function saveRole(form: RoleFormState): Promise<Role | undefined> {
    setIsSaving(true);
    setError(null);

    try {
      const input = {
        name: form.name,
        launchUrl: form.launchUrl,
        windowWidth: Number(form.windowWidth),
        windowHeight: Number(form.windowHeight),
        notes: form.notes,
        launchPreset: form.launchPreset,
        coverImageDataUrl: form.coverImageDataUrl ?? null,
        coverImageDominantColor: form.coverImageDominantColor ?? null
      };
      const savedRole = form.id
        ? await window.rionStudio.updateRole(form.id, input)
        : await window.rionStudio.createRole(input);

      setRoles((current) => {
        if (form.id) {
          return current.map((role) => (role.id === savedRole.id ? savedRole : role));
        }

        return [...current, savedRole];
      });

      if (!form.id) {
        setActiveFilter("all");
        setQuery("");
        listScrollTopRef.current = 0;
      }

      await loadData();
      return savedRole;
    } catch (submitError) {
      setError(submitError);
      return undefined;
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLaunch(roleId: string): Promise<void> {
    setBusyRoleId(roleId);
    setError(null);
    setNotice?.(null);

    try {
      const status = await window.rionStudio.launchRole(roleId);
      setStatuses((current) => mergeStatus(current, status));
      if (status.notice) {
        setNotice?.(status.notice);
      }
    } catch (launchError) {
      setError(launchError);
      await loadData({ resetError: false });
    } finally {
      setBusyRoleId(null);
    }
  }

  async function handleStop(roleId: string): Promise<void> {
    setBusyRoleId(roleId);
    setError(null);

    try {
      await window.rionStudio.stopRole(roleId);
      setStatuses((current) => current.filter((status) => status.roleId !== roleId));
    } catch (stopError) {
      setError(stopError);
    } finally {
      setBusyRoleId(null);
    }
  }

  async function handleSystemLogin(roleId: string): Promise<void> {
    setBusyRoleId(roleId);
    setError(null);

    try {
      const authStatus = await window.rionStudio.startLogin(roleId);
      setAuthStatuses((current) => mergeAuthStatus(current, authStatus));
      setStatuses((current) => current.filter((status) => status.roleId !== roleId));
    } catch (loginError) {
      setError(loginError);
    } finally {
      setBusyRoleId(null);
    }
  }

  async function handleDelete(role: Role): Promise<void> {
    const confirmed = await confirm({
      title: t("confirm.deleteRole.title").replace("{name}", role.name),
      description: t("confirm.deleteRole.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });

    if (!confirmed) {
      return;
    }

    setBusyRoleId(role.id);
    setError(null);

    try {
      await window.rionStudio.deleteRole(role.id);
      await loadData();
    } catch (deleteError) {
      setError(deleteError);
    } finally {
      setBusyRoleId(null);
    }
  }

  async function handleCopy(role: Role): Promise<void> {
    setBusyRoleId(role.id);
    setError(null);

    try {
      await window.rionStudio.createRole({
        name: createCopyName(role.name, roles.map((item) => item.name), t("copyName.suffix")),
        launchUrl: role.launchUrl,
        windowWidth: role.windowWidth,
        windowHeight: role.windowHeight,
        notes: role.notes,
        launchPreset: role.launchPreset,
        coverImageDataUrl: role.coverImageDataUrl ?? null,
        coverImageDominantColor: role.coverImageDominantColor ?? null
      });
      setActiveFilter("all");
      setQuery("");
      listScrollTopRef.current = 0;
      await loadData();
    } catch (copyError) {
      setError(copyError);
    } finally {
      setBusyRoleId(null);
    }
  }

  async function handleReorder(orderedIds: string[]): Promise<void> {
    if (isReorderingRoles) {
      return;
    }

    const roleById = new Map(roles.map((role) => [role.id, role]));
    const nextRoles = orderedIds.map((id) => roleById.get(id)).filter((role): role is Role => Boolean(role));

    if (nextRoles.length !== roles.length) {
      return;
    }

    setIsReorderingRoles(true);
    setError(null);
    setRoles(nextRoles);

    try {
      const savedRoles = await window.rionStudio.reorderRoles({ orderedIds });
      setRoles(savedRoles);
    } catch (reorderError) {
      setError(reorderError);
      await loadData({ resetError: false });
    } finally {
      setIsReorderingRoles(false);
    }
  }

  return {
    activeFilter,
    busyRoleId,
    filteredRoles,
    handleCopy,
    handleDelete,
    handleLaunch,
    handleReorder,
    handleStop,
    handleSystemLogin,
    isReorderingRoles,
    isSaving,
    listScrollTopRef,
    query,
    requestSystemLogin: handleSystemLogin,
    saveRole,
    setActiveFilter,
    setQuery
  };
}
