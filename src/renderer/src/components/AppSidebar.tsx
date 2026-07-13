import { Keyboard, LayoutDashboard, Settings, Users } from "lucide-react";
import { type JSX } from "react";
import { useLocation, useNavigate } from "react-router";

import appIconUrl from "../assets/app-icon.png";
import type { Translator } from "../i18n";
import { NavItem } from "./ui/patterns";

interface AppSidebarProps {
  hasUpdateBadge: boolean;
  macroCount: number;
  roleCount: number;
  t: Translator;
  workspaceCount: number;
}

export function AppSidebar({ hasUpdateBadge, macroCount, roleCount, t, workspaceCount }: AppSidebarProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <aside className="app-sidebar app-drag flex w-[248px] shrink-0 flex-col overflow-hidden px-3 pb-3 text-sidebar-foreground">
      <div className="pb-5">
        <button
          aria-label={t("app.home")}
          className="app-no-drag flex w-full items-center gap-2 rounded-md px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20"
          onClick={() => navigate("/dashboard")}
          type="button"
        >
          <img className="size-9 shrink-0 rounded-lg" src={appIconUrl} alt="" aria-hidden="true" draggable={false} />
          <span className="min-w-0 truncate text-[15px] font-semibold leading-5">Rion Studio</span>
        </button>
      </div>

      <nav className="grid gap-1" aria-label={t("app.primaryNavigation")}>
        <NavItem
          active={location.pathname === "/roles"}
          count={roleCount}
          icon={Users}
          label={t("app.roles")}
          noDrag
          onClick={() => navigate("/roles")}
        />
        <NavItem
          active={location.pathname === "/workspaces"}
          count={workspaceCount}
          icon={LayoutDashboard}
          label={t("app.workspaces")}
          noDrag
          onClick={() => navigate("/workspaces")}
        />
        <NavItem
          active={location.pathname === "/macros"}
          count={macroCount}
          icon={Keyboard}
          label={t("app.macros")}
          noDrag
          onClick={() => navigate("/macros")}
        />
      </nav>

      <div className="sidebar-settings mt-auto">
        <NavItem
          className="w-full"
          active={location.pathname === "/settings"}
          icon={Settings}
          label={t("app.settings")}
          noDrag
          showStatusDot={hasUpdateBadge}
          statusDotLabel={t("app.updateAvailable")}
          onClick={() => navigate("/settings", { state: { returnTo: `${location.pathname}${location.search}` } })}
        />
      </div>
    </aside>
  );
}
