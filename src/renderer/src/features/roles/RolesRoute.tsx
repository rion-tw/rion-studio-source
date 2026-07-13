import {
  AlertCircle,
  Copy,
  Globe2,
  Loader2,
  LogIn,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2
} from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardTitle } from "../../components/ui/card";
import { PageFrame, PageHeader, SegmentedControl, Surface } from "../../components/ui/patterns";
import { EmptyState } from "../../components/EmptyState";
import { SearchField } from "../../components/SearchField";
import { launchUrlOptions } from "../../app/constants";
import { localizeErrorMessage, type Language, type TranslationKey, type Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { AuthFlowStatus, Role, RoleStatus } from "../../../../shared/types";
import type { AppStats, SidebarFilter } from "../../app/types";
import { formatAuthFlowState, shouldShowLoginGuidance } from "../../app/statusUtils";
import { createRoleCardStyle } from "./roleCardStyle";
import { LoginSessionGuide } from "./LoginSessionGuide";

const filterLabelKeys: Record<SidebarFilter, TranslationKey> = {
  all: "roles.filter.all",
  running: "roles.filter.running",
  stopped: "roles.filter.stopped",
  needsLogin: "roles.filter.needsLogin"
};

const filterOrder: SidebarFilter[] = ["all", "running", "stopped", "needsLogin"];

interface RolesViewProps {
  activeFilter: SidebarFilter;
  authStatusByRole: Map<string, AuthFlowStatus>;
  busyRoleId: string | null;
  filteredRoles: Role[];
  language: Language;
  roleStats: AppStats;
  roles: Role[];
  query: string;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onClearQuery: () => void;
  onCopy: (role: Role) => void;
  onDelete: (role: Role) => void;
  onEdit: (role: Role) => void;
  onFilterChange: (filter: SidebarFilter) => void;
  onLaunch: (roleId: string) => void;
  onLogin: (roleId: string) => void;
  onNewRole: () => void;
  onQueryChange: (query: string) => void;
  onStop: (roleId: string) => void;
}

function RolesView({
  activeFilter,
  authStatusByRole,
  busyRoleId,
  filteredRoles,
  language,
  roleStats,
  roles,
  query,
  statusByRole,
  t,
  onClearQuery,
  onCopy,
  onDelete,
  onEdit,
  onFilterChange,
  onLaunch,
  onLogin,
  onNewRole,
  onQueryChange,
  onStop
}: RolesViewProps): JSX.Element {
  const filterCounts: Record<SidebarFilter, number> = {
    all: roleStats.total,
    running: roleStats.running,
    stopped: roleStats.stopped,
    needsLogin: roleStats.needsLogin
  };
  const activeLoginGuides = roles.flatMap((role) => {
    const authStatus = authStatusByRole.get(role.id);
    return shouldShowLoginGuidance(authStatus) ? [{ role, authStatus }] : [];
  });

  return (
    <PageFrame>
      <PageHeader
        kicker={t("roles.kicker")}
        title={t("roles.title")}
        description={t("roles.description")}
        actions={
          <>
            <SearchField
              className="w-full sm:w-44 lg:w-48"
              placeholder={t("roles.searchPlaceholder")}
              value={query}
              onChange={onQueryChange}
            />
            <Button
              className="flex-1 gap-1.5 px-2.5 sm:flex-none"
              type="button"
              variant="outline"
              onClick={onNewRole}
            >
              <Plus size={14} />
              {t("roles.newRole")}
            </Button>
          </>
        }
      />

      {activeLoginGuides.map(({ role, authStatus }) => (
        <LoginSessionGuide key={role.id} authStatus={authStatus} roleName={role.name} t={t} />
      ))}

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <RoleFilterTabs
          activeFilter={activeFilter}
          counts={filterCounts}
          t={t}
          onFilterChange={onFilterChange}
        />
        <p className="text-[11px] font-medium text-muted-foreground">
          {t("roles.visibleCount")
            .replace("{visible}", String(filteredRoles.length))
            .replace("{total}", String(roles.length))}
        </p>
      </div>

      {roles.length === 0 ? (
        <EmptyState
          icon={Globe2}
          title={t("roles.empty.title")}
          description={t("roles.empty.description")}
          actionLabel={t("roles.empty.action")}
          onAction={onNewRole}
        />
      ) : filteredRoles.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("roles.noMatches.title")}
          description={t("roles.noMatches.description")}
          actionLabel={t("roles.noMatches.action")}
          onAction={onClearQuery}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {filteredRoles.map((role) => {
            const status = statusByRole.get(role.id);
            const authStatus = authStatusByRole.get(role.id);
            const isBusy =
              busyRoleId === role.id ||
              status?.state === "launching" ||
              status?.state === "stopping" ||
              Boolean(authStatus && authStatus.state !== "failed");

            return (
              <RoleCard
                key={role.id}
                role={role}
                status={status}
                authStatus={authStatus}
                isBusy={isBusy}
                language={language}
                t={t}
                onCopy={() => onCopy(role)}
                onDelete={() => onDelete(role)}
                onEdit={() => onEdit(role)}
                onLaunch={() => onLaunch(role.id)}
                onLogin={() => onLogin(role.id)}
                onStop={() => onStop(role.id)}
              />
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}

interface RoleFilterTabsProps {
  activeFilter: SidebarFilter;
  counts: Record<SidebarFilter, number>;
  t: Translator;
  onFilterChange: (filter: SidebarFilter) => void;
}

function RoleFilterTabs({ activeFilter, counts, t, onFilterChange }: RoleFilterTabsProps): JSX.Element {
  return (
    <SegmentedControl<SidebarFilter>
      className="w-full grid-cols-2 sm:w-[420px] sm:shrink-0 sm:grid-cols-4"
      items={filterOrder.map((filter) => ({
        value: filter,
        label: t(filterLabelKeys[filter]),
        count: counts[filter]
      }))}
      value={activeFilter}
      onValueChange={onFilterChange}
    />
  );
}

interface RoleCardProps {
  authStatus?: AuthFlowStatus;
  isBusy: boolean;
  language: Language;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onLaunch: () => void;
  onLogin: () => void;
  onStop: () => void;
  role: Role;
  status?: RoleStatus;
  t: Translator;
}

function RoleCard({
  authStatus,
  isBusy,
  language,
  onCopy,
  onDelete,
  onEdit,
  onLaunch,
  onLogin,
  onStop,
  role,
  status,
  t
}: RoleCardProps): JSX.Element {
  const isActive = Boolean(status);
  const isAuthFlowRunning = Boolean(authStatus && authStatus.state !== "failed");
  const isAuthenticated = role.authState === "authenticated";
  const hasCoverImage = Boolean(role.coverImageDataUrl);
  const canUsePrimaryOverlayAction = isAuthenticated && !isAuthFlowRunning;
  const hasBottomAction = isAuthFlowRunning || !isAuthenticated;
  const primaryActionLabel = isActive ? t("role.stop") : t("role.launch");
  const cardStyle = createRoleCardStyle({
    color: role.coverImageDominantColor,
    hasCoverImage,
    isActive
  });
  const launchGame = resolveLaunchGame(role.launchUrl, t);

  return (
    <Card
      className={cn(
        "group relative aspect-[4/5] overflow-hidden transition-shadow duration-200",
        hasCoverImage ? "role-cover-card" : "glass-panel-strong"
      )}
      style={cardStyle}
    >
      {hasCoverImage ? (
        <>
          <div
            className="absolute inset-0 bg-cover bg-center transition-transform duration-300 ease-out group-hover:scale-[1.03]"
            style={{ backgroundImage: `url("${role.coverImageDataUrl}")` }}
          />
        </>
      ) : null}

      <div className="pointer-events-none absolute right-3 top-3 z-30 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <RoleActionMenu
          canRelogin={isAuthenticated}
          isBusy={isBusy}
          isOnCover={hasCoverImage}
          t={t}
          onCopy={onCopy}
          onDelete={onDelete}
          onEdit={onEdit}
          onRelogin={onLogin}
        />
      </div>

      {canUsePrimaryOverlayAction ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <Button
            className={cn(
              "pointer-events-auto size-16 rounded-full p-0 shadow-lg transition-[opacity,transform,background-color] duration-150",
              isActive
                ? "opacity-100"
                : "opacity-0 group-hover:scale-105 group-hover:opacity-100 group-focus-within:scale-105 group-focus-within:opacity-100",
              hasCoverImage
                ? "border border-white/35 bg-black/35 text-white backdrop-blur-md hover:bg-black/50 hover:text-white"
                : "border border-border/60 bg-background/80 text-foreground backdrop-blur-md hover:bg-background"
            )}
            type="button"
            variant="secondary"
            title={primaryActionLabel}
            aria-label={primaryActionLabel}
            onClick={isActive ? onStop : onLaunch}
            disabled={isBusy}
          >
            {isBusy ? (
              <Loader2 className="spin" size={30} />
            ) : isActive ? (
              <Square size={30} fill="currentColor" />
            ) : (
              <Play className="ml-0.5" size={34} fill="currentColor" />
            )}
          </Button>
        </div>
      ) : null}

      <div className="relative z-10 flex h-full flex-col justify-end p-3">
        <div className={cn("relative grid gap-2", hasCoverImage && "isolate")}>
          {authStatus?.state === "failed" ? (
            <p
              className={cn(
                "line-clamp-2 flex min-h-5 items-start gap-1.5 text-sm leading-5",
                "text-destructive"
              )}
            >
              <AlertCircle className="mt-0.5 shrink-0" size={14} />
              {authStatus.message ? localizeErrorMessage(authStatus.message, language) : t("error.loginFailedSentence")}
            </p>
          ) : null}

          <div
            className={cn(
              "grid items-center gap-2 pt-1",
              hasBottomAction ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1",
              hasCoverImage ? "role-cover-actions" : "glass-divider border-t pt-2"
            )}
          >
            <div className="flex min-w-0 items-center gap-3 pl-1">
              {launchGame.iconSrc ? (
                <img
                  className="size-8 shrink-0 rounded-sm object-cover shadow-sm ring-1 ring-white/45"
                  src={launchGame.iconSrc}
                  alt=""
                  aria-hidden="true"
                />
              ) : null}
              <div className="grid min-w-0 gap-1">
                <CardTitle className={cn("min-w-0 truncate", hasCoverImage && "role-cover-title text-white")}>
                  {role.name}
                </CardTitle>
              <p
                className={cn(
                  "min-w-0 truncate text-[10px] font-medium leading-3 text-muted-foreground",
                  hasCoverImage && "text-white/78"
                )}
              >
                {launchGame.name}
              </p>
              </div>
            </div>
            {isAuthFlowRunning && authStatus ? (
              <Button
                className={cn(
                  "h-7 min-w-[88px] shrink-0 gap-1.5 px-2 text-[11px]",
                  hasCoverImage && "role-cover-control rounded-full text-white shadow-none hover:text-white"
                )}
                type="button"
                variant="secondary"
                size="sm"
                disabled
              >
                <Loader2 className="spin" size={14} />
                {formatAuthFlowState(authStatus, t)}
              </Button>
            ) : isAuthenticated ? null : (
              <LoginButton
                className={cn(
                  "h-7 min-w-[88px] shrink-0 gap-1.5 px-2 text-[11px]",
                  hasCoverImage && "role-cover-control rounded-full text-white shadow-none hover:text-white"
                )}
                isBusy={isBusy}
                t={t}
                onLogin={onLogin}
              />
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

interface ResolvedLaunchGame {
  iconSrc?: string;
  name: string;
}

function resolveLaunchGame(launchUrl: string, t: Translator): ResolvedLaunchGame {
  const option = launchUrlOptions.find((launchOption) => launchOption.value === launchUrl);

  if (option) {
    return {
      iconSrc: option.iconSrc,
      name: "label" in option ? option.label : t(option.labelKey)
    };
  }

  try {
    return { name: new URL(launchUrl).hostname };
  } catch {
    return { name: t("roleForm.launchUrl.current") };
  }
}

interface LoginButtonProps {
  className?: string;
  isBusy: boolean;
  onLogin: () => void;
  t: Translator;
}

function LoginButton({ className, isBusy, onLogin, t }: LoginButtonProps): JSX.Element {
  return (
    <Button
      className={className}
      type="button"
      variant="secondary"
      size="sm"
      onClick={onLogin}
      disabled={isBusy}
      title={t("role.login")}
    >
      {isBusy ? <Loader2 className="spin" size={14} /> : <LogIn size={14} />}
      {t("role.login")}
    </Button>
  );
}

interface RoleActionMenuProps {
  canRelogin: boolean;
  isBusy: boolean;
  isOnCover?: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRelogin: () => void;
  t: Translator;
}

function RoleActionMenu({
  canRelogin,
  isBusy,
  isOnCover = false,
  onCopy,
  onDelete,
  onEdit,
  onRelogin,
  t
}: RoleActionMenuProps): JSX.Element {
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

  function handleEdit(): void {
    setIsOpen(false);
    onEdit();
  }

  function handleCopy(): void {
    setIsOpen(false);
    onCopy();
  }

  function handleDelete(): void {
    setIsOpen(false);
    onDelete();
  }

  function handleRelogin(): void {
    setIsOpen(false);
    onRelogin();
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        className={cn("h-7 w-7", isOnCover && "role-cover-menu-control text-white hover:text-white")}
        type="button"
        variant="ghost"
        size="icon"
        title={t("role.actions")}
        aria-label={t("role.actions")}
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
            onClick={handleEdit}
          >
            <Pencil size={14} />
            <span>{t("role.edit")}</span>
          </button>
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={handleCopy}
            disabled={isBusy}
          >
            <Copy size={14} />
            <span>{t("role.copy")}</span>
          </button>
          {canRelogin ? (
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/45 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              type="button"
              role="menuitem"
              onClick={handleRelogin}
              disabled={isBusy}
            >
              <LogIn size={14} />
              <span>{t("role.relogin")}</span>
            </button>
          ) : null}
          <button
            className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            role="menuitem"
            onClick={handleDelete}
            disabled={isBusy}
          >
            <Trash2 size={14} />
            <span>{t("role.delete")}</span>
          </button>
        </Surface>
      ) : null}
    </div>
  );
}

export default RolesView;
