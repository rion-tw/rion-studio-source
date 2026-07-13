import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Keyboard,
  LayoutDashboard,
  Loader2,
  LogIn,
  Play,
  Square,
  Users
} from "lucide-react";
import { type JSX, useMemo } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PageFrame, Surface } from "../../components/ui/patterns";
import { formatAuthFlowState } from "../../app/statusUtils";
import type { SidebarFilter } from "../../app/types";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  AuthFlowStatus,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../../../../shared/types";
import {
  createDashboardSummary,
  getDashboardMacroItems,
  getDashboardRoleItems,
  getDashboardWorkspaceItems,
  getPendingAuthItems,
  type DashboardMacroItem,
  type DashboardPendingAuthItem,
  type DashboardRoleItem,
  type DashboardWorkspaceItem
} from "./dashboardUtils";

interface DashboardRouteProps {
  authStatusByRole: Map<string, AuthFlowStatus>;
  busyMacroId: string | null;
  busyRoleId: string | null;
  busyRunKey: string | null;
  busyWorkspaceId: string | null;
  macroStatusByRun: Map<string, MacroRunStatus>;
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  roleStatuses: RoleStatus[];
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaces: LaunchWorkspace[];
  onCreateWorkspace: () => void;
  onLaunchRole: (roleId: string) => void;
  onLaunchWorkspace: (workspace: LaunchWorkspace) => void;
  onLoginRole: (roleId: string) => void;
  onNavigateMacros: () => void;
  onNavigateRoles: (filter: SidebarFilter) => void;
  onNavigateWorkspaces: () => void;
  onNewMacro: () => void;
  onNewRole: () => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  onStopRole: (roleId: string) => void;
  onStopWorkspace: (workspace: LaunchWorkspace) => void;
}

function DashboardRoute({
  authStatusByRole,
  busyMacroId,
  busyRoleId,
  busyRunKey,
  busyWorkspaceId,
  macroStatusByRun,
  macroStatuses,
  macros,
  roleStatuses,
  roles,
  statusByRole,
  t,
  workspaces,
  onCreateWorkspace,
  onLaunchRole,
  onLaunchWorkspace,
  onLoginRole,
  onNavigateMacros,
  onNavigateRoles,
  onNavigateWorkspaces,
  onNewMacro,
  onNewRole,
  onStartMacro,
  onStopMacro,
  onStopRole,
  onStopWorkspace
}: DashboardRouteProps): JSX.Element {
  const summary = useMemo(
    () => createDashboardSummary({ macroStatuses, macros, roleStatuses, roles, workspaces }),
    [macroStatuses, macros, roleStatuses, roles, workspaces]
  );
  const roleItems = useMemo(
    () => getDashboardRoleItems({ authStatusByRole, busyRoleId, roles, statusByRole }).slice(0, 6),
    [authStatusByRole, busyRoleId, roles, statusByRole]
  );
  const pendingItems = useMemo(
    () => getPendingAuthItems({ authStatusByRole, busyRoleId, roles, statusByRole }),
    [authStatusByRole, busyRoleId, roles, statusByRole]
  );
  const workspaceItems = useMemo(
    () => getDashboardWorkspaceItems({ busyWorkspaceId, statusByRole, workspaces }).slice(0, 4),
    [busyWorkspaceId, statusByRole, workspaces]
  );
  const macroItems = useMemo(
    () =>
      getDashboardMacroItems({
        busyMacroId,
        busyRunKey,
        macroStatusByRun,
        macros,
        roles,
        statusByRole
      }).slice(0, 5),
    [busyMacroId, busyRunKey, macroStatusByRun, macros, roles, statusByRole]
  );

  return (
    <PageFrame>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Users}
          label={t("dashboard.stat.runningRoles")}
          value={summary.runningRoles}
          onClick={() => onNavigateRoles("running")}
        />
        <StatCard
          icon={LogIn}
          label={t("dashboard.stat.needsLogin")}
          value={summary.rolesNeedingLogin}
          tone={summary.rolesNeedingLogin > 0 ? "warning" : "muted"}
          onClick={() => onNavigateRoles("needsLogin")}
        />
        <StatCard
          icon={LayoutDashboard}
          label={t("dashboard.stat.workspaces")}
          value={summary.workspaceCount}
          onClick={onNavigateWorkspaces}
        />
        <StatCard
          icon={Keyboard}
          label={t("dashboard.stat.runningMacros")}
          value={summary.runningMacros}
          tone={summary.runningMacros > 0 ? "success" : "muted"}
          onClick={onNavigateMacros}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.28fr)_minmax(320px,0.72fr)]">
        <div className="grid min-w-0 gap-4">
          <Panel
            title={t("dashboard.pending.title")}
            actionLabel={t("dashboard.viewRoles")}
            onAction={() => onNavigateRoles("needsLogin")}
          >
            {pendingItems.length === 0 ? (
              <PanelEmpty
                icon={CheckCircle2}
                title={t("dashboard.pending.emptyTitle")}
                description={t("dashboard.pending.emptyDescription")}
              />
            ) : (
              <div className="grid gap-2">
                {pendingItems.map((item) => (
                  <PendingAuthRow
                    key={item.role.id}
                    item={item}
                    t={t}
                    onLogin={() => onLoginRole(item.role.id)}
                  />
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title={t("dashboard.quickRoles.title")}
            actionLabel={t("dashboard.viewRoles")}
            onAction={() => onNavigateRoles("all")}
          >
            {roleItems.length === 0 ? (
              <PanelEmpty
                icon={Users}
                title={t("dashboard.quickRoles.emptyTitle")}
                description={t("dashboard.quickRoles.emptyDescription")}
                actionLabel={t("roles.empty.action")}
                onAction={onNewRole}
              />
            ) : (
              <div className="grid gap-2">
                {roleItems.map((item) => (
                  <RoleLaunchRow
                    key={item.role.id}
                    item={item}
                    t={t}
                    onLaunch={() => onLaunchRole(item.role.id)}
                    onLogin={() => onLoginRole(item.role.id)}
                    onStop={() => onStopRole(item.role.id)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <Panel
            title={t("dashboard.workspaces.title")}
            actionLabel={t("dashboard.viewWorkspaces")}
            onAction={onNavigateWorkspaces}
          >
            {workspaceItems.length === 0 ? (
              <PanelEmpty
                icon={LayoutDashboard}
                title={t("dashboard.workspaces.emptyTitle")}
                description={t("dashboard.workspaces.emptyDescription")}
                actionLabel={t("workspaces.empty.action")}
                onAction={onCreateWorkspace}
              />
            ) : (
              <div className="grid gap-2">
                {workspaceItems.map((item) => (
                  <WorkspaceLaunchRow
                    key={item.workspace.id}
                    item={item}
                    t={t}
                    onLaunch={() => onLaunchWorkspace(item.workspace)}
                    onStop={() => onStopWorkspace(item.workspace)}
                  />
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title={t("dashboard.macros.title")}
            actionLabel={t("dashboard.viewMacros")}
            onAction={onNavigateMacros}
          >
            {macroItems.length === 0 ? (
              <PanelEmpty
                icon={Keyboard}
                title={t("dashboard.macros.emptyTitle")}
                description={t("dashboard.macros.emptyDescription")}
                actionLabel={t("macros.empty.action")}
                onAction={onNewMacro}
              />
            ) : (
              <div className="grid gap-2">
                {macroItems.map((item) => (
                  <MacroRunRow
                    key={item.macro.id}
                    item={item}
                    t={t}
                    onStart={() => onStartMacro(item.macro.id)}
                    onStop={() => onStopMacro(item.macro.id)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </PageFrame>
  );
}

interface StatCardProps {
  icon: typeof Users;
  label: string;
  onClick: () => void;
  tone?: "muted" | "success" | "warning";
  value: number;
}

function StatCard({ icon: Icon, label, onClick, tone = "success", value }: StatCardProps): JSX.Element {
  return (
    <button
      className="glass-panel-strong group flex min-h-[88px] min-w-0 items-center gap-3 rounded-lg p-4 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20"
      type="button"
      onClick={onClick}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg border",
          tone === "success" && "border-success-foreground/15 bg-success/75 text-success-foreground",
          tone === "warning" && "border-warning-foreground/15 bg-warning/75 text-warning-foreground",
          tone === "muted" && "glass-control text-muted-foreground"
        )}
      >
        <Icon size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-2xl font-semibold leading-7 tracking-normal text-foreground">{value}</span>
        <span className="mt-1 block truncate text-xs font-semibold leading-4 text-muted-foreground">{label}</span>
      </span>
      <ArrowRight className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" size={15} />
    </button>
  );
}

interface PanelProps {
  actionLabel: string;
  children: JSX.Element;
  onAction: () => void;
  title: string;
}

function Panel({ actionLabel, children, onAction, title }: PanelProps): JSX.Element {
  return (
    <Surface className="min-w-0 p-3.5" variant="panel">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold leading-5 tracking-normal">{title}</h2>
        <Button className="shrink-0 gap-1 px-2 text-[11px]" type="button" variant="ghost" size="sm" onClick={onAction}>
          {actionLabel}
          <ArrowRight size={13} />
        </Button>
      </div>
      {children}
    </Surface>
  );
}

interface PanelEmptyProps {
  actionLabel?: string;
  description: string;
  icon: typeof Users;
  onAction?: () => void;
  title: string;
}

function PanelEmpty({ actionLabel, description, icon: Icon, onAction, title }: PanelEmptyProps): JSX.Element {
  return (
    <div className="grid min-h-[126px] place-items-center rounded-md border border-dashed border-border/45 px-4 py-5 text-center">
      <div className="max-w-[320px]">
        <Icon className="mx-auto text-muted-foreground" size={20} />
        <h3 className="mt-2 text-sm font-semibold leading-5">{title}</h3>
        <p className="mt-1 text-xs font-medium leading-5 text-muted-foreground">{description}</p>
        {actionLabel && onAction ? (
          <Button className="mt-3" type="button" variant="outline" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PendingAuthRow({ item, onLogin, t }: { item: DashboardPendingAuthItem; onLogin: () => void; t: Translator }): JSX.Element {
  const isFlowActive = item.pendingKind === "authFlow";
  const isFailed = item.pendingKind === "authFailed";

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border/35 bg-background/18 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <AlertCircle
            className={cn("shrink-0", isFailed ? "text-destructive" : "text-warning-foreground")}
            size={15}
          />
          <p className="min-w-0 truncate text-[13px] font-semibold leading-5">{item.role.name}</p>
        </div>
        <p className="mt-0.5 truncate text-xs font-medium leading-5 text-muted-foreground">
          {getPendingDescription(item, t)}
        </p>
      </div>
      <Button
        className="w-full gap-1.5 sm:w-auto"
        type="button"
        variant={isFailed ? "outline" : "secondary"}
        size="sm"
        onClick={onLogin}
        disabled={item.action.disabled || isFlowActive}
      >
        {isFlowActive ? <Loader2 className="spin" size={14} /> : <LogIn size={14} />}
        {isFlowActive ? t("dashboard.status.authInProgress") : t("dashboard.action.login")}
      </Button>
    </div>
  );
}

function RoleLaunchRow({
  item,
  onLaunch,
  onLogin,
  onStop,
  t
}: {
  item: DashboardRoleItem;
  onLaunch: () => void;
  onLogin: () => void;
  onStop: () => void;
  t: Translator;
}): JSX.Element {
  const actionLabel = getRoleActionLabel(item.action.kind, t);
  const actionIcon = getRoleActionIcon(item.action.kind);

  function handleAction(): void {
    if (item.action.disabled) {
      return;
    }

    if (item.action.kind === "stop") {
      onStop();
      return;
    }

    if (item.action.kind === "login") {
      onLogin();
      return;
    }

    onLaunch();
  }

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border/35 bg-background/18 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-[13px] font-semibold leading-5">{item.role.name}</p>
          <Badge className="shrink-0" variant={getRoleBadgeVariant(item)}>
            {getRoleStatusLabel(item, t)}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-xs font-medium leading-5 text-muted-foreground">{item.role.launchUrl}</p>
      </div>
      <Button
        className="w-full gap-1.5 sm:w-[84px]"
        type="button"
        variant={item.action.kind === "stop" ? "destructive" : "secondary"}
        size="sm"
        onClick={handleAction}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? <Loader2 className="spin" size={14} /> : actionIcon}
        {actionLabel}
      </Button>
    </div>
  );
}

function WorkspaceLaunchRow({
  item,
  onLaunch,
  onStop,
  t
}: {
  item: DashboardWorkspaceItem;
  onLaunch: () => void;
  onStop: () => void;
  t: Translator;
}): JSX.Element {
  const isStop = item.action.kind === "stop";

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border/35 bg-background/18 px-3 py-2.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-5">{item.workspace.name}</p>
          <p className="mt-0.5 text-xs font-medium leading-5 text-muted-foreground">
            {t("dashboard.workspace.assignedRoles").replace("{count}", String(item.assignedCount))}
          </p>
        </div>
        <Badge className="shrink-0" variant={item.runningCount > 0 ? "success" : "muted"}>
          {item.runningCount > 0
            ? t("dashboard.workspace.runningRoles").replace("{count}", String(item.runningCount))
            : t("dashboard.status.ready")}
        </Badge>
      </div>
      <Button
        className="w-full gap-1.5"
        type="button"
        variant={isStop ? "destructive" : "secondary"}
        size="sm"
        onClick={isStop ? onStop : onLaunch}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? <Loader2 className="spin" size={14} /> : isStop ? <Square size={14} /> : <Play size={14} />}
        {isStop ? t("workspaces.stopShort") : t("workspaces.launchShort")}
      </Button>
    </div>
  );
}

function MacroRunRow({
  item,
  onStart,
  onStop,
  t
}: {
  item: DashboardMacroItem;
  onStart: () => void;
  onStop: () => void;
  t: Translator;
}): JSX.Element {
  const isStop = item.action.kind === "stop";

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border/35 bg-background/18 px-3 py-2.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-5">{item.macro.name}</p>
          <p className="mt-0.5 text-xs font-medium leading-5 text-muted-foreground">
            {t("dashboard.macro.assignedRoles").replace("{count}", String(item.assignedCount))}
            {" · "}
            {t("dashboard.macro.stepCount").replace("{count}", String(item.macro.steps.length))}
          </p>
        </div>
        <Badge className="shrink-0" variant={item.runningCount > 0 ? "success" : "muted"}>
          {item.runningCount > 0
            ? t("dashboard.macro.runningRoles").replace("{count}", String(item.runningCount))
            : t("dashboard.status.ready")}
        </Badge>
      </div>
      <Button
        className="w-full gap-1.5"
        type="button"
        variant={isStop ? "destructive" : "secondary"}
        size="sm"
        title={getMacroActionTitle(item, t)}
        onClick={isStop ? onStop : onStart}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? <Loader2 className="spin" size={14} /> : isStop ? <Square size={14} /> : <Play size={14} />}
        {isStop ? t("macros.stopShort") : t("macros.startShort")}
      </Button>
    </div>
  );
}

function getPendingDescription(item: DashboardPendingAuthItem, t: Translator): string {
  if (item.pendingKind === "authFlow" && item.authStatus) {
    return formatAuthFlowState(item.authStatus, t);
  }

  if (item.pendingKind === "authFailed") {
    return t("dashboard.status.authFailed");
  }

  return t("dashboard.status.needsLogin");
}

function getRoleStatusLabel(item: DashboardRoleItem, t: Translator): string {
  if (item.authStatus && item.authStatus.state !== "failed") {
    return formatAuthFlowState(item.authStatus, t);
  }

  if (item.status?.state === "launching") {
    return t("dashboard.status.launching");
  }

  if (item.status?.state === "running") {
    return t("dashboard.status.running");
  }

  if (item.status?.state === "stopping") {
    return t("dashboard.status.stopping");
  }

  if (item.authStatus?.state === "failed" || item.role.authState === "auth_failed") {
    return t("dashboard.status.authFailed");
  }

  if (item.role.authState !== "authenticated") {
    return t("dashboard.status.needsLogin");
  }

  return t("dashboard.status.ready");
}

function getRoleBadgeVariant(item: DashboardRoleItem): "destructive" | "muted" | "success" | "warning" {
  if (item.authStatus && item.authStatus.state !== "failed") {
    return "warning";
  }

  if (item.status?.state === "running") {
    return "success";
  }

  if (item.status?.state === "launching" || item.status?.state === "stopping") {
    return "warning";
  }

  if (item.authStatus?.state === "failed" || item.role.authState === "auth_failed") {
    return "destructive";
  }

  return item.role.authState === "authenticated" ? "muted" : "warning";
}

function getRoleActionLabel(kind: DashboardRoleItem["action"]["kind"], t: Translator): string {
  switch (kind) {
    case "launch":
      return t("role.launch");
    case "login":
      return t("dashboard.action.login");
    case "stop":
      return t("role.stop");
  }
}

function getRoleActionIcon(kind: DashboardRoleItem["action"]["kind"]): JSX.Element {
  switch (kind) {
    case "launch":
      return <Play size={14} />;
    case "login":
      return <LogIn size={14} />;
    case "stop":
      return <Square size={14} />;
  }
}

function getMacroActionTitle(item: DashboardMacroItem, t: Translator): string | undefined {
  if (item.action.disabledReason === "noRoles") {
    return t("dashboard.macro.noRoles");
  }

  if (item.action.disabledReason === "rolesNotRunning") {
    return t("macros.launchRoleFirst");
  }

  return undefined;
}

export default DashboardRoute;
