import type { Language, TranslationKey } from "../i18n";
import {
  DEFAULT_LAUNCH_URL,
  type LaunchPreset
} from "../../../shared/types";
import type { RoleFormState, ResolvedTheme, ThemeMode } from "./types";
import { createEmptyRoleForm } from "./roleDefaults";
import feifeiInfiniteUniverseIcon from "../assets/games/feifei-infinite-universe.png";
import flyffUniverseIcon from "../assets/games/flyff-universe.png";

export const THEME_STORAGE_KEY = "rion-studio-theme";
export const LANGUAGE_STORAGE_KEY = "rion-studio-language";

export const themeModes: ThemeMode[] = ["system", "light", "dark"];

export const emptyForm: RoleFormState = createEmptyRoleForm();

export const launchUrlOptions = [
  {
    iconSrc: flyffUniverseIcon,
    labelKey: "roleForm.launchUrl.flyffUniverse",
    value: DEFAULT_LAUNCH_URL
  },
  {
    iconSrc: feifeiInfiniteUniverseIcon,
    label: "飞飞：无限宇宙",
    value: "https://ffcli.ruiwoo.cn"
  }
] as const satisfies Array<({ labelKey: TranslationKey } | { label: string }) & { iconSrc?: string; value: string }>;

export const presetLabelKeys: Record<LaunchPreset, TranslationKey> = {
  balanced: "preset.balanced",
  performance: "preset.performance"
};

export const themeLabelKeys: Record<ThemeMode, TranslationKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark"
};

export const resolvedThemeLabelKeys: Record<ResolvedTheme, TranslationKey> = {
  light: "theme.resolved.light",
  dark: "theme.resolved.dark"
};

export const languageLabelKeys: Record<Language, TranslationKey> = {
  en: "language.en",
  "zh-TW": "language.zhTW",
  "zh-CN": "language.zhCN",
  ja: "language.ja"
};
