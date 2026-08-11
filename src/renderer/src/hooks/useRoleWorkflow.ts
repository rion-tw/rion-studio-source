import { useMemo, useRef, useState } from "react";

import { createCopyName } from "../app/copyName";
import { formatBulkDeleteResult } from "../app/bulkDelete";
import type { RoleFormState, SidebarFilter } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Role, RoleStatus, RuntimeLaunchDestination } from "../../../shared/types";
import { useBusyIds } from "./useBusyIds";

interface UseRoleWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  roles: Role[];
  gameNamesById: Map<string, string>;
  setNotice?: (message: string | null) => void;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

export function useRoleWorkflow({
  beginErrorOperation,
  roles,
  gameNamesById,
  setNotice,
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
    setNotice?.(null);

    try {
      const input = {
        gameId: form.gameId,
        name: form.name,
        launchUrl: form.launchUrl,
        notes: form.notes,
        coverImageDataUrl: form.coverImageDataUrl ?? null,
        coverImageDominantColor: form.coverImageDominantColor ?? null
      };
      const savedRole = form.id
        ? await window.rionStudio.updateRole(form.id, input)
        : await window.rionStudio.createRole(input);

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

  async function handleLaunch(
    roleId: string,
    destination?: RuntimeLaunchDestination
  ): Promise<RoleStatus | undefined> {
    const finishBusy = beginBusy(roleId);
    if (!finishBusy) {
      return undefined;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      const { status } = await window.rionStudio.launchRole(roleId, destination);
      if (!status) {
        return undefined;
      }
      if (status.notice) {
        setNotice?.(status.notice);
      }
      return status;
    } catch (launchError) {
      reportError(launchError);
      return undefined;
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

  async function handleClearBrowserData(role: Role): Promise<boolean> {
    const confirmed = await confirm({
      title: t("confirm.clearRoleData.title").replace("{name}", role.name),
      description: t("confirm.clearRoleData.description"),
      details: [
        t("confirm.clearRoleData.target"),
        t("confirm.clearRoleData.stop"),
        t("confirm.clearRoleData.preserve")
      ],
      warning: t("confirm.clearRoleData.warning"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.clearData"),
      tone: "destructive"
    });

    if (!confirmed) {
      return false;
    }

    const finishBusy = beginBusy(role.id);
    if (!finishBusy) {
      return false;
    }

    const reportError = beginErrorOperation();
    setNotice?.(null);

    try {
      await window.rionStudio.clearRoleBrowserData(role.id);
      setNotice?.(t("notice.roleBrowserDataCleared").replace("{name}", role.name));
      return true;
    } catch (clearError) {
      reportError(clearError);
      return false;
    } finally {
      finishBusy();
    }
  }

  async function handleCopy(role: Role): Promise<void> {
    const finishBusy = beginBusy(role.id);
    if (!finishBusy) {
      return;
    }

    const reportError = beginErrorOperation();

    try {
      await window.rionStudio.createRole({
        gameId: role.gameId,
        name: createCopyName(role.name, roles.map((item) => item.name), t("copyName.suffix")),
        launchUrl: role.launchUrl,
        notes: role.notes,
        coverImageDataUrl: role.coverImageDataUrl ?? null,
        coverImageDominantColor: role.coverImageDominantColor ?? null
      });
      setActiveFilter("all");
      setQuery("");
      listScrollTopRef.current = 0;
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

    if (orderedIds.length !== roles.length || new Set(orderedIds).size !== roles.length) {
      return;
    }

    isReorderingRolesRef.current = true;
    setIsReorderingRoles(true);
    const reportError = beginErrorOperation();
    try {
      await window.rionStudio.reorderRoles({ orderedIds });
    } catch (reorderError) {
      reportError(reorderError);
    } finally {
      isReorderingRolesRef.current = false;
      setIsReorderingRoles(false);
    }
  }

  return {
    activeFilter,
    busyRoleIds,
    filteredRoles,
    handleClearBrowserData,
    handleCopy,
    handleDelete,
    handleDeleteMany,
    handleLaunch,
    handleReorder,
    isReorderingRoles,
    isSaving,
    listScrollTopRef,
    query,
    saveRole,
    setActiveFilter,
    setQuery
  };
}
