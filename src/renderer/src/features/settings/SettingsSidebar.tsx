import { ArrowLeft, Download, FileJson, Languages, Monitor, Palette } from "lucide-react";
import { type JSX } from "react";
import { useLocation, useNavigate } from "react-router";

import { NavItem } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { readSettingsReturnTo, readSettingsSection, type SettingsSectionId } from "./settingsNavigation";

interface SettingsSidebarProps {
  t: Translator;
}

const sectionItems = [
  { icon: Palette, labelKey: "settings.appearance", value: "appearance" },
  { icon: Languages, labelKey: "settings.preferences", value: "preferences" },
  { icon: Monitor, labelKey: "settings.roleDefaults", value: "role-defaults" },
  { icon: FileJson, labelKey: "settings.portability", value: "portability" },
  { icon: Download, labelKey: "settings.updates", value: "updates" }
] as const;

export function SettingsSidebar({ t }: SettingsSidebarProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const activeSection = readSettingsSection(new URLSearchParams(location.search).get("section"));
  const returnTo = readSettingsReturnTo(location.state);

  function navigateToSection(section: SettingsSectionId): void {
    navigate(`/settings?section=${section}`, { replace: true, state: location.state });
  }

  return (
    <aside className="app-sidebar settings-mode-sidebar app-drag flex w-[248px] shrink-0 flex-col overflow-hidden px-3 pb-3 text-sidebar-foreground">
      <button
        className="settings-back app-no-drag flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium text-sidebar-foreground/68 transition-colors hover:bg-accent/35 hover:text-sidebar-foreground"
        type="button"
        onClick={() => navigate(returnTo, { replace: true })}
      >
        <ArrowLeft size={15} />
        <span className="truncate">{t("settings.backToApp")}</span>
      </button>

      <p className="px-2 pb-2 pt-6 text-[11px] font-semibold uppercase leading-none text-sidebar-foreground/42">
        {t("settings.title")}
      </p>
      <nav className="app-no-drag grid gap-1" aria-label={t("settings.navigation")}>
        {sectionItems.map((item) => (
          <NavItem
            key={item.value}
            active={activeSection === item.value}
            className="w-full"
            icon={item.icon}
            label={t(item.labelKey)}
            onClick={() => navigateToSection(item.value)}
          />
        ))}
      </nav>
    </aside>
  );
}
