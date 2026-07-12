import { Gamepad2, Keyboard, LayoutDashboard, Settings, Users } from "lucide-react";
import { type JSX } from "react";
import { useLocation, useNavigate } from "react-router";

import appIconUrl from "../../../../build/icon.png";
import type { Translator } from "../i18n";
import { NavItem } from "./ui/patterns";

interface AppSidebarProps {
  macroCount: number;
  runningCount: number;
  roleCount: number;
  t: Translator;
  workspaceCount: number;
}

export function AppSidebar({ macroCount, roleCount, runningCount, t, workspaceCount }: AppSidebarProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <aside className="app-sidebar app-drag flex w-[248px] shrink-0 flex-col overflow-hidden px-3 pb-3 pt-[54px] text-sidebar-foreground">
      <div className="app-no-drag flex items-center gap-2 px-2 pb-5">
        <img className="size-9 shrink-0 rounded-lg" src={appIconUrl} alt="" aria-hidden="true" draggable={false} />
        <p className="min-w-0 truncate text-[15px] font-semibold leading-5">Rion Studio</p>
      </div>

      <nav className="grid gap-1" aria-label={t("app.primaryNavigation")}>
        <NavItem
          active={location.pathname === "/game"}
          count={runningCount}
          icon={Gamepad2}
          label={t("app.game")}
          noDrag
          onClick={() => navigate("/game")}
        />
        <NavItem
          active={location.pathname === "/roles" || location.pathname === "/"}
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
          onClick={() => navigate("/settings", { state: { returnTo: `${location.pathname}${location.search}` } })}
        />
      </div>
    </aside>
  );
}
