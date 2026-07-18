import { ArrowLeft, Download, FileJson, Gamepad2, Info, Keyboard, Palette, ScrollText, type LucideIcon } from "lucide-react";
import { type JSX } from "react";
import { useLocation, useNavigate } from "react-router";

import { NavItem } from "../../components/ui/patterns";
import type { TranslationKey, Translator } from "../../i18n";
import {
  readSettingsReturnTo,
  readSettingsSection,
  settingsSectionQueryValues,
  type SettingsSectionId
} from "./settingsNavigation";

interface SettingsSidebarProps {
  t: Translator;
}

const generalSectionItems = [
  { icon: Palette, labelKey: "settings.interface", value: "interface" },
  { icon: Gamepad2, labelKey: "settings.game", value: "game" },
  { icon: Keyboard, labelKey: "settings.macros", value: "macros" },
  { icon: FileJson, labelKey: "settings.data", value: "data" }
] as const satisfies ReadonlyArray<{
  icon: LucideIcon;
  labelKey: TranslationKey;
  value: SettingsSectionId;
}>;

const systemSectionItems = [
  { icon: Download, labelKey: "settings.updates", value: "updates" },
  { icon: ScrollText, labelKey: "settings.diagnostics", value: "diagnostics" },
  { icon: Info, labelKey: "settings.aboutLegal", value: "aboutLegal" }
] as const satisfies ReadonlyArray<{
  icon: LucideIcon;
  labelKey: TranslationKey;
  value: SettingsSectionId;
}>;

export function SettingsSidebar({ t }: SettingsSidebarProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const activeSection = readSettingsSection(new URLSearchParams(location.search).get("section"));
  const returnTo = readSettingsReturnTo(location.state);

  function navigateToSection(section: SettingsSectionId): void {
    navigate(`/settings?section=${settingsSectionQueryValues[section]}`, { replace: true, state: location.state });
  }

  return (
    <aside className="app-sidebar settings-mode-sidebar app-drag flex w-[248px] shrink-0 flex-col overflow-hidden px-3 pb-3 text-sidebar-foreground">
      <button
        className="settings-back app-no-drag flex h-8 w-full items-center gap-2 rounded-md border border-transparent px-2 text-[13px] font-medium text-sidebar-foreground/68 transition-[background-color,border-color,color,box-shadow] duration-150 hover:bg-accent/35 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20"
        type="button"
        onClick={() => navigate(returnTo, { replace: true })}
      >
        <ArrowLeft size={15} />
        <span className="truncate">{t("settings.backToApp")}</span>
      </button>

      <p className="px-2 pb-2 pt-6 text-[11px] font-semibold uppercase leading-none text-sidebar-foreground/42">
        {t("settings.general")}
      </p>
      <nav className="app-no-drag grid gap-1" aria-label={t("settings.general")}>
        {generalSectionItems.map((item) => (
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

      <p className="px-2 pb-2 pt-6 text-[11px] font-semibold uppercase leading-none text-sidebar-foreground/42">
        {t("settings.system")}
      </p>
      <nav className="app-no-drag grid gap-1" aria-label={t("settings.system")}>
        {systemSectionItems.map((item) => (
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
