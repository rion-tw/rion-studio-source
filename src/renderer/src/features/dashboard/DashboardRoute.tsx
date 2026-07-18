import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Gamepad2,
  Keyboard,
  LayoutDashboard,
  Loader2,
  LogIn,
  MonitorUp,
  Play,
  Plus,
  Square,
  Users
} from "lucide-react";
import { type JSX, useMemo } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { IconTile, PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { CreateItemRow } from "../../components/CreateListItem";
import { roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import { formatAuthFlowState } from "../../app/statusUtils";
import type { SidebarFilter } from "../../app/types";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  AuthFlowStatus,
  EmbeddedRuntimeState,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus,
  WorkspaceDisplayInfo
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
  embeddedRuntime: EmbeddedRuntimeState;
  gameCount: number;
  busyMacroIds: ReadonlySet<string>;
  busyRoleIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  busyWorkspaceIds: ReadonlySet<string>;
  macroStatusByRun: Map<string, MacroRunStatus>;
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  roleStatuses: RoleStatus[];
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaces: LaunchWorkspace[];
  workspaceDisplays: WorkspaceDisplayInfo[];
  onCreateWorkspace: () => void;
  onShowGameWindows: (displayId?: number) => void;
  onLaunchRole: (roleId: string) => void;
  onLaunchWorkspace: (workspace: LaunchWorkspace) => void;
  onLoginRole: (roleId: string) => void;
  onNavigateMacros: () => void;
  onNavigateGames: () => void;
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
  embeddedRuntime,
  busyMacroIds,
  busyRoleIds,
  busyRunKeys,
  busyWorkspaceIds,
  gameCount,
  macroStatusByRun,
  macroStatuses,
  macros,
  roleStatuses,
  roles,
  statusByRole,
  t,
  workspaces,
  workspaceDisplays,
  onCreateWorkspace,
  onShowGameWindows,
  onLaunchRole,
  onLaunchWorkspace,
  onLoginRole,
  onNavigateMacros,
  onNavigateGames,
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
    () => getDashboardRoleItems({ authStatusByRole, busyRoleIds, roles, statusByRole }).slice(0, 6),
    [authStatusByRole, busyRoleIds, roles, statusByRole]
  );
  const pendingItems = useMemo(
    () => getPendingAuthItems({ authStatusByRole, busyRoleIds, roles, statusByRole }),
    [authStatusByRole, busyRoleIds, roles, statusByRole]
  );
  const workspaceItems = useMemo(
    () => getDashboardWorkspaceItems({ busyWorkspaceIds, statusByRole, workspaces }).slice(0, 4),
    [busyWorkspaceIds, statusByRole, workspaces]
  );
  const macroItems = useMemo(
    () =>
      getDashboardMacroItems({
        busyMacroIds,
        busyRunKeys,
        macroStatusByRun,
        macros,
        roles,
        statusByRole
      }).slice(0, 5),
    [busyMacroIds, busyRunKeys, macroStatusByRun, macros, roles, statusByRole]
  );
  const visiblePendingItems = pendingItems.slice(0, 3);

  return (
    <PageFrame>
      <PageHeader
        kicker={t("dashboard.kicker")}
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        actions={
          <>
            {embeddedRuntime.windows.length > 0 ? (
              <Button className="w-full gap-1.5 sm:w-auto" type="button" variant="outline" size="sm" onClick={() => onShowGameWindows()}>
                <MonitorUp aria-hidden="true" size={14} />
                {t("dashboard.showGameWindows")}
                <Badge variant="outline">{embeddedRuntime.tabs.length}</Badge>
              </Button>
            ) : null}
            <Button className="w-full gap-1.5 sm:w-auto" type="button" variant="outline" size="sm" onClick={onNewRole}>
              <Plus aria-hidden="true" size={14} />
              {t("roles.newRole")}
            </Button>
          </>
        }
      />

      {embeddedRuntime.windows.length > 0 ? (
        <RuntimeWindowsPanel
          runtime={embeddedRuntime}
          displays={workspaceDisplays}
          t={t}
          onShow={onShowGameWindows}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-2.5 min-[1200px]:grid-cols-5">
        <StatCard
          icon={Gamepad2}
          label={t("dashboard.stat.games")}
          value={gameCount}
          tone="muted"
          onClick={onNavigateGames}
        />
        <StatCard
          icon={Users}
          label={t("dashboard.stat.runningRoles")}
          value={`${summary.runningRoles}/${summary.totalRoles}`}
          tone={summary.runningRoles > 0 ? "success" : "muted"}
          onClick={() => onNavigateRoles("running")}
        />
        <StatCard
          icon={LogIn}
          label={t("dashboard.stat.needsLogin")}
          value={summary.rolesNeedingLogin}
          tone={summary.rolesNeedingLogin > 0 ? "warning" : "success"}
          onClick={() => onNavigateRoles("needsLogin")}
        />
        <StatCard
          icon={LayoutDashboard}
          label={t("dashboard.stat.workspaces")}
          value={summary.workspaceCount}
          tone="muted"
          onClick={onNavigateWorkspaces}
        />
        <StatCard
          icon={Keyboard}
          label={t("dashboard.stat.runningMacros")}
          value={`${summary.runningMacros}/${summary.totalMacros}`}
          tone={summary.runningMacros > 0 ? "success" : "muted"}
          onClick={onNavigateMacros}
        />
      </div>

      {pendingItems.length > 0 ? (
        <AttentionPanel
          items={visiblePendingItems}
          totalCount={pendingItems.length}
          t={t}
          onLoginRole={onLoginRole}
          onViewAll={() => onNavigateRoles("needsLogin")}
        />
      ) : null}

      <div className="grid min-w-0 items-start gap-4 md:grid-cols-3">
        <div className="grid min-w-0 gap-4">
          <Panel
            title={t("dashboard.quickRoles.title")}
            count={roles.length}
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
                <CreateItemRow label={t("roles.newRole")} onClick={onNewRole} />
              </div>
            )}
          </Panel>
        </div>

        <Panel
          title={t("dashboard.workspaces.title")}
          count={workspaces.length}
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
              <CreateItemRow label={t("workspaces.newWorkspace")} onClick={onCreateWorkspace} />
            </div>
          )}
        </Panel>

        <Panel
          title={t("dashboard.macros.title")}
          count={macros.length}
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
              <CreateItemRow label={t("macros.newMacro")} onClick={onNewMacro} />
            </div>
          )}
        </Panel>
      </div>
    </PageFrame>
  );
}

function RuntimeWindowsPanel({
  displays,
  onShow,
  runtime,
  t
}: {
  displays: WorkspaceDisplayInfo[];
  onShow: (displayId?: number) => void;
  runtime: EmbeddedRuntimeState;
  t: Translator;
}): JSX.Element {
  const displayById = new Map(displays.map((display) => [display.id, display]));

  return (
    <Surface className="grid gap-2.5 p-3" variant="strong">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MonitorUp aria-hidden="true" size={15} />
          {t("dashboard.gameWindows.title")}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onShow()}>
          {t("dashboard.gameWindows.showAll")}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {runtime.windows.map((windowSummary) => {
          const tabs = runtime.tabs.filter((tab) => tab.displayId === windowSummary.displayId);
          const roleCount = new Set(tabs.flatMap((tab) => tab.roleIds)).size;
          const display = displayById.get(windowSummary.displayId);
          return (
            <button
              key={windowSummary.displayId}
              className="flex min-w-0 items-center gap-3 rounded-lg border border-border/55 bg-background/35 px-3 py-2 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              type="button"
              onClick={() => onShow(windowSummary.displayId)}
            >
              <IconTile
                className={windowSummary.visible ? "border-success-foreground/15 bg-success/75 text-success-foreground" : undefined}
                size="sm"
              >
                <MonitorUp aria-hidden="true" size={14} />
              </IconTile>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {display?.label || `${t("dashboard.gameWindows.display")} ${windowSummary.displayId}`}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {windowSummary.tabCount} {t("dashboard.gameWindows.tabs")} · {roleCount} {t("dashboard.gameWindows.roles")}
                </span>
              </span>
              <Badge variant="outline">
                {t(windowSummary.visible ? "dashboard.gameWindows.visible" : "dashboard.gameWindows.hidden")}
              </Badge>
            </button>
          );
        })}
      </div>
    </Surface>
  );
}

interface StatCardProps {
  icon: typeof Users;
  label: string;
  onClick: () => void;
  tone?: "muted" | "success" | "warning";
  value: number | string;
}

function StatCard({ icon: Icon, label, onClick, tone = "muted", value }: StatCardProps): JSX.Element {
  return (
    <button
      aria-label={`${label}: ${value}`}
      className="glass-panel-strong group relative flex min-h-[76px] min-w-0 items-center gap-3 rounded-lg px-5 py-2.5 text-left transition-[background-color,border-color,box-shadow] hover:border-border/50 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20"
      type="button"
      onClick={onClick}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-8 shrink-0",
          tone === "success" && "text-success-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "muted" && "text-muted-foreground"
        )}
        strokeWidth={1.25}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-xl font-semibold leading-6 tracking-tight text-foreground">{value}</span>
        <span className="mt-0.5 block truncate text-[11px] font-semibold leading-4 text-muted-foreground">{label}</span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="absolute right-2.5 top-2.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        size={13}
      />
    </button>
  );
}

interface AttentionPanelProps {
  items: DashboardPendingAuthItem[];
  onLoginRole: (roleId: string) => void;
  onViewAll: () => void;
  t: Translator;
  totalCount: number;
}

function AttentionPanel({ items, onLoginRole, onViewAll, t, totalCount }: AttentionPanelProps): JSX.Element {
  if (totalCount === 0) {
    return (
      <Surface
        className="flex min-w-0 items-center gap-3 border-success-foreground/10 px-3.5 py-3"
        role="status"
        variant="panel"
      >
        <IconTile className="border-success-foreground/15 bg-success/75 text-success-foreground" size="md">
          <CheckCircle2 aria-hidden="true" size={16} />
        </IconTile>
        <div className="min-w-0 sm:flex sm:items-baseline sm:gap-2">
          <p className="shrink-0 text-[13px] font-semibold leading-5">{t("dashboard.pending.emptyTitle")}</p>
          <p className="truncate text-xs font-medium leading-5 text-muted-foreground">
            {t("dashboard.pending.emptyDescription")}
          </p>
        </div>
      </Surface>
    );
  }

  return (
    <Surface className="min-w-0 border-warning-foreground/15 p-3.5" variant="strong">
      <div className="mb-3 flex min-w-0 items-center gap-2.5">
        <IconTile className="border-warning-foreground/15 bg-warning/75 text-warning-foreground" size="md">
          <AlertCircle aria-hidden="true" size={16} />
        </IconTile>
        <h2 className="min-w-0 truncate text-sm font-semibold leading-5">{t("dashboard.pending.title")}</h2>
        <Badge className="shrink-0" variant="warning">
          {totalCount}
        </Badge>
        <Button
          aria-label={`${t("dashboard.viewRoles")}: ${t("dashboard.pending.title")}`}
          className="ml-auto shrink-0 gap-1 px-2 text-[11px]"
          type="button"
          variant="ghost"
          size="sm"
          onClick={onViewAll}
        >
          {t("dashboard.viewRoles")}
          <ArrowRight aria-hidden="true" size={13} />
        </Button>
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <PendingAuthRow key={item.role.id} item={item} t={t} onLogin={() => onLoginRole(item.role.id)} />
        ))}
      </div>
    </Surface>
  );
}

interface PanelProps {
  actionLabel: string;
  children: JSX.Element;
  count: number;
  onAction: () => void;
  title: string;
}

function Panel({ actionLabel, children, count, onAction, title }: PanelProps): JSX.Element {
  return (
    <Surface className="min-w-0 p-3.5" variant="panel">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold leading-5 tracking-normal">{title}</h2>
          <Badge className="shrink-0" variant="secondary">
            {count}
          </Badge>
        </div>
        <Button
          aria-label={`${actionLabel}: ${title}`}
          className="shrink-0 gap-1 px-2 text-[11px]"
          type="button"
          variant="ghost"
          size="sm"
          onClick={onAction}
        >
          {actionLabel}
          <ArrowRight aria-hidden="true" size={13} />
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
    <div className="grid min-h-[112px] place-items-center rounded-md border border-dashed border-border/45 bg-background/10 px-4 py-4 text-center">
      <div className="max-w-[320px]">
        <Icon aria-hidden="true" className="mx-auto text-muted-foreground" size={19} />
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
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/35 bg-background/18 px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <AlertCircle
            aria-hidden="true"
            className={cn("shrink-0", isFailed ? "text-destructive" : "text-warning-foreground")}
            size={15}
          />
          <p className="min-w-0 truncate text-[13px] font-semibold leading-5" title={item.role.name}>
            {item.role.name}
          </p>
        </div>
        <p className="mt-0.5 truncate text-xs font-medium leading-5 text-muted-foreground">
          {getPendingDescription(item, t)}
        </p>
      </div>
      <Button
        className="mt-auto w-full gap-1.5"
        type="button"
        variant={isFailed ? "outline" : "secondary"}
        size="sm"
        onClick={onLogin}
        disabled={item.action.disabled || isFlowActive}
      >
        {isFlowActive ? <Loader2 aria-hidden="true" className="spin" size={14} /> : <LogIn aria-hidden="true" size={14} />}
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
  const coverImageUrl = item.role.coverImageDataUrl ?? roleCoverPlaceholderUrl;

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
    <div className="grid min-w-0 grid-cols-[34px_minmax(0,1fr)_auto_76px] items-center gap-2.5 rounded-md border border-border/35 bg-background/18 px-2.5 py-2 transition-colors hover:border-border/55 hover:bg-background/25">
      <img
        aria-hidden="true"
        alt=""
        className="size-[34px] shrink-0 rounded-md object-cover shadow-sm ring-1 ring-border/45"
        src={coverImageUrl}
      />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold leading-5" title={item.role.name}>
          {item.role.name}
        </p>
        <span className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-muted-foreground" title={item.role.launchUrl}>
          {formatLaunchUrl(item.role.launchUrl)}
        </span>
      </div>
      <Badge className="h-[18px] justify-self-end px-1.5 text-[10px]" variant={getRoleBadgeVariant(item)}>
        {getRoleStatusLabel(item, t)}
      </Badge>
      <Button
        aria-label={`${actionLabel}: ${item.role.name}`}
        className="w-[76px] gap-1.5 px-2"
        type="button"
        variant={item.action.kind === "stop" ? "destructive" : "secondary"}
        size="sm"
        onClick={handleAction}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? <Loader2 aria-hidden="true" className="spin" size={14} /> : actionIcon}
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
  const actionLabel = isStop ? t("workspaces.stopShort") : t("workspaces.launchShort");

  return (
    <div className="grid min-w-0 grid-cols-[30px_minmax(0,1fr)_auto_72px] items-center gap-2 rounded-md border border-border/35 bg-background/18 px-2.5 py-2 transition-colors hover:border-border/55 hover:bg-background/25">
      <IconTile size="md">
        <LayoutDashboard aria-hidden="true" size={15} />
      </IconTile>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold leading-5" title={item.workspace.name}>
          {item.workspace.name}
        </p>
        <span className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-muted-foreground">
          {t("dashboard.workspace.assignedRoles").replace("{count}", String(item.assignedCount))}
        </span>
      </div>
      <Badge
        className="h-[18px] justify-self-end px-1.5 text-[10px]"
        variant={item.runningCount > 0 ? "success" : "muted"}
      >
        {getWorkspaceStatusLabel(item, t)}
      </Badge>
      <Button
        aria-label={`${actionLabel}: ${item.workspace.name}`}
        className="w-[72px] gap-1.5 px-2"
        type="button"
        variant={isStop ? "destructive" : "secondary"}
        size="sm"
        onClick={isStop ? onStop : onLaunch}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? (
          <Loader2 aria-hidden="true" className="spin" size={14} />
        ) : isStop ? (
          <Square aria-hidden="true" size={14} />
        ) : (
          <Play aria-hidden="true" size={14} />
        )}
        {actionLabel}
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
  const actionLabel = isStop ? t("macros.stopShort") : t("macros.startShort");

  return (
    <div className="grid min-w-0 grid-cols-[30px_minmax(0,1fr)_auto_72px] items-center gap-2 rounded-md border border-border/35 bg-background/18 px-2.5 py-2 transition-colors hover:border-border/55 hover:bg-background/25">
      <IconTile size="md">
        <Keyboard aria-hidden="true" size={15} />
      </IconTile>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold leading-5" title={item.macro.name}>
          {item.macro.name}
        </p>
        <span className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-muted-foreground">
          {t("dashboard.macro.assignedRoles").replace("{count}", String(item.assignedCount))}
          {" · "}
          {t("dashboard.macro.stepCount").replace("{count}", String(item.macro.steps.length))}
        </span>
      </div>
      <Badge
        className="h-[18px] justify-self-end px-1.5 text-[10px]"
        variant={item.runningCount > 0 ? "success" : "muted"}
      >
        {getMacroStatusLabel(item, t)}
      </Badge>
      <Button
        aria-label={`${actionLabel}: ${item.macro.name}`}
        className="w-[72px] gap-1.5 px-2"
        type="button"
        variant={isStop ? "destructive" : "secondary"}
        size="sm"
        title={getMacroActionTitle(item, t)}
        onClick={isStop ? onStop : onStart}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? (
          <Loader2 aria-hidden="true" className="spin" size={14} />
        ) : isStop ? (
          <Square aria-hidden="true" size={14} />
        ) : (
          <Play aria-hidden="true" size={14} />
        )}
        {actionLabel}
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

function getWorkspaceStatusLabel(item: DashboardWorkspaceItem, t: Translator): string {
  if (item.runningCount > 0) {
    return t("dashboard.workspace.runningRoles").replace("{count}", String(item.runningCount));
  }

  return item.assignedCount > 0 ? t("dashboard.status.ready") : t("dashboard.status.notConfigured");
}

function getMacroStatusLabel(item: DashboardMacroItem, t: Translator): string {
  if (item.runningCount > 0) {
    return t("dashboard.macro.runningRoles").replace("{count}", String(item.runningCount));
  }

  if (item.action.disabledReason === "noRoles") {
    return t("dashboard.status.notConfigured");
  }

  if (item.action.disabledReason === "macroDisabled") {
    return t("macros.status.disabled");
  }

  if (item.action.disabledReason === "rolesNotRunning") {
    return t("dashboard.status.waitingForRoles");
  }

  if (item.action.disabledReason === "automationUnavailable") {
    return t("macros.automationUnavailable");
  }

  return t("dashboard.status.ready");
}

function formatLaunchUrl(launchUrl: string): string {
  try {
    return new URL(launchUrl).hostname;
  } catch {
    return launchUrl;
  }
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
      return <Play aria-hidden="true" size={14} />;
    case "login":
      return <LogIn aria-hidden="true" size={14} />;
    case "stop":
      return <Square aria-hidden="true" size={14} />;
  }
}

function getMacroActionTitle(item: DashboardMacroItem, t: Translator): string | undefined {
  if (item.action.disabledReason === "macroDisabled") {
    return t("macros.disabledHint");
  }

  if (item.action.disabledReason === "noRoles") {
    return t("dashboard.macro.noRoles");
  }

  if (item.action.disabledReason === "rolesNotRunning") {
    return t("macros.launchRoleFirst");
  }

  if (item.action.disabledReason === "automationUnavailable") {
    return t("macros.automationUnavailable");
  }

  return undefined;
}

export default DashboardRoute;
