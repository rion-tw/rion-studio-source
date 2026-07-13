import { LayoutDashboard, Loader2, MoreHorizontal, Pencil, Play, Plus, Search, Square, Trash2 } from "lucide-react";
import { type CSSProperties, type JSX, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardTitle } from "../../components/ui/card";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { EmptyState } from "../../components/EmptyState";
import { SearchField } from "../../components/SearchField";
import { launchUrlOptions } from "../../app/constants";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { LaunchWorkspace, LaunchWorkspaceSlot, Role, RoleStatus, WorkspaceLayoutTemplate } from "../../../../shared/types";
import { createWorkspaceSlotBackground, getWorkspaceSplits } from "./workspaceLayoutUtils";
import { WorkspaceTemplateIcon, workspaceTemplateLabelKeys } from "./workspaceConstants";

interface LaunchWorkspacesViewProps {
  busyWorkspaceId: string | null;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaces: LaunchWorkspace[];
  onCreateWorkspace: () => void;
  onDeleteWorkspace: (workspace: LaunchWorkspace) => void;
  onEditWorkspace: (workspace: LaunchWorkspace) => void;
  onLaunchWorkspace: (workspace: LaunchWorkspace) => void;
  onStopWorkspace: (workspace: LaunchWorkspace) => void;
}

function LaunchWorkspacesView({
  busyWorkspaceId,
  roles,
  statusByRole,
  t,
  workspaces,
  onCreateWorkspace,
  onDeleteWorkspace,
  onEditWorkspace,
  onLaunchWorkspace,
  onStopWorkspace
}: LaunchWorkspacesViewProps): JSX.Element {
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const [query, setQuery] = useState("");
  const filteredWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return workspaces;
    }

    return workspaces.filter((workspace) => {
      const assignedRoleNames = workspace.slots
        .map((slot) => (slot.roleId ? roleById.get(slot.roleId)?.name : ""))
        .filter(Boolean);

      return [workspace.name, t(workspaceTemplateLabelKeys[workspace.template]), ...assignedRoleNames]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [query, roleById, t, workspaces]);

  return (
    <PageFrame>
      <PageHeader
        kicker={t("workspaces.kicker")}
        title={t("workspaces.title")}
        description={t("workspaces.description")}
        actions={
          <>
            <SearchField
              className="w-full sm:w-44 lg:w-48"
              placeholder={t("workspaces.searchPlaceholder")}
              value={query}
              onChange={setQuery}
            />
            <Button className="w-full gap-1.5 sm:w-auto" type="button" variant="outline" size="sm" onClick={onCreateWorkspace}>
              <Plus size={14} />
              {t("workspaces.newWorkspace")}
            </Button>
          </>
        }
      />

      {workspaces.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title={t("workspaces.empty.title")}
          description={t("workspaces.empty.description")}
          actionLabel={t("workspaces.empty.action")}
          onAction={onCreateWorkspace}
        />
      ) : filteredWorkspaces.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("workspaces.noMatches.title")}
          description={t("workspaces.noMatches.description")}
          actionLabel={t("workspaces.noMatches.action")}
          onAction={() => setQuery("")}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredWorkspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              busyWorkspaceId={busyWorkspaceId}
              roleById={roleById}
              statusByRole={statusByRole}
              t={t}
              workspace={workspace}
              onDelete={() => onDeleteWorkspace(workspace)}
              onEdit={() => onEditWorkspace(workspace)}
              onLaunch={() => onLaunchWorkspace(workspace)}
              onStop={() => onStopWorkspace(workspace)}
            />
          ))}
        </div>
      )}
    </PageFrame>
  );
}

interface WorkspaceCardProps {
  busyWorkspaceId: string | null;
  onDelete: () => void;
  onEdit: () => void;
  onLaunch: () => void;
  onStop: () => void;
  roleById: Map<string, Role>;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspace: LaunchWorkspace;
}

function WorkspaceCard({
  busyWorkspaceId,
  onDelete,
  onEdit,
  onLaunch,
  onStop,
  roleById,
  statusByRole,
  t,
  workspace
}: WorkspaceCardProps): JSX.Element {
  const assignedCount = workspace.slots.filter((slot) => slot.roleId).length;
  const runningCount = workspace.slots.filter((slot) => slot.roleId && statusByRole.has(slot.roleId)).length;
  const isRunning = runningCount > 0;
  const isBusy = busyWorkspaceId === workspace.id;

  return (
    <Card className="group relative overflow-visible glass-panel-strong transition-shadow duration-200">
      <WorkspaceLayoutPreview
        className="aspect-[4/3] p-2"
        roleById={roleById}
        slots={workspace.slots}
        t={t}
        template={workspace.template}
      />

      <div className="pointer-events-none absolute right-3 top-3 z-30 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <WorkspaceActionMenu
          isBusy={isBusy}
          t={t}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      </div>

      <div className="glass-divider border-t p-3.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="flex shrink-0 items-center justify-center text-muted-foreground"
                title={t(workspaceTemplateLabelKeys[workspace.template])}
              >
                <WorkspaceTemplateIcon template={workspace.template} size={18} aria-hidden="true" />
              </span>
              <CardTitle className="min-w-0 truncate">{workspace.name}</CardTitle>
            </div>
          </div>

          <Button
            className="h-7 min-w-[88px] shrink-0 gap-1.5 px-2.5 text-[11px]"
            type="button"
            variant={isRunning ? "destructive" : "secondary"}
            size="sm"
            onClick={isRunning ? onStop : onLaunch}
            disabled={isBusy || assignedCount === 0}
          >
            {isBusy ? <Loader2 className="spin" size={14} /> : isRunning ? <Square size={14} /> : <Play size={14} />}
            {isRunning ? t("workspaces.stopShort") : t("workspaces.launchShort")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

interface WorkspaceLayoutPreviewProps {
  className?: string;
  roleById: Map<string, Role>;
  slots: LaunchWorkspaceSlot[];
  t: Translator;
  template: WorkspaceLayoutTemplate;
}

function WorkspaceLayoutPreview({
  className,
  roleById,
  slots,
  t,
  template
}: WorkspaceLayoutPreviewProps): JSX.Element {
  const splits = getWorkspaceSplits(template, slots);
  const splitX = splits.vertical[0] ?? 1;
  const splitY = splits.horizontal[0] ?? 1;

  function renderSlot(slot: LaunchWorkspaceSlot | undefined, index: number): JSX.Element | null {
    if (!slot) {
      return null;
    }

    const role = slot.roleId ? roleById.get(slot.roleId) : undefined;

    return (
      <WorkspaceLayoutPreviewSlot
        key={slot.id}
        index={index}
        role={role}
        t={t}
      />
    );
  }

  function renderSplitRow(topSlotIndex: number, bottomSlotIndex: number): JSX.Element {
    return (
      <div className="flex h-full min-h-0 min-w-0 gap-2">
        <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX)}>
          {renderSlot(slots[topSlotIndex], topSlotIndex)}
        </div>
        <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitX)}>
          {renderSlot(slots[bottomSlotIndex], bottomSlotIndex)}
        </div>
      </div>
    );
  }

  function renderLayout(): JSX.Element {
    switch (template) {
      case "single":
        return <div className="flex h-full min-h-0">{renderSlot(slots[0], 0)}</div>;
      case "two_columns":
        return (
          <div className="flex h-full min-h-0 gap-2">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitX)}>
              {renderSlot(slots[1], 1)}
            </div>
          </div>
        );
      case "main_left_stack_right":
        return (
          <div className="flex h-full min-h-0 gap-2">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col gap-2" style={createPreviewFlexStyle(1 - splitX)}>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
                {renderSlot(slots[1], 1)}
              </div>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
                {renderSlot(slots[2], 2)}
              </div>
            </div>
          </div>
        );
      case "main_right_stack_left":
        return (
          <div className="flex h-full min-h-0 gap-2">
            <div className="flex min-h-0 min-w-0 flex-col gap-2" style={createPreviewFlexStyle(splitX)}>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
                {renderSlot(slots[1], 1)}
              </div>
              <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
                {renderSlot(slots[2], 2)}
              </div>
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitX)}>
              {renderSlot(slots[0], 0)}
            </div>
          </div>
        );
      case "quad":
        return (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(splitY)}>
              {renderSplitRow(0, 1)}
            </div>
            <div className="min-h-0 min-w-0" style={createPreviewFlexStyle(1 - splitY)}>
              {renderSplitRow(2, 3)}
            </div>
          </div>
        );
      case "three_columns":
      case "four_columns":
        return (
          <div className="flex h-full min-h-0 gap-2">
            {slots.map((slot, index) => (
              <div key={slot.id} className="min-h-0 min-w-0" style={createPreviewFlexStyle(slot.rect.width)}>
                {renderSlot(slot, index)}
              </div>
            ))}
          </div>
        );
    }
  }

  return (
    <div className={cn("relative overflow-hidden rounded-md bg-background/30", className)}>
      {renderLayout()}
    </div>
  );
}

interface WorkspaceLayoutPreviewSlotProps {
  index: number;
  role: Role | undefined;
  t: Translator;
}

function WorkspaceLayoutPreviewSlot({ index, role, t }: WorkspaceLayoutPreviewSlotProps): JSX.Element {
  const launchGameName = role ? resolveWorkspaceRoleLaunchGameName(role.launchUrl, t) : "";

  return (
    <div
      className={cn(
        "relative isolate h-full min-h-0 w-full min-w-0 overflow-hidden rounded-sm bg-cover bg-center bg-clip-padding [--workspace-slot-radius:0.125rem]",
        role ? "shadow-sm ring-1 ring-inset ring-border/60" : "border border-dashed border-muted-foreground/35 bg-muted/30"
      )}
      style={createWorkspaceSlotBackground(role)}
    >
      <div className="workspace-slot-caption">
        <p className="workspace-slot-caption-title gap-1.5 text-[11px] font-semibold leading-4">
          {role ? (
            <span className="workspace-role-chip-text">
              <span className="min-w-0 truncate">{role.name}</span>
              <span className="workspace-role-game-label min-w-0 truncate">{launchGameName}</span>
            </span>
          ) : (
            t("workspaces.emptySlot")
          )}
        </p>
      </div>
      {!role ? (
        <div className="absolute left-2 top-2 rounded-sm bg-background/55 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {index + 1}
        </div>
      ) : null}
    </div>
  );
}

function createPreviewFlexStyle(weight: number): CSSProperties {
  return {
    flexBasis: 0,
    flexGrow: Math.max(weight, 0.001)
  };
}

function resolveWorkspaceRoleLaunchGameName(launchUrl: string, t: Translator): string {
  const option = launchUrlOptions.find((launchOption) => launchOption.value === launchUrl);

  if (option) {
    return "labelKey" in option ? t(option.labelKey) : option.label;
  }

  try {
    return new URL(launchUrl).hostname;
  } catch {
    return t("roleForm.launchUrl.current");
  }
}

interface WorkspaceActionMenuProps {
  isBusy: boolean;
  onDelete: () => void;
  onEdit: () => void;
  t: Translator;
}

function WorkspaceActionMenu({ isBusy, onDelete, onEdit, t }: WorkspaceActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        className="h-7 w-7"
        type="button"
        variant="secondary"
        size="icon"
        title={t("workspaces.actions")}
        aria-label={t("workspaces.actions")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <MoreHorizontal size={14} />
      </Button>

      {isOpen ? (
        <Surface
          className="absolute right-0 top-8 z-20 min-w-32 overflow-hidden text-popover-foreground"
          padding="xs"
          variant="popover"
          role="menu"
        >
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground"
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onEdit();
            }}
          >
            <Pencil size={14} />
            <span>{t("workspaces.edit")}</span>
          </button>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onDelete();
            }}
            disabled={isBusy}
          >
            <Trash2 size={14} />
            <span>{t("workspaces.delete")}</span>
          </button>
        </Surface>
      ) : null}
    </div>
  );
}

export default LaunchWorkspacesView;
