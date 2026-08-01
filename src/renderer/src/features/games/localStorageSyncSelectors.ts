import type { TranslationKey } from "../../i18n";

interface LocalStorageSyncSelectorOption {
  id: string;
  labelKey: TranslationKey;
}

interface LocalStorageSyncSelectorGroup {
  id: string;
  labelKey: TranslationKey;
  options: LocalStorageSyncSelectorOption[];
}

export const FLYFF_LOCAL_STORAGE_SYNC_SELECTOR_OPTIONS: LocalStorageSyncSelectorOption[] = [
  { id: "game_client_settings.audio", labelKey: "games.form.localStorageSelector.audio" },
  { id: "game_client_settings.gameplay", labelKey: "games.form.localStorageSelector.gameplay" },
  { id: "game_client_settings.graphics", labelKey: "games.form.localStorageSelector.graphics" },
  { id: "game_client_settings.ui", labelKey: "games.form.localStorageSelector.ui" },
  { id: "game_client_settings.video", labelKey: "games.form.localStorageSelector.video" },
  { id: "game_client_settings.layout.windows", labelKey: "games.form.localStorageSelector.windows" },
  { id: "game_client_settings.layout.hotbars", labelKey: "games.form.localStorageSelector.hotbars" },
  { id: "game_client_settings.input.bindings", labelKey: "games.form.localStorageSelector.bindings" }
];

export const FLYFF_LOCAL_STORAGE_SYNC_SELECTOR_GROUPS: LocalStorageSyncSelectorGroup[] = [
  {
    id: "settings-pages",
    labelKey: "games.form.localStorageSelector.groupPages",
    options: FLYFF_LOCAL_STORAGE_SYNC_SELECTOR_OPTIONS.slice(0, 5)
  },
  {
    id: "layout-input",
    labelKey: "games.form.localStorageSelector.groupLayoutInput",
    options: FLYFF_LOCAL_STORAGE_SYNC_SELECTOR_OPTIONS.slice(5)
  }
];
