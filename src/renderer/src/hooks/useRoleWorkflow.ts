import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { formatBulkDeleteResult } from "../app/bulkDelete";
import { mergeAuthStatus, mergeStatus } from "../app/statusUtils";
import type { RoleFormState, SidebarFilter } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { AuthFlowStatus, LaunchWorkspace, Macro, Role, RoleStatus } from "../../../shared/types";
import { useBusyIds } from "./useBusyIds";

interface UseRoleWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  roles: Role[];
  gameNamesById: Map<string, string>;
  setAuthStatuses: Dispatch<SetStateAction<AuthFlowStatus[]>>;
  setMacros: Dispatch<SetStateAction<Macro[]>>;
  setNotice?: (message: string | null) => void;
  setRoles: Dispatch<SetStateAction<Role[]>>;
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  setWorkspaces: Dispatch<SetStateAction<LaunchWorkspace[]>>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

export function useRoleWorkflow({
  beginErrorOperation,
  roles,
  gameNamesById,
  setAuthStatuses,
  setMacros,
  setNotice,
  setRoles,
  setStatuses,
  setWorkspaces,
  statusByRole,
  t
}: UseRoleWorkflowOptions) {
  const confirm = useConfirmation();
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>("all");
  const [query, setQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isReorderingRoles, setIsReorderingRoles] = useState(false);
  const { beginBusy, beginBusyMany, busyIds: busyRoleIds } = useBusyIds();
  const isReorderingRolesRef = useRef(false);
  const isSavingRef = useRef(false);
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

      return [role.name, gameNamesById.get(role.gameId), role.launchUrl, role.notes]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [activeFilter, gameNamesById, roles, query, statusByRole]);

  async function saveRole(form: RoleFormState): Promise<Role | undefined> {
    if (isSavingRef.current) {
      return undefined;
    }

    isSavingRef.current = true;
    setIsSaving(true);
    const reportError = beginErrorOperation();

    try {
      const input = {
        gameId: form.gameId,
        name: form.name,
        launchUrl: form.launchUrl,
        windowWidth: Number(form.windowWidth),
        windowHeight: Number(form.windowHeight),
        notes: form.notes,
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

      return savedRole;
    } catch (submitError) {
      reportError(submitError);
      return undefined;
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  async function handleLaunch(roleId: string): Promise<void> {
    const finishBusy = beginBusy(roleId);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const status = await window.rionStudio.launchRole(roleId);
      setStatuses((current) => mergeStatus(current, status));
      if (status.notice) {
        setNotice?.(status.notice);
      }
    } catch (launchError) {
      reportError(launchError);
      try {
        const [nextRoles, nextStatuses] = await Promise.all([
          window.rionStudio.listRoles(),
          window.rionStudio.listRoleStatuses()
        ]);
        setRoles(nextRoles);
        setStatuses(nextStatuses);
      } catch (recoveryError) {
        reportError(recoveryError);
      }
    } finally {
      finishBusy();
    }
  }

  async function handleStop(roleId: string): Promise<void> {
    const finishBusy = beginBusy(roleId);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.stopRole(roleId);
      setStatuses((current) => current.filter((status) => status.roleId !== roleId));
    } catch (stopError) {
      reportError(stopError);
    } finally {
      finishBusy();
    }
  }

  async function handleSystemLogin(roleId: string): Promise<void> {
    const finishBusy = beginBusy(roleId);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      const authStatus = await window.rionStudio.startLogin(roleId);
      setAuthStatuses((current) => mergeAuthStatus(current, authStatus));
      setStatuses((current) => current.filter((status) => status.roleId !== roleId));
    } catch (loginError) {
      reportError(loginError);
    } finally {
      finishBusy();
    }
  }

  async function handleDeleteMany(selectedRoles: Role[]): Promise<boolean> {
    if (selectedRoles.length === 0) {
      return false;
    }
    const isSingle = selectedRoles.length === 1;
    const confirmed = await confirm({
      title: isSingle
        ? t("confirm.deleteRole.title").replace("{name}", selectedRoles[0].name)
        : t("bulkDelete.roles.title").replace("{count}", String(selectedRoles.length)),
      description: isSingle ? t("confirm.deleteRole.description") : t("bulkDelete.roles.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });

    if (!confirmed) {
      return false;
    }

    const ids = selectedRoles.map((role) => role.id);
    const finishBusy = beginBusyMany(ids);
    if (!finishBusy) {
      return false;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const result = await window.rionStudio.deleteRoles({ ids });
      const confirmedDeletedIds = new Set(result.deletedIds);
      setRoles((current) => current.filter((item) => !confirmedDeletedIds.has(item.id)));
      setStatuses((current) => current.filter((status) => !confirmedDeletedIds.has(status.roleId)));
      setAuthStatuses((current) => current.filter((status) => !confirmedDeletedIds.has(status.roleId)));
      setWorkspaces((current) => current.map((workspace) => ({
        ...workspace,
        slots: workspace.slots.map((slot) => {
          if (!slot.roleId || !confirmedDeletedIds.has(slot.roleId)) {
            return slot;
          }

          const { roleId: _roleId, ...nextSlot } = slot;
          return nextSlot;
        })
      })));
      setMacros((current) => current
        .map((macro) => ({
          ...macro,
          roleIds: macro.roleIds.filter((roleId) => !confirmedDeletedIds.has(roleId))
        })));

      try {
        const [nextRoles, nextStatuses, nextAuthStatuses, nextWorkspaces, nextMacros] = await Promise.all([
          window.rionStudio.listRoles(),
          window.rionStudio.listRoleStatuses(),
          window.rionStudio.listAuthStatuses(),
          window.rionStudio.listLaunchWorkspaces(),
          window.rionStudio.listMacros()
        ]);
        setRoles(nextRoles);
        setStatuses(nextStatuses);
        setAuthStatuses(nextAuthStatuses);
        setWorkspaces(nextWorkspaces);
        setMacros(nextMacros);
      } catch (recoveryError) {
        reportError(recoveryError);
      }
      setNotice?.(formatBulkDeleteResult(result, t));
      return true;
    } catch (deleteError) {
      reportError(deleteError);
      return false;
    } finally {
      finishBusy();
    }
  }

  async function handleDelete(role: Role): Promise<void> {
    await handleDeleteMany([role]);
  }

  async function handleCopy(role: Role): Promise<void> {
    const finishBusy = beginBusy(role.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      const copy = await window.rionStudio.createRole({
        gameId: role.gameId,
        name: createCopyName(role.name, roles.map((item) => item.name), t("copyName.suffix")),
        launchUrl: role.launchUrl,
        windowWidth: role.windowWidth,
        windowHeight: role.windowHeight,
        notes: role.notes,
        coverImageDataUrl: role.coverImageDataUrl ?? null,
        coverImageDominantColor: role.coverImageDominantColor ?? null
      });
      setActiveFilter("all");
      setQuery("");
      listScrollTopRef.current = 0;
      setRoles((current) => [...current, copy]);
    } catch (copyError) {
      reportError(copyError);
    } finally {
      finishBusy();
    }
  }

  async function handleReorder(orderedIds: string[]): Promise<void> {
    if (isReorderingRolesRef.current) {
      return;
    }

    const roleById = new Map(roles.map((role) => [role.id, role]));
    const nextRoles = orderedIds.map((id) => roleById.get(id)).filter((role): role is Role => Boolean(role));

    if (nextRoles.length !== roles.length) {
      return;
    }

    isReorderingRolesRef.current = true;
    setIsReorderingRoles(true);
    const reportError = beginErrorOperation();
    setRoles(nextRoles);

    try {
      const savedRoles = await window.rionStudio.reorderRoles({ orderedIds });
      setRoles(savedRoles);
    } catch (reorderError) {
      reportError(reorderError);
      try {
        setRoles(await window.rionStudio.listRoles());
      } catch (recoveryError) {
        reportError(recoveryError);
      }
    } finally {
      isReorderingRolesRef.current = false;
      setIsReorderingRoles(false);
    }
  }

  return {
    activeFilter,
    busyRoleIds,
    filteredRoles,
    handleCopy,
    handleDelete,
    handleDeleteMany,
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
