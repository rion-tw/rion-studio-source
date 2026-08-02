import type { Language, TranslationKey } from "../i18n";
import type { RoleFormState, ResolvedTheme, ThemeMode } from "./types";
import { DEFAULT_LAUNCH_URL } from "../../../shared/types";

export const THEME_STORAGE_KEY = "rion-studio-theme";
export const LANGUAGE_STORAGE_KEY = "rion-studio-language";

export const themeModes: ThemeMode[] = ["system", "light", "dark"];

export const emptyForm: RoleFormState = {
  gameId: "",
  name: "",
  launchUrl: DEFAULT_LAUNCH_URL,
  notes: "",
  browserZoomPercent: 100
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
