import { useEffect, useMemo, useState } from "react";

import { LANGUAGE_STORAGE_KEY, THEME_STORAGE_KEY } from "../app/constants";
import { readStoredRoleDefaults, writeStoredRoleDefaults } from "../app/roleDefaults";
import { readStoredThemeMode, resolveTheme } from "../app/theme";
import type { ResolvedTheme, ThemeMode } from "../app/types";
import {
  createTranslator,
  getLoadedTranslations,
  loadTranslations,
  readStoredLanguage,
  type Language,
  type TranslationDictionary
} from "../i18n";
import type { RoleDefaults } from "../../../shared/types";

export function usePreferences() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredThemeMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(readStoredThemeMode()));
  const [language, setLanguage] = useState<Language>(() => readStoredLanguage(LANGUAGE_STORAGE_KEY));
  const [roleDefaults, setRoleDefaults] = useState<RoleDefaults>(readStoredRoleDefaults);
  const [translations, setTranslations] = useState<TranslationDictionary | undefined>(() =>
    getLoadedTranslations(readStoredLanguage(LANGUAGE_STORAGE_KEY))
  );

  const t = useMemo(() => createTranslator(language, translations), [language, translations]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme(): void {
      const nextResolvedTheme = themeMode === "system" ? (mediaQuery.matches ? "dark" : "light") : themeMode;
      document.documentElement.dataset.theme = nextResolvedTheme;
      document.documentElement.style.colorScheme = nextResolvedTheme;
      setResolvedTheme(nextResolvedTheme);
    }

    applyTheme();

    if (themeMode !== "system") {
      return;
    }

    mediaQuery.addEventListener("change", applyTheme);

    return () => {
      mediaQuery.removeEventListener("change", applyTheme);
    };
  }, [themeMode]);

  useEffect(() => {
    const htmlLanguages: Record<Language, string> = {
      en: "en",
      "zh-TW": "zh-Hant",
      "zh-CN": "zh-Hans",
      ja: "ja"
    };

    document.documentElement.lang = htmlLanguages[language];
    void window.rionStudio?.setOverlayLanguage?.(language)?.catch(() => undefined);
  }, [language]);

  useEffect(() => {
    let isDisposed = false;
    const cachedTranslations = getLoadedTranslations(language);
    setTranslations(cachedTranslations);

    void loadTranslations(language)
      .then((loadedTranslations) => {
        if (!isDisposed) {
          setTranslations(loadedTranslations);
        }
      })
      .catch(() => {
        if (!isDisposed) {
          setTranslations(getLoadedTranslations("en"));
        }
      });

    return () => {
      isDisposed = true;
    };
  }, [language]);

  function handleThemeModeChange(nextMode: ThemeMode): void {
    setThemeMode(nextMode);
    localStorage.setItem(THEME_STORAGE_KEY, nextMode);
  }

  function handleLanguageChange(nextLanguage: Language): void {
    setLanguage(nextLanguage);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
  }

  function handleRoleDefaultsChange(nextRoleDefaults: RoleDefaults): void {
    setRoleDefaults(writeStoredRoleDefaults(nextRoleDefaults));
  }

  return {
    handleLanguageChange,
    handleRoleDefaultsChange,
    handleThemeModeChange,
    language,
    resolvedTheme,
    roleDefaults,
    t,
    themeMode
  };
}
