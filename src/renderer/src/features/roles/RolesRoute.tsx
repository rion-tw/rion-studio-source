import {
  AlertCircle,
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
import { Input } from "../../components/ui/input";
import { RoleRunDot } from "../../components/RoleRunDot";
import { PageFrame, PageHeader, SegmentedControl, Surface } from "../../components/ui/patterns";
import { EmptyState } from "../../components/EmptyState";
import { localizeErrorMessage, type Language, type TranslationKey, type Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { AuthFlowStatus, Role, RoleStatus } from "../../../../shared/types";
import type { AppStats, SidebarFilter } from "../../app/types";
import { formatAuthFlowState } from "../../app/statusUtils";
import { createDominantLaunchButtonStyle, createRoleCardStyle } from "./roleCardStyle";

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

  return (
    <PageFrame>
      <PageHeader
        kicker={t("roles.kicker")}
        title={t("roles.title")}
        description={t("roles.description")}
        actions={
          <>
            <div className="relative min-w-0 flex-1 xl:w-72 xl:flex-none">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                size={14}
              />
              <Input
                className="pl-8 text-xs"
                placeholder={t("roles.searchPlaceholder")}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>
            <Button
              className="flex-1 gap-1.5 px-2.5 sm:flex-none"
              type="button"
              variant="outline"
              size="sm"
              onClick={onNewRole}
            >
              <Plus size={14} />
              {t("roles.newRole")}
            </Button>
          </>
        }
      />

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
  const cardStyle = createRoleCardStyle({
    color: role.coverImageDominantColor,
    hasCoverImage,
    isActive
  });
  const launchButtonStyle = createDominantLaunchButtonStyle(role.coverImageDominantColor);

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
          isBusy={isBusy}
          isOnCover={hasCoverImage}
          t={t}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      </div>

      <div className="relative z-10 flex h-full flex-col justify-end p-4">
        <div className={cn("relative grid gap-3", hasCoverImage && "isolate")}>
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
              "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 pt-1",
              hasCoverImage ? "role-cover-actions" : "glass-divider border-t pt-3"
            )}
          >
            <div className="flex min-w-0 items-center gap-2 pl-2">
              <RoleRunDot
                className={hasCoverImage ? "border-white/75" : undefined}
                isActive={isActive}
                label={t(isActive ? "role.statusDot.active" : "role.statusDot.inactive")}
              />
              <CardTitle className={cn("min-w-0 flex-1 truncate", hasCoverImage && "role-cover-title text-white")}>
                {role.name}
              </CardTitle>
            </div>
            {isActive ? (
              <Button
                className={cn(
                  "h-7 min-w-[76px] shrink-0 gap-1.5 px-2 text-[11px]",
                  hasCoverImage && "rounded-full text-white shadow-none hover:text-white"
                )}
                type="button"
                variant="destructive"
                size="sm"
                onClick={onStop}
                disabled={isBusy}
              >
                {isBusy ? <Loader2 className="spin" size={14} /> : <Square size={14} />}
                {t("role.stop")}
              </Button>
            ) : isAuthFlowRunning && authStatus ? (
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
            ) : isAuthenticated ? (
              <Button
                className={cn(
                  "h-7 min-w-[82px] shrink-0 gap-1.5 px-2 text-[11px] shadow-none",
                  hasCoverImage && "rounded-full",
                  launchButtonStyle
                    ? "bg-[var(--role-launch-bg)] text-white hover:bg-[var(--role-launch-hover-bg)] hover:text-white"
                    : "hover:bg-secondary/90",
                  hasCoverImage && !launchButtonStyle && "role-cover-control text-white hover:text-white"
                )}
                type="button"
                variant="secondary"
                size="sm"
                style={launchButtonStyle}
                onClick={onLaunch}
                disabled={isBusy}
              >
                {isBusy ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                {t("role.launch")}
              </Button>
            ) : (
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
  isBusy: boolean;
  isOnCover?: boolean;
  onDelete: () => void;
  onEdit: () => void;
  t: Translator;
}

function RoleActionMenu({ isBusy, isOnCover = false, onDelete, onEdit, t }: RoleActionMenuProps): JSX.Element {
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

  function handleDelete(): void {
    setIsOpen(false);
    onDelete();
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
