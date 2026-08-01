// Focused implementation extracted from SettingsRoute.tsx.
import { type TranslationKey } from "../../i18n";

import { type BrowserFontPresetId } from "../../../../shared/browserFonts";

import type { BrowserFontSlot } from "../../../../shared/types";

import { type SettingsSectionId } from "./settingsNavigation";

export const settingsSectionTitleKeys: Record<SettingsSectionId, TranslationKey> = {
  aboutLegal: "settings.aboutLegal",
  data: "settings.data",
  interface: "settings.interface",
  macros: "settings.macros",
  network: "settings.network",
  updates: "settings.updates",
  diagnostics: "settings.diagnostics"
};

export const settingsSectionDescriptionKeys: Record<SettingsSectionId, TranslationKey> = {
  aboutLegal: "settings.aboutLegalDescription",
  data: "settings.dataDescription",
  interface: "settings.interfaceDescription",
  macros: "settings.macrosDescription",
  network: "settings.networkDescription",
  updates: "settings.updatesDescription",
  diagnostics: "settings.diagnosticsDescription"
};

export const browserFontSlotLabelKeys: Record<BrowserFontSlot, TranslationKey> = {
  cjk: "settings.browserFonts.slot.cjk",
  latin: "settings.browserFonts.slot.latin",
  numeric: "settings.browserFonts.slot.numeric",
  monospace: "settings.browserFonts.slot.monospace",
  math: "settings.browserFonts.slot.math"
};

export const browserFontSlotDescriptionKeys: Record<BrowserFontSlot, TranslationKey> = {
  cjk: "settings.browserFonts.slot.cjkDescription",
  latin: "settings.browserFonts.slot.latinDescription",
  numeric: "settings.browserFonts.slot.numericDescription",
  monospace: "settings.browserFonts.slot.monospaceDescription",
  math: "settings.browserFonts.slot.mathDescription"
};

export const browserFontPresetLabelKeys: Record<BrowserFontPresetId, TranslationKey> = {
  "system-default": "settings.browserFonts.preset.systemDefault",
  "modern-sans": "settings.browserFonts.preset.modernSans",
  "comfortable-reading": "settings.browserFonts.preset.comfortableReading",
  "clear-interface": "settings.browserFonts.preset.clearInterface",
  "clear-numbers": "settings.browserFonts.preset.clearNumbers",
  "code-monospace": "settings.browserFonts.preset.codeMonospace",
  "high-legibility": "settings.browserFonts.preset.highLegibility",
  "compact-dashboard": "settings.browserFonts.preset.compactDashboard",
  "natural-handwriting": "settings.browserFonts.preset.naturalHandwriting",
  "playful-handwriting": "settings.browserFonts.preset.playfulHandwriting",
  "calligraphic-handwriting": "settings.browserFonts.preset.calligraphicHandwriting",
  "neat-notebook": "settings.browserFonts.preset.neatNotebook",
  "storybook-handwriting": "settings.browserFonts.preset.storybookHandwriting",
  "friendly-rounded": "settings.browserFonts.preset.friendlyRounded",
  "marker-notes": "settings.browserFonts.preset.markerNotes",
  "editorial-serif": "settings.browserFonts.preset.editorialSerif",
  "retro-game": "settings.browserFonts.preset.retroGame",
  "fantasy-chronicle": "settings.browserFonts.preset.fantasyChronicle",
  "future-interface": "settings.browserFonts.preset.futureInterface",
  "relaxed-dialogue": "settings.browserFonts.preset.relaxedDialogue"
};

export const browserFontPresetDescriptionKeys: Record<BrowserFontPresetId, TranslationKey> = {
  "system-default": "settings.browserFonts.preset.systemDefaultDescription",
  "modern-sans": "settings.browserFonts.preset.modernSansDescription",
  "comfortable-reading": "settings.browserFonts.preset.comfortableReadingDescription",
  "clear-interface": "settings.browserFonts.preset.clearInterfaceDescription",
  "clear-numbers": "settings.browserFonts.preset.clearNumbersDescription",
  "code-monospace": "settings.browserFonts.preset.codeMonospaceDescription",
  "high-legibility": "settings.browserFonts.preset.highLegibilityDescription",
  "compact-dashboard": "settings.browserFonts.preset.compactDashboardDescription",
  "natural-handwriting": "settings.browserFonts.preset.naturalHandwritingDescription",
  "playful-handwriting": "settings.browserFonts.preset.playfulHandwritingDescription",
  "calligraphic-handwriting": "settings.browserFonts.preset.calligraphicHandwritingDescription",
  "neat-notebook": "settings.browserFonts.preset.neatNotebookDescription",
  "storybook-handwriting": "settings.browserFonts.preset.storybookHandwritingDescription",
  "friendly-rounded": "settings.browserFonts.preset.friendlyRoundedDescription",
  "marker-notes": "settings.browserFonts.preset.markerNotesDescription",
  "editorial-serif": "settings.browserFonts.preset.editorialSerifDescription",
  "retro-game": "settings.browserFonts.preset.retroGameDescription",
  "fantasy-chronicle": "settings.browserFonts.preset.fantasyChronicleDescription",
  "future-interface": "settings.browserFonts.preset.futureInterfaceDescription",
  "relaxed-dialogue": "settings.browserFonts.preset.relaxedDialogueDescription"
};

export const browserFontPresetCategories = ["general", "handwriting", "personality"] as const;

export type BrowserFontPresetCategory = (typeof browserFontPresetCategories)[number];
