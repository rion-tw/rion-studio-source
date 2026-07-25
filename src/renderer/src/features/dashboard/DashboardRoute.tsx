import {
  ArrowRight,
  Gamepad2,
  FileWarning,
  Keyboard,
  LayoutDashboard,
  Loader2,
  MonitorUp,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Users
} from "lucide-react";
import { type JSX, useMemo } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { IconTile, PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import { CreateItemRow } from "../../components/CreateListItem";
import { roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import {
  getBrowserEngineStatusTitle,
  getResolvedBrowserEngineLabel
} from "../../app/browserEnginePresentation";
import type { SidebarFilter } from "../../app/types";
import type { TranslationKey, Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  EmbeddedRuntimeState,
  DiscardSavedGameWindowsInput,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus,
  RestoreSavedGameWindowsInput,
  WorkspaceDisplayInfo
} from "../../../../shared/types";
import {
  createDashboardSummary,
  getDashboardMacroItems,
  getDashboardRoleItems,
  getDashboardWorkspaceItems,
  type DashboardMacroItem,
  type DashboardRoleItem,
  type DashboardWorkspaceItem
} from "./dashboardUtils";

const savedWindowStateLabelKeys: Record<
  "saved" | "restoring" | "failed",
  TranslationKey
> = {
  saved: "dashboard.gameWindows.saved",
  restoring: "dashboard.gameWindows.restoring",
  failed: "dashboard.gameWindows.failed"
};

interface DashboardRouteProps {
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
  onCaptureExternalDiagnostics: (roleId: string) => void;
  onShowGameWindows: (displayId?: number) => void;
  onRestoreSavedGameWindows: (input: RestoreSavedGameWindowsInput) => void;
  onDiscardSavedGameWindows: (input: DiscardSavedGameWindowsInput) => void;
  onStopGameWindow: (displayId: number) => void;
  onLaunchRole: (roleId: string) => void;
  onLaunchWorkspace: (workspace: LaunchWorkspace) => void;
  onNavigateMacros: () => void;
  onNavigateGames: () => void;
  onNavigateRoles: (filter: SidebarFilter) => void;
  onNavigateWorkspaces: () => void;
  onRecoverExternalRole: (roleId: string) => void;
  onNewMacro: () => void;
  onNewRole: () => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  onStopRole: (roleId: string) => void;
  onStopWorkspace: (workspace: LaunchWorkspace) => void;
}

function DashboardRoute({
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
  onCaptureExternalDiagnostics,
  onShowGameWindows,
  onRestoreSavedGameWindows,
  onDiscardSavedGameWindows,
  onStopGameWindow,
  onLaunchRole,
  onLaunchWorkspace,
  onNavigateMacros,
  onNavigateGames,
  onNavigateRoles,
  onNavigateWorkspaces,
  onRecoverExternalRole,
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
    () => getDashboardRoleItems({ busyRoleIds, roles, statusByRole }).slice(0, 6),
    [busyRoleIds, roles, statusByRole]
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

  return (
    <PageFrame>
      <PageHeader
        kicker={t("dashboard.kicker")}
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        actions={
          <>
            {embeddedRuntime.windows.length > 0 || (embeddedRuntime.savedWindows?.length ?? 0) > 0 ? (
              <Button className="w-full gap-1.5 sm:w-auto" type="button" variant="outline" size="sm" onClick={() => onShowGameWindows()}>
                <MonitorUp aria-hidden="true" size={14} />
                {t("dashboard.showGameWindows")}
                <Badge variant="outline">
                  {embeddedRuntime.tabs.length +
                    (embeddedRuntime.savedWindows ?? []).reduce(
                      (total, window) => total + window.tabCount,
                      0
                    )}
                </Badge>
              </Button>
            ) : null}
          </>
        }
      />

      {embeddedRuntime.recovery ? (
        <Surface className="flex flex-col gap-3 border-warning/35 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t("dashboard.gameWindows.recoveryTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("dashboard.gameWindows.recoveryDescription")
                .replace("{windows}", String(embeddedRuntime.recovery.windowCount))
                .replace("{tabs}", String(embeddedRuntime.recovery.tabCount))}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDiscardSavedGameWindows({ scope: "all" })}
            >
              {t("dashboard.gameWindows.discard")}
            </Button>
            <Button
              size="sm"
              onClick={() => onRestoreSavedGameWindows({ scope: "last-visible" })}
            >
              <RotateCcw aria-hidden="true" size={14} />
              {t("dashboard.gameWindows.restore")}
            </Button>
          </div>
        </Surface>
      ) : null}

      {embeddedRuntime.windows.length > 0 || (embeddedRuntime.savedWindows?.length ?? 0) > 0 ? (
        <RuntimeWindowsPanel
          runtime={embeddedRuntime}
          displays={workspaceDisplays}
          t={t}
          onShow={onShowGameWindows}
          onDiscard={onDiscardSavedGameWindows}
          onRestore={onRestoreSavedGameWindows}
          onStop={onStopGameWindow}
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
                    onCaptureDiagnostics={() => onCaptureExternalDiagnostics(item.role.id)}
                    onRecover={() => onRecoverExternalRole(item.role.id)}
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
  onDiscard,
  onRestore,
  onShow,
  onStop,
  runtime,
  t
}: {
  displays: WorkspaceDisplayInfo[];
  onDiscard: (input: DiscardSavedGameWindowsInput) => void;
  onRestore: (input: RestoreSavedGameWindowsInput) => void;
  onShow: (displayId?: number) => void;
  onStop: (displayId: number) => void;
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
            <div
              key={windowSummary.displayId}
              className="flex min-w-0 items-center gap-1 rounded-lg border border-border/55 bg-background/35 p-1"
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
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
              <Button
                aria-label={t("dashboard.gameWindows.stopWindow")}
                size="icon"
                title={t("dashboard.gameWindows.stopWindow")}
                variant="ghost"
                onClick={() => onStop(windowSummary.displayId)}
              >
                <Square aria-hidden="true" size={13} />
              </Button>
            </div>
          );
        })}
        {(runtime.savedWindows ?? []).map((windowSummary) => (
          <div
            key={windowSummary.id}
            className="flex min-w-0 items-center gap-1 rounded-lg border border-border/55 bg-background/35 p-1"
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              disabled={windowSummary.state === "restoring"}
              type="button"
              onClick={() => onRestore({ scope: "window", windowId: windowSummary.id })}
            >
              <IconTile size="sm">
                {windowSummary.state === "restoring" ? (
                  <Loader2 aria-hidden="true" className="animate-spin" size={14} />
                ) : (
                  <RotateCcw aria-hidden="true" size={14} />
                )}
              </IconTile>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {windowSummary.displayLabel}
                </span>
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={windowSummary.failureMessage ?? windowSummary.tabNames.join(", ")}
                >
                  {windowSummary.tabCount} {t("dashboard.gameWindows.tabs")} · {windowSummary.roleCount} {t("dashboard.gameWindows.roles")}
                </span>
              </span>
              <Badge variant={windowSummary.state === "failed" ? "destructive" : "outline"}>
                {t(savedWindowStateLabelKeys[windowSummary.state])}
              </Badge>
            </button>
            <Button
              aria-label={t("dashboard.gameWindows.forget")}
              size="icon"
              title={t("dashboard.gameWindows.forget")}
              variant="ghost"
              onClick={() => onDiscard({ scope: "window", windowId: windowSummary.id })}
            >
              <Trash2 aria-hidden="true" size={13} />
            </Button>
          </div>
        ))}
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

function RoleLaunchRow({
  item,
  onLaunch,
  onCaptureDiagnostics,
  onRecover,
  onStop,
  t
}: {
  item: DashboardRoleItem;
  onLaunch: () => void;
  onCaptureDiagnostics: () => void;
  onRecover: () => void;
  onStop: () => void;
  t: Translator;
}): JSX.Element {
  const actionLabel = getRoleActionLabel(item.action.kind, t);
  const actionIcon = getRoleActionIcon(item.action.kind);
  const coverImageUrl = item.role.coverImageDataUrl ?? roleCoverPlaceholderUrl;
  const status = item.status;
  const isExternalCompatibilitySession = status?.runtimeMode === "external" && status.state === "running";
  const isPageUnresponsive = isExternalCompatibilitySession && status?.pageHealth === "unresponsive";

  function handleAction(): void {
    if (item.action.disabled) {
      return;
    }

    if (item.action.kind === "stop") {
      onStop();
      return;
    }

    onLaunch();
  }

  return (
    <div className="grid min-w-0 grid-cols-[34px_minmax(0,1fr)_auto_auto_76px] items-center gap-2.5 rounded-md border border-border/35 bg-background/18 px-2.5 py-2 transition-colors hover:border-border/55 hover:bg-background/25">
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
        <span title={status ? getBrowserEngineStatusTitle(status, t) : undefined}>
          {getRoleStatusLabel(item, t)}
          {status?.resolvedEngine
            ? ` · ${getResolvedBrowserEngineLabel(status.resolvedEngine, t)}`
            : ""}
        </span>
      </Badge>
      {isExternalCompatibilitySession ? (
        <Button
          aria-label={`${t("roles.reportGameFreeze")}: ${item.role.name}`}
          className="size-[30px] p-0"
          type="button"
          variant="ghost"
          size="sm"
          title={t("roles.reportGameFreeze")}
          onClick={onCaptureDiagnostics}
        >
          <FileWarning aria-hidden="true" size={14} />
        </Button>
      ) : <span aria-hidden="true" />}
      <Button
        aria-label={`${isPageUnresponsive ? t("roles.recoverExternal") : actionLabel}: ${item.role.name}`}
        className="w-[76px] gap-1.5 px-2"
        type="button"
        variant={isPageUnresponsive ? "secondary" : item.action.kind === "stop" ? "destructive" : "secondary"}
        size="sm"
        onClick={isPageUnresponsive ? onRecover : handleAction}
        disabled={item.action.disabled}
      >
        {item.action.isBusy ? <Loader2 aria-hidden="true" className="spin" size={14} /> : isPageUnresponsive ? <RotateCcw aria-hidden="true" size={14} /> : actionIcon}
        {isPageUnresponsive ? t("roles.recoverExternal") : actionLabel}
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

  if (item.action.disabledReason === "unassignedDependency") {
    return t("macros.status.unassignedDependency");
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
  if (item.status?.state === "launching") {
    return t("dashboard.status.launching");
  }

  if (item.status?.state === "running") {
    if (item.status.pageHealth === "unresponsive") {
      return t("dashboard.status.unresponsive");
    }
    return t("dashboard.status.running");
  }

  if (item.status?.state === "stopping") {
    return t("dashboard.status.stopping");
  }

  return t("dashboard.status.ready");
}

function getRoleBadgeVariant(item: DashboardRoleItem): "destructive" | "muted" | "success" | "warning" {
  if (item.status?.state === "running") {
    if (item.status.pageHealth === "unresponsive") {
      return "warning";
    }
    return "success";
  }

  if (item.status?.state === "launching" || item.status?.state === "stopping") {
    return "warning";
  }

  return "muted";
}

function getRoleActionLabel(kind: DashboardRoleItem["action"]["kind"], t: Translator): string {
  switch (kind) {
    case "launch":
      return t("role.launch");
    case "stop":
      return t("role.stop");
  }
}

function getRoleActionIcon(kind: DashboardRoleItem["action"]["kind"]): JSX.Element {
  switch (kind) {
    case "launch":
      return <Play aria-hidden="true" size={14} />;
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

  if (item.action.disabledReason === "unassignedDependency") {
    return t("macros.assignCalledMacroRoleFirst");
  }

  return undefined;
}

export default DashboardRoute;
