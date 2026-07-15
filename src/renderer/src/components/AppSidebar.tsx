import { Gamepad2, Keyboard, LayoutDashboard, Settings, Users } from "lucide-react";
import { type JSX } from "react";
import { useLocation, useNavigate } from "react-router";

import appIconUrl from "../assets/app-icon.png";
import { normalizeAppReturnTo } from "../app/editorNavigation";
import type { Translator } from "../i18n";
import { NavItem } from "./ui/patterns";

interface AppSidebarProps {
  hasUpdateBadge: boolean;
  gameCount: number;
  macroCount: number;
  roleCount: number;
  t: Translator;
  workspaceCount: number;
}

export function AppSidebar({ gameCount, hasUpdateBadge, macroCount, roleCount, t, workspaceCount }: AppSidebarProps): JSX.Element {
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
        <div className="grid gap-1 pt-2" role="group" aria-label={t("app.navigation.play")}>
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase leading-none text-sidebar-foreground/42">
            {t("app.navigation.play")}
          </p>
          <NavItem
            active={location.pathname.startsWith("/games")}
            count={gameCount}
            icon={Gamepad2}
            label={t("app.games")}
            noDrag
            onClick={() => navigate("/games")}
          />
          <NavItem
            active={location.pathname.startsWith("/roles")}
            count={roleCount}
            icon={Users}
            label={t("app.roles")}
            noDrag
            onClick={() => navigate("/roles")}
          />
          <NavItem
            active={location.pathname.startsWith("/workspaces")}
            count={workspaceCount}
            icon={LayoutDashboard}
            label={t("app.workspaces")}
            noDrag
            onClick={() => navigate("/workspaces")}
          />
          <NavItem
            active={location.pathname.startsWith("/macros")}
            count={macroCount}
            icon={Keyboard}
            label={t("app.macros")}
            noDrag
            onClick={() => navigate("/macros")}
          />
        </div>
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
          onClick={() => navigate("/settings", {
            state: { returnTo: normalizeAppReturnTo(location.pathname, location.search) }
          })}
        />
      </div>
    </aside>
  );
}
