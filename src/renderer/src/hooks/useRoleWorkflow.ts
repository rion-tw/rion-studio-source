import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { createCopyName } from "../app/copyName";
import { createEmptyRoleForm } from "../app/roleDefaults";
import { mergeAuthStatus, mergeStatus } from "../app/statusUtils";
import type { RoleFormState, SidebarFilter } from "../app/types";
import type { Translator } from "../i18n";
import type { AuthFlowStatus, Role, RoleDefaults, RoleStatus } from "../../../shared/types";

interface UseRoleWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  navigateToRoles: () => void;
  roleDefaults: RoleDefaults;
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
  navigateToRoles,
  roleDefaults,
  roles,
  setAuthStatuses,
  setError,
  setNotice,
  setRoles,
  setStatuses,
  statusByRole,
  t
}: UseRoleWorkflowOptions) {
  const [form, setForm] = useState<RoleFormState>(() => createEmptyRoleForm(roleDefaults));
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>("all");
  const [query, setQuery] = useState("");
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [isReorderingRoles, setIsReorderingRoles] = useState(false);

  const selectedRole = useMemo(() => {
    return roles.find((role) => role.id === form.id);
  }, [roles, form.id]);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      if (form.id) {
        await window.rionStudio.updateRole(form.id, {
          name: form.name,
          launchUrl: form.launchUrl,
          windowWidth: Number(form.windowWidth),
          windowHeight: Number(form.windowHeight),
          notes: form.notes,
          launchPreset: form.launchPreset,
          coverImageDataUrl: form.coverImageDataUrl ?? null,
          coverImageDominantColor: form.coverImageDominantColor ?? null
        });
      } else {
        await window.rionStudio.createRole({
          name: form.name,
          launchUrl: form.launchUrl,
          windowWidth: Number(form.windowWidth),
          windowHeight: Number(form.windowHeight),
          notes: form.notes,
          launchPreset: form.launchPreset,
          coverImageDataUrl: form.coverImageDataUrl ?? null,
          coverImageDominantColor: form.coverImageDominantColor ?? null
        });
      }

      setForm(createEmptyRoleForm(roleDefaults));
      setIsRoleModalOpen(false);
      setActiveFilter("all");
      navigateToRoles();
      await loadData();
    } catch (submitError) {
      setError(submitError);
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
    const confirmed = window.confirm(t("confirm.deleteRole").replace("{name}", role.name));

    if (!confirmed) {
      return;
    }

    setBusyRoleId(role.id);
    setError(null);

    try {
      await window.rionStudio.deleteRole(role.id);
      if (form.id === role.id) {
        setForm(createEmptyRoleForm(roleDefaults));
      }
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
      navigateToRoles();
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

  function startEdit(role: Role): void {
    navigateToRoles();
    setActiveFilter("all");
    setForm({
      id: role.id,
      name: role.name,
      launchUrl: role.launchUrl,
      windowWidth: role.windowWidth,
      windowHeight: role.windowHeight,
      notes: role.notes,
      launchPreset: role.launchPreset,
      coverImageDataUrl: role.coverImageDataUrl,
      coverImageDominantColor: role.coverImageDominantColor
    });
    setIsRoleModalOpen(true);
  }

  function startCreate(): void {
    navigateToRoles();
    setForm(createEmptyRoleForm(roleDefaults));
    setActiveFilter("all");
    setIsRoleModalOpen(true);
  }

  function closeRoleModal(): void {
    if (isSaving) {
      return;
    }

    setIsRoleModalOpen(false);
    setForm(createEmptyRoleForm(roleDefaults));
  }

  return {
    activeFilter,
    busyRoleId,
    closeRoleModal,
    filteredRoles,
    form,
    handleCopy,
    handleDelete,
    handleLaunch,
    handleReorder,
    handleStop,
    handleSubmit,
    handleSystemLogin,
    isRoleModalOpen,
    isReorderingRoles,
    isSaving,
    query,
    requestSystemLogin: handleSystemLogin,
    selectedRole,
    setActiveFilter,
    setForm,
    setQuery,
    startCreate,
    startEdit
  };
}
