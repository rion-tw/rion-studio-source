import { AlertTriangle, ArrowLeft, CheckCircle2, Gamepad2, Keyboard, LayoutDashboard, Loader2, LogIn, Pencil, Play, Plus, Square, Users, XCircle } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { getGameIconUrl } from "../../app/gamePresentation";
import { EmptyState } from "../../components/EmptyState";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PageFrame, PageHeader, Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import type { AuthFlowStatus, Game, GameCompatibilityReport, GameCompatibilityRunStatus, LaunchWorkspace, Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";

type Tab = "roles" | "workspaces" | "macros" | "compatibility";

interface GameDetailRouteProps {
  authStatusByRole: Map<string, AuthFlowStatus>;
  busyMacroIds: ReadonlySet<string>;
  busyRoleIds: ReadonlySet<string>;
  busyWorkspaceIds: ReadonlySet<string>;
  games: Game[];
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  reports: GameCompatibilityReport[];
  roles: Role[];
  runStatuses: GameCompatibilityRunStatus[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaces: LaunchWorkspace[];
  onApplyRecommendation: (game: Game) => void;
  onCancelCheck: (gameId: string) => void;
  onEdit: (game: Game) => void;
  onEditMacro: (macro: Macro) => void;
  onEditRole: (role: Role) => void;
  onEditWorkspace: (workspace: LaunchWorkspace) => void;
  onLaunchRole: (roleId: string) => void;
  onLaunchWorkspace: (workspace: LaunchWorkspace) => void;
  onLoginRole: (roleId: string) => void;
  onNewRole: (gameId: string) => void;
  onOpenGraphicsSettings: (gameId: string) => void;
  onRunCheck: (gameId: string) => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  onStopRole: (roleId: string) => void;
  onStopWorkspace: (workspace: LaunchWorkspace) => void;
}

function GameDetailRoute(props: GameDetailRouteProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("roles");
  const game = props.games.find((item) => item.id === id);
  const relations = useMemo(() => game ? buildRelations(game.id, props.roles, props.workspaces, props.macros) : undefined, [game, props.roles, props.workspaces, props.macros]);
  if (!game || !relations) return <EmptyState icon={Gamepad2} title={props.t("games.notFound")} description={props.t("games.notFoundDescription")} actionLabel={props.t("games.back")} onAction={() => navigate("/games", { replace: true })} />;
  const iconUrl = getGameIconUrl(game);
  const report = props.reports.find((item) => item.gameId === game.id);
  const runStatus = props.runStatuses.find((item) => item.gameId === game.id);

  return <PageFrame>
    <PageHeader
      kicker={<button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => navigate("/games")}><ArrowLeft size={12} />{props.t("games.back")}</button>}
      title={<span className="inline-flex items-center gap-3">{iconUrl ? <img className="size-10 rounded-lg object-cover" src={iconUrl} alt="" /> : <span className="grid size-10 place-items-center rounded-lg bg-muted"><Gamepad2 size={20} /></span>}<span>{game.name}</span></span>}
      description={game.defaultLaunchUrl}
      actions={<><Button variant="outline" onClick={() => props.onEdit(game)}><Pencil size={15} />{props.t("common.edit")}</Button><Button onClick={() => props.onNewRole(game.id)}><Plus size={15} />{props.t("games.addRole")}</Button></>}
    />
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted/45 p-1">
      {(["roles", "workspaces", "macros", "compatibility"] as const).map((value) => <button key={value} type="button" className={`shrink-0 rounded-md px-3 py-2 text-xs font-semibold ${tab === value ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={() => setTab(value)}>{props.t(`games.tab.${value}` as "games.tab.roles")} <span className="ml-1 opacity-65">{value === "roles" ? relations.roles.length : value === "workspaces" ? relations.workspaces.length : value === "macros" ? relations.macros.length : ""}</span></button>)}
    </div>
    {tab === "roles" ? <RoleTab authStatusByRole={props.authStatusByRole} busyRoleIds={props.busyRoleIds} roles={relations.roles} statusByRole={props.statusByRole} t={props.t} onEdit={props.onEditRole} onLaunch={props.onLaunchRole} onLogin={props.onLoginRole} onStop={props.onStopRole} /> : null}
    {tab === "workspaces" ? <WorkspaceTab busyWorkspaceIds={props.busyWorkspaceIds} items={relations.workspaces} statusByRole={props.statusByRole} t={props.t} onEdit={props.onEditWorkspace} onLaunch={props.onLaunchWorkspace} onStop={props.onStopWorkspace} /> : null}
    {tab === "macros" ? <MacroTab busyMacroIds={props.busyMacroIds} items={relations.macros} macroStatuses={props.macroStatuses} statusByRole={props.statusByRole} t={props.t} onEdit={props.onEditMacro} onStart={props.onStartMacro} onStop={props.onStopMacro} /> : null}
    {tab === "compatibility" ? <CompatibilityTab game={game} report={report} runStatus={runStatus} t={props.t} onApply={() => props.onApplyRecommendation(game)} onCancel={() => props.onCancelCheck(game.id)} onOpenGraphicsSettings={() => props.onOpenGraphicsSettings(game.id)} onRun={() => props.onRunCheck(game.id)} /> : null}
  </PageFrame>;
}

function RoleTab({ authStatusByRole, busyRoleIds, roles, statusByRole, t, onEdit, onLaunch, onLogin, onStop }: { authStatusByRole: Map<string, AuthFlowStatus>; busyRoleIds: ReadonlySet<string>; roles: Role[]; statusByRole: Map<string, RoleStatus>; t: Translator; onEdit: (role: Role) => void; onLaunch: (id: string) => void; onLogin: (id: string) => void; onStop: (id: string) => void }): JSX.Element {
  if (!roles.length) return <EmptyState icon={Users} title={t("games.detail.noRoles")} description={t("games.detail.noRolesDescription")} />;
  return <div className="grid gap-2">{roles.map((role) => {
    const status = statusByRole.get(role.id);
    const authStatus = authStatusByRole.get(role.id);
    const running = Boolean(status);
    const busy = busyRoleIds.has(role.id) || status?.state === "launching" || status?.state === "stopping" || Boolean(authStatus && authStatus.state !== "failed");
    return <Card key={role.id} className="flex items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{role.name}</p><p className="truncate text-xs text-muted-foreground">{role.launchUrl}</p></div><Badge variant={role.authState === "authenticated" ? "success" : "warning"}>{role.authState === "authenticated" ? t("games.auth.ready") : t("games.needsLogin")}</Badge><Button aria-label={role.authState === "authenticated" ? t("role.relogin") : t("role.login")} size="icon" variant="ghost" disabled={busy} onClick={() => onLogin(role.id)}><LogIn size={15} /></Button><Button aria-label={t("role.edit")} size="icon" variant="ghost" disabled={busy} onClick={() => onEdit(role)}><Pencil size={15} /></Button><Button aria-label={running ? t("role.stop") : t("role.launch")} size="icon" variant={running ? "secondary" : "default"} disabled={busy || (!running && role.authState !== "authenticated")} onClick={() => running ? onStop(role.id) : onLaunch(role.id)}>{busy ? <Loader2 className="spin" size={14} /> : running ? <Square size={14} /> : <Play size={14} />}</Button></Card>;
  })}</div>;
}

function WorkspaceTab({ busyWorkspaceIds, items, statusByRole, t, onEdit, onLaunch, onStop }: { busyWorkspaceIds: ReadonlySet<string>; items: Array<{ workspace: LaunchWorkspace; mixed: boolean }>; statusByRole: Map<string, RoleStatus>; t: Translator; onEdit: (workspace: LaunchWorkspace) => void; onLaunch: (workspace: LaunchWorkspace) => void; onStop: (workspace: LaunchWorkspace) => void }): JSX.Element {
  if (!items.length) return <EmptyState icon={LayoutDashboard} title={t("games.detail.noWorkspaces")} />;
  return <div className="grid gap-2">{items.map(({ workspace, mixed }) => {
    const running = workspace.slots.some((slot) => slot.roleId && statusByRole.has(slot.roleId));
    const busy = busyWorkspaceIds.has(workspace.id);
    const hasRoles = workspace.slots.some((slot) => slot.roleId);
    return <Card key={workspace.id} className="flex items-center gap-3 p-3"><LayoutDashboard size={17} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{workspace.name}</span>{mixed ? <Badge variant="secondary">{t("games.mixed")}</Badge> : null}<Button aria-label={t("workspaces.edit")} size="icon" variant="ghost" disabled={busy || running} onClick={() => onEdit(workspace)}><Pencil size={15} /></Button><Button aria-label={running ? t("workspaces.stop") : t("workspaces.launch")} size="icon" variant={running ? "secondary" : "default"} disabled={busy || !hasRoles} onClick={() => running ? onStop(workspace) : onLaunch(workspace)}>{busy ? <Loader2 className="spin" size={14} /> : running ? <Square size={14} /> : <Play size={14} />}</Button></Card>;
  })}</div>;
}

function MacroTab({ busyMacroIds, items, macroStatuses, statusByRole, t, onEdit, onStart, onStop }: { busyMacroIds: ReadonlySet<string>; items: Array<{ macro: Macro; mixed: boolean }>; macroStatuses: MacroRunStatus[]; statusByRole: Map<string, RoleStatus>; t: Translator; onEdit: (macro: Macro) => void; onStart: (id: string) => void; onStop: (id: string) => void }): JSX.Element {
  if (!items.length) return <EmptyState icon={Keyboard} title={t("games.detail.noMacros")} />;
  return <div className="grid gap-2">{items.map(({ macro, mixed }) => {
    const runs = macroStatuses.filter((status) => status.macroId === macro.id);
    const running = runs.some((status) => status.state === "running" || status.state === "stopping");
    const busy = busyMacroIds.has(macro.id) || runs.some((status) => status.state === "stopping");
    const runnable = macro.roleIds.some((roleId) => statusByRole.get(roleId)?.state === "running" && statusByRole.get(roleId)?.automationState !== "unavailable");
    return <Card key={macro.id} className="flex items-center gap-3 p-3"><Keyboard size={17} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{macro.name}</span>{mixed ? <Badge variant="secondary">{t("games.mixed")}</Badge> : null}<Button aria-label={t("macros.edit")} size="icon" variant="ghost" disabled={busy || running} onClick={() => onEdit(macro)}><Pencil size={15} /></Button><Button aria-label={running ? t("macros.stopShort") : t("macros.startShort")} size="icon" variant={running ? "secondary" : "default"} disabled={busy || (!running && !runnable)} onClick={() => running ? onStop(macro.id) : onStart(macro.id)}>{busy ? <Loader2 className="spin" size={14} /> : running ? <Square size={14} /> : <Play size={14} />}</Button></Card>;
  })}</div>;
}

function CompatibilityTab({ game, report, runStatus, t, onApply, onCancel, onOpenGraphicsSettings, onRun }: { game: Game; report?: GameCompatibilityReport; runStatus?: GameCompatibilityRunStatus; t: Translator; onApply: () => void; onCancel: () => void; onOpenGraphicsSettings: () => void; onRun: () => void }): JSX.Element {
  const recommendation = report?.recommendation;
  const observations = report?.observations;
  const observationItems = observations ? [
    ["games.compatibility.observation.embedded", observations.lastEmbeddedSuccessAt],
    ["games.compatibility.observation.external", observations.lastExternalSuccessAt],
    ["games.compatibility.observation.fallback", observations.lastFallbackAt],
    ["games.compatibility.observation.launchFailure", observations.lastLaunchFailureAt, observations.lastLaunchFailureCode],
    ["games.compatibility.observation.authSuccess", observations.lastAuthSuccessAt],
    ["games.compatibility.observation.authFailure", observations.lastAuthFailureAt]
  ].filter((item) => item[1]) : [];
  return <div className="grid gap-4">
    <Surface className="grid gap-3 p-4" variant="inset"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} /><div><p className="text-sm font-semibold">{t("games.compatibility.noticeTitle")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("games.compatibility.notice")}</p></div></div><div className="flex flex-wrap gap-2">{runStatus ? <Button variant="outline" onClick={onCancel}><Loader2 className="spin" size={15} />{t("games.compatibility.cancel")}</Button> : <Button onClick={onRun}>{t("games.compatibility.run")}</Button>}{recommendation?.mode === "external" && game.browserLaunchMode !== "external" ? <Button variant="secondary" onClick={onApply}>{t("games.compatibility.apply")}</Button> : null}{recommendation?.reason === "graphics_unavailable" ? <Button variant="secondary" onClick={onOpenGraphicsSettings}>{t("games.compatibility.graphicsSettings")}</Button> : null}</div>{runStatus ? <p className="text-xs text-muted-foreground">{t("games.compatibility.phase").replace("{phase}", t(`games.compatibility.phase.${runStatus.phase}` as "games.compatibility.phase.loading"))}</p> : null}</Surface>
    {report?.checkedAt ? <Surface className="grid gap-4 p-4" variant="inset"><div className="flex flex-wrap items-center gap-2"><StatusIcon state={report.load?.state} /><p className="font-semibold">{recommendation?.reason === "graphics_unavailable" ? t("games.compatibility.graphicsLimited") : report.load?.state === "available" ? t("games.compatibility.available") : report.load?.state === "cancelled" ? t("games.compatibility.cancelled") : t("games.compatibility.failed")}</p>{report.isStale ? <Badge variant="warning">{t("games.compatibility.stale")}</Badge> : null}<span className="text-xs text-muted-foreground">{new Date(report.checkedAt).toLocaleString()}</span></div><div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4"><Datum label={t("games.compatibility.duration")} value={report.load ? `${report.load.durationMs} ms` : "—"} /><Datum label={t("games.compatibility.origin")} value={report.load?.finalOrigin ?? "—"} /><Datum label="WebGL / WebGL2" value={`${formatAvailability(report.graphics?.webgl, t)} / ${formatAvailability(report.graphics?.webgl2, t)}`} /><Datum label="WebGPU" value={formatAvailability(report.graphics?.webgpu, t)} /><Datum label={t("games.compatibility.renderer")} value={report.graphics?.renderer ?? "—"} /><Datum label={t("games.compatibility.chrome")} value={report.systemChrome ? formatAvailability(report.systemChrome.state, t) : "—"} /><Datum label={t("games.compatibility.recommendation")} value={recommendation ? t(`games.compatibility.recommendation.${recommendation.reason}` as "games.compatibility.recommendation.embedded_available") : "—"} /><Datum label={t("games.compatibility.errorCode")} value={report.load?.errorCode ?? "—"} /></div></Surface> : <EmptyState icon={Gamepad2} title={t("games.compatibility.notChecked")} description={t("games.compatibility.notCheckedDescription")} />}
    {observationItems.length ? <Surface className="grid gap-3 p-4" variant="inset"><p className="text-sm font-semibold">{t("games.compatibility.observations")}</p><div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">{observationItems.map(([labelKey, timestamp, code]) => <Datum key={labelKey} label={t(labelKey as "games.compatibility.observation.embedded")} value={timestamp ? `${new Date(timestamp).toLocaleString()}${code ? ` · ${code}` : ""}` : "—"} />)}</div></Surface> : null}
  </div>;
}

function Datum({ label, value }: { label: string; value: string }): JSX.Element { return <div className="min-w-0 rounded-md bg-muted/45 p-3"><p className="text-muted-foreground">{label}</p><p className="mt-1 break-words font-medium">{value}</p></div>; }
function formatAvailability(value: "available" | "unavailable" | "unknown" | undefined, t: Translator): string { return value ? t(`games.compatibility.capability.${value}` as "games.compatibility.capability.available") : "—"; }
function StatusIcon({ state }: { state?: "available" | "failed" | "cancelled" }): JSX.Element { return state === "available" ? <CheckCircle2 className="text-success" size={19} /> : state === "failed" ? <XCircle className="text-destructive" size={19} /> : <AlertTriangle className="text-warning" size={19} />; }

function buildRelations(gameId: string, roles: Role[], workspaces: LaunchWorkspace[], macros: Macro[]) {
  const gameRoleIds = new Set(roles.filter((role) => role.gameId === gameId).map((role) => role.id));
  const gameByRole = new Map(roles.map((role) => [role.id, role.gameId]));
  return {
    roles: roles.filter((role) => role.gameId === gameId),
    workspaces: workspaces.flatMap((workspace) => {
      const roleIds = workspace.slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []);
      return roleIds.some((id) => gameRoleIds.has(id)) ? [{ workspace, mixed: new Set(roleIds.map((id) => gameByRole.get(id)).filter(Boolean)).size > 1 }] : [];
    }),
    macros: macros.flatMap((macro) => macro.roleIds.some((id) => gameRoleIds.has(id)) ? [{ macro, mixed: new Set(macro.roleIds.map((id) => gameByRole.get(id)).filter(Boolean)).size > 1 }] : [])
  };
}

export default GameDetailRoute;
