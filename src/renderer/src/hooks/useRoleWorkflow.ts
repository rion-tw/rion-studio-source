import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { emptyForm } from "../app/constants";
import { mergeAuthStatus, mergeStatus } from "../app/statusUtils";
import type { RoleFormState, SidebarFilter } from "../app/types";
import type { Translator } from "../i18n";
import type { AuthFlowStatus, Role, RoleStatus } from "../../../shared/types";

interface UseRoleWorkflowOptions {
  loadData: (options?: { resetError?: boolean }) => Promise<void>;
  navigateToRoles: () => void;
  navigateToGame: () => void;
  roles: Role[];
  setAuthStatuses: Dispatch<SetStateAction<AuthFlowStatus[]>>;
  setError: (error: unknown | null) => void;
  setStatuses: Dispatch<SetStateAction<RoleStatus[]>>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

export function useRoleWorkflow({
  loadData,
  navigateToRoles,
  navigateToGame,
  roles,
  setAuthStatuses,
  setError,
  setStatuses,
  statusByRole,
  t
}: UseRoleWorkflowOptions) {
  const [form, setForm] = useState<RoleFormState>(emptyForm);
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>("all");
  const [query, setQuery] = useState("");
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);

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

      setForm(emptyForm);
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

    try {
      navigateToGame();
      const status = await window.rionStudio.launchRole(roleId);
      setStatuses((current) => mergeStatus(current, status));
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
      navigateToGame();
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
        setForm(emptyForm);
      }
      await loadData();
    } catch (deleteError) {
      setError(deleteError);
    } finally {
      setBusyRoleId(null);
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
    setForm(emptyForm);
    setActiveFilter("all");
    setIsRoleModalOpen(true);
  }

  function closeRoleModal(): void {
    if (isSaving) {
      return;
    }

    setIsRoleModalOpen(false);
    setForm(emptyForm);
  }

  return {
    activeFilter,
    busyRoleId,
    filteredRoles,
    form,
    handleDelete,
    handleLaunch,
    handleStop,
    handleSubmit,
    handleSystemLogin,
    isRoleModalOpen,
    isSaving,
    query,
    requestSystemLogin: handleSystemLogin,
    selectedRole,
    setActiveFilter,
    setForm,
    setQuery,
    startCreate,
    startEdit,
    closeRoleModal
  };
}
