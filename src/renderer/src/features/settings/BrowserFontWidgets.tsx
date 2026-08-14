// Focused implementation extracted from SettingsRoute.tsx.
import { Check, ChevronDown, Eye, Loader2, PenLine, RefreshCw, Search, Sparkles, TriangleAlert, Type } from "lucide-react";

import { type JSX, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";

import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";

import { Input } from "../../components/ui/input";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import { SegmentedControl, StatusCallout, Surface } from "../../components/ui/patterns";

import { type TranslationKey, type Translator } from "../../i18n";

import { browserFontPresets, resolveBrowserFontPreset, type BrowserFontPresetId } from "../../../../shared/browserFonts";

import type { BrowserFontCatalogEntry, BrowserFontCategory, BrowserFontCjkVariant, BrowserFontSelection, BrowserFontSlot, GameBrowserSettings, SystemFontFamily } from "../../../../shared/types";

import { getGoogleFontPreviewStatus, quoteFontFamily, requestGoogleFontPreview, retryGoogleFontPreview, subscribeGoogleFontPreview, type GoogleFontPreviewStatus } from "./googleFontPreview";

import { browserFontPresetCategories, browserFontPresetDescriptionKeys, browserFontPresetLabelKeys } from "./settingsPresentation";

import type { BrowserFontPresetCategory } from "./settingsPresentation";

import { browserFontSelectionLabel, browserFontSelectionValue, parseBrowserFontSelectionValue } from "./MacroBadgePositionSettingsRows";

interface BrowserFontPresetCardsProps {
  activePresetId?: string;
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  disabled: boolean;
  previewEnabled: boolean;
  t: Translator;
  onSelect: (presetId: BrowserFontPresetId) => void;
}

export function BrowserFontPresetCards({
  activePresetId,
  catalog,
  cjkVariant,
  disabled,
  previewEnabled,
  t,
  onSelect
}: BrowserFontPresetCardsProps): JSX.Element {
  const activePresetCategory = browserFontPresets.find((preset) => preset.id === activePresetId)?.category ?? "general";
  const [selectedCategory, setSelectedCategory] = useState<BrowserFontPresetCategory>(activePresetCategory);

  useEffect(() => {
    const nextCategory = browserFontPresets.find((preset) => preset.id === activePresetId)?.category;
    if (nextCategory) setSelectedCategory(nextCategory);
  }, [activePresetId]);

  return (
    <div className="grid gap-2.5">
      <SegmentedControl<BrowserFontPresetCategory>
        className="grid-cols-3"
        disabled={disabled}
        items={browserFontPresetCategories.map((category) => ({
          value: category,
          count: browserFontPresets.filter((preset) => preset.category === category).length,
          icon: category === "general" ? Type : category === "handwriting" ? PenLine : Sparkles,
          label: t(
            category === "general"
              ? "settings.browserFontsPresetsGeneral"
              : category === "handwriting"
                ? "settings.browserFontsPresetsHandwriting"
                : "settings.browserFontsPresetsPersonality"
          )
        }))}
        value={selectedCategory}
        onValueChange={setSelectedCategory}
      />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {browserFontPresets
          .filter((preset) => preset.category === selectedCategory)
          .map((preset) => {
            const isActive = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={isActive}
                disabled={disabled}
                className={`group min-h-[112px] rounded-md border px-3 py-2.5 text-left transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 disabled:opacity-45 ${
                  isActive
                    ? "border-activity/45 bg-activity/[0.08] text-foreground shadow-[inset_0_1px_0_hsl(var(--glass-highlight-muted))]"
                    : "border-border/25 bg-muted/[0.07] text-muted-foreground hover:border-border/40 hover:bg-accent/25 hover:text-foreground"
                }`}
                onClick={() => onSelect(preset.id)}
              >
                <span className="flex items-start justify-between gap-2 text-xs font-semibold leading-5">
                  <span>{t(browserFontPresetLabelKeys[preset.id])}</span>
                  {isActive ? <Check className="mt-0.5 size-3.5 shrink-0 text-activity" aria-hidden="true" /> : null}
                </span>
                <span className="mt-0.5 block text-micro leading-4">
                  {t(browserFontPresetDescriptionKeys[preset.id])}
                </span>
                <BrowserFontPresetSample
                  catalog={catalog}
                  cjkVariant={cjkVariant}
                  enabled={previewEnabled}
                  presetId={preset.id}
                />
              </button>
            );
          })}
      </div>
    </div>
  );
}

function BrowserFontPresetSample({
  catalog,
  cjkVariant,
  enabled,
  presetId
}: {
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  enabled: boolean;
  presetId: BrowserFontPresetId;
}): JSX.Element {
  const settings = resolveBrowserFontPreset(presetId, cjkVariant);
  return (
    <span className="browser-font-preset-sample mt-2 flex min-w-0 items-baseline gap-2 overflow-hidden rounded-sm border border-border/15 bg-background/20 px-2 py-1.5 text-base leading-6 text-foreground">
      <BrowserFontSample
        catalog={catalog}
        enabled={enabled}
        selection={settings.slots.cjk}
        text={browserFontSampleText("cjk", cjkVariant)}
      />
      <BrowserFontSample
        catalog={catalog}
        enabled={enabled}
        selection={settings.slots.latin}
        text="Aa"
      />
      <BrowserFontSample
        catalog={catalog}
        enabled={enabled}
        selection={settings.slots.numeric}
        text="0123"
      />
    </span>
  );
}

interface BrowserFontSelectionPickerProps {
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  disabled: boolean;
  label: string;
  previewEnabled: boolean;
  selection?: BrowserFontSelection;
  slot: BrowserFontSlot;
  systemFonts: SystemFontFamily[];
  t: Translator;
  onChange: (slot: BrowserFontSlot, selection: BrowserFontSelection | undefined) => void;
}

function BrowserFontSample({
  catalog,
  compact = false,
  enabled,
  selection,
  text
}: {
  catalog: BrowserFontCatalogEntry[];
  compact?: boolean;
  enabled: boolean;
  selection?: BrowserFontSelection;
  text: string;
}): JSX.Element {
  const sampleRef = useRef<HTMLSpanElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsVisible(false);
      return;
    }
    const element = sampleRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "80px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  const preview = useBrowserFontPreview(selection, catalog, text, enabled && isVisible);
  return (
    <span
      ref={sampleRef}
      aria-hidden="true"
      className={`browser-font-sample shrink-0 whitespace-nowrap ${compact ? "text-sm" : "text-base leading-6"} transition-opacity ${
        preview.status === "loading" ? "animate-pulse opacity-45" : "opacity-85"
      }`}
      style={preview.fontFamily ? { fontFamily: preview.fontFamily } : undefined}
    >
      {text}
    </span>
  );
}

export function BrowserFontSelectionPicker({
  catalog,
  cjkVariant,
  disabled,
  label,
  previewEnabled,
  selection,
  slot,
  systemFonts,
  t,
  onChange
}: BrowserFontSelectionPickerProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | BrowserFontCategory>("all");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const filteredSystemFonts = systemFonts
    .filter(
      (font) =>
        !query ||
        font.family.toLocaleLowerCase().includes(query) ||
        font.label.toLocaleLowerCase().includes(query)
    )
    .sort((left, right) => left.label.localeCompare(right.label));
  const filteredCatalog = catalog
    .filter((font) => {
      const isCustomGoogleFont = font.catalogId.startsWith("custom-");
      const matchesSearch =
        !query ||
        font.family.toLocaleLowerCase().includes(query) ||
        font.catalogId.toLocaleLowerCase().includes(query);
      const matchesCategory =
        isCustomGoogleFont || category === "all" || font.category === category;
      const matchesScript =
        isCustomGoogleFont || slot !== "cjk" || font.scripts.includes(cjkVariant);
      return matchesSearch && matchesCategory && matchesScript;
    })
    .sort((left, right) => left.family.localeCompare(right.family));
  const value = browserFontSelectionValue(selection);
  const selectedLabel = browserFontSelectionLabel(selection, systemFonts, catalog, t);
  const hasFontResults = filteredSystemFonts.length > 0 || filteredCatalog.length > 0;

  useEffect(() => {
    if (!isOpen) return;
    const animationFrame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isOpen]);

  function handleOpenChange(nextOpen: boolean): void {
    setIsOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }

  function handleValueChange(nextValue: string): void {
    onChange(slot, parseBrowserFontSelectionValue(nextValue, catalog));
    setSearch("");
    setIsOpen(false);
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="settings-menu-control w-full justify-between overflow-hidden px-2.5 font-normal sm:w-80"
            aria-label={label}
            disabled={disabled}
          >
            <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
            <ChevronDown
              className={isOpen ? "size-3 rotate-180 transition-transform duration-150" : "size-3 transition-transform duration-150"}
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(440px,calc(100vw-1rem))] min-w-[var(--radix-dropdown-menu-trigger-width)] p-0"
        >
          <div className="grid gap-1.5 p-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
              <Input
                ref={searchInputRef}
                className="pl-8"
                aria-label={t("settings.browserFontsSearchForSlot").replace("{slot}", label)}
                placeholder={t("settings.browserFontsSearchPlaceholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    const firstResult = resultsRef.current?.querySelector<HTMLElement>(
                      query
                        ? '[data-font-option]:not([data-disabled])'
                        : '[role="menuitemradio"]:not([data-disabled])'
                    );
                    if (firstResult) {
                      event.preventDefault();
                      firstResult.focus();
                    }
                    return;
                  }
                  if (event.key !== "Escape" && event.key !== "Tab") {
                    event.stopPropagation();
                  }
                }}
              />
            </div>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as "all" | BrowserFontCategory)}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.browserFontsCategory")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["all", "sans", "serif", "handwriting", "display", "monospace", "math"] as const).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {t(`settings.browserFonts.category.${value}` as TranslationKey)}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>
          <DropdownMenuSeparator className="m-0" />
          <div ref={resultsRef} className="max-h-60 overflow-y-auto p-1">
            <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
              <DropdownMenuRadioItem value="fallback">
                {t("settings.browserFontsFallback")}
              </DropdownMenuRadioItem>

              {filteredSystemFonts.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("settings.browserFontsSourceSystem")}</DropdownMenuLabel>
                  {filteredSystemFonts.map((font) => (
                    <DropdownMenuRadioItem
                      key={`system:${font.family}`}
                      value={`system:${font.family}`}
                      data-font-option
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="browser-font-option-label min-w-0 truncate">
                          {font.label} · {t("settings.browserFontsSourceSystem")}
                        </span>
                        <BrowserFontSample
                          catalog={catalog}
                          compact
                          enabled={previewEnabled && isOpen}
                          selection={{ source: "system", family: font.family }}
                          text={browserFontSampleText(slot, cjkVariant)}
                        />
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </>
              ) : null}

              {filteredCatalog.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("settings.browserFontsSourceGoogle")}</DropdownMenuLabel>
                  {filteredCatalog.map((font) => (
                    <DropdownMenuRadioItem
                      key={`google:${font.catalogId}`}
                      value={`google:${font.catalogId}`}
                      data-font-option
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                        <span className="browser-font-option-label min-w-0 truncate">
                          {font.family} · {font.installed
                            ? t("settings.browserFontsInstalled")
                            : t("settings.browserFontsNotDownloaded")}
                        </span>
                        <BrowserFontSample
                          catalog={catalog}
                          compact
                          enabled={previewEnabled && isOpen}
                          selection={{ source: "google", catalogId: font.catalogId, family: font.family }}
                          text={browserFontSampleText(slot, cjkVariant)}
                        />
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </>
              ) : null}

              {!hasFontResults ? (
                <p role="status" className="px-2 py-3 text-center text-caption text-muted-foreground">
                  {t("settings.browserFontsNoResults")}
                </p>
              ) : null}
            </DropdownMenuRadioGroup>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
  );
}

export function BrowserFontsPreview({
  catalog,
  cjkVariant,
  previewFamilies,
  previewEnabled,
  settings,
  t
}: {
  catalog: BrowserFontCatalogEntry[];
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">;
  previewFamilies: Record<string, string>;
  previewEnabled: boolean;
  settings: GameBrowserSettings;
  t: Translator;
}): JSX.Element {
  const cjkText = `繁體中文 简体中文 日本語 ${browserFontSampleText("cjk", cjkVariant)}`;
  const latinText = `Rion Studio ${t("settings.browserFontsPreviewText")}`;
  const numericText = "0123456789 1,234.56 -20% 08:45 100/75";
  const monospaceText = "const hp = 100; // 0123456789";
  const mathText = "√x+1=y";
  const cjk = useBrowserFontPreview(
    settings.fonts.slots.cjk,
    catalog,
    cjkText,
    previewEnabled,
    previewFamilies
  );
  const latin = useBrowserFontPreview(
    settings.fonts.slots.latin,
    catalog,
    latinText,
    previewEnabled,
    previewFamilies
  );
  const numeric = useBrowserFontPreview(
    settings.fonts.slots.numeric,
    catalog,
    numericText,
    previewEnabled,
    previewFamilies
  );
  const monospace = useBrowserFontPreview(
    settings.fonts.slots.monospace,
    catalog,
    monospaceText,
    previewEnabled,
    previewFamilies
  );
  const math = useBrowserFontPreview(
    settings.fonts.slots.math,
    catalog,
    mathText,
    previewEnabled,
    previewFamilies
  );
  const previews = [cjk, latin, numeric, monospace, math];
  const hasLoadingPreview = previews.some((preview) => preview.status === "loading");
  const failedPreviews = previews.filter((preview) => preview.status === "error" && !preview.hasLocalFallback);

  return (
    <div className="grid gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-body font-semibold text-foreground">
          <Eye className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("settings.browserFontsOnlinePreview")}
          {hasLoadingPreview ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
        </p>
        <p className="mt-0.5 text-control text-muted-foreground">
          {t("settings.browserFontsOnlinePreviewDescription")}
        </p>
      </div>
      <Surface className="browser-font-preview-samples grid gap-2 border border-border/25 px-3 py-3 text-lg leading-8 text-muted-foreground" variant="inset">
        <p className="text-lg leading-8">
          <span style={fontPreviewStyle(cjk)}>繁體中文 · 简体中文 · 日本語 </span>
          <span style={fontPreviewStyle(latin)}>Rion Studio </span>
          <span style={fontPreviewStyle(numeric)}>0123456789</span>
        </p>
        <p className="text-lg leading-8 tracking-wide" style={fontPreviewStyle(numeric)}>
          1,234.56 · -20% · 08:45 · 100/75
        </p>
        <p style={fontPreviewStyle(latin)}>{t("settings.browserFontsPreviewText")}</p>
        <p style={fontPreviewStyle(monospace)}>const hp = 100; // 0123456789</p>
        <div
          style={fontPreviewStyle(math)}
          dangerouslySetInnerHTML={{
            __html:
              '<math style="font: inherit;"><mrow><msqrt><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></msqrt><mo>=</mo><mi>y</mi></mrow></math>'
          }}
        />
      </Surface>
      {failedPreviews.length > 0 ? (
        <StatusCallout tone="warning" role="status">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("settings.browserFontsPreviewFailed")}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => failedPreviews.forEach((preview) => preview.retry())}
          >
            <RefreshCw size={13} />
            {t("settings.browserFontsPreviewRetry")}
          </Button>
        </StatusCallout>
      ) : null}
    </div>
  );
}

interface ResolvedBrowserFontPreview {
  fontFamily?: string;
  hasLocalFallback: boolean;
  retry: () => void;
  status: GoogleFontPreviewStatus;
}

function useBrowserFontPreview(
  selection: BrowserFontSelection | undefined,
  catalog: BrowserFontCatalogEntry[],
  text: string,
  enabled: boolean,
  localFamilies: Record<string, string> = {}
): ResolvedBrowserFontPreview {
  const resolved = resolveBrowserFontPreviewFamily(selection, catalog);
  const localFamily = selection?.source === "google" ? localFamilies[selection.catalogId] : undefined;
  const [status, setStatus] = useState<GoogleFontPreviewStatus>(() =>
    resolved.source === "google"
      ? getGoogleFontPreviewStatus(resolved.family ?? "", text)
      : resolved.family
        ? "loaded"
        : "idle"
  );

  useEffect(() => {
    if (resolved.source !== "google" || !resolved.family || !enabled) {
      setStatus(resolved.family && resolved.source === "system" ? "loaded" : "idle");
      return;
    }
    const unsubscribe = subscribeGoogleFontPreview(resolved.family, text, setStatus);
    requestGoogleFontPreview(resolved.family, text);
    return unsubscribe;
  }, [enabled, resolved.family, resolved.source, text]);

  const remoteFamily = resolved.source === "google" && status === "loaded" ? resolved.family : undefined;
  const activeFamily = resolved.source === "system" ? resolved.family : remoteFamily ?? localFamily;
  return {
    ...(activeFamily ? { fontFamily: quoteFontFamily(activeFamily) } : {}),
    hasLocalFallback: Boolean(localFamily),
    retry: () => {
      if (resolved.source === "google" && resolved.family) {
        retryGoogleFontPreview(resolved.family, text);
      }
    },
    status
  };
}

function resolveBrowserFontPreviewFamily(
  selection: BrowserFontSelection | undefined,
  catalog: BrowserFontCatalogEntry[]
): { family?: string; source?: BrowserFontSelection["source"] } {
  if (!selection) return {};
  if (selection.source === "system") return { family: selection.family, source: "system" };
  const family =
    selection.family ??
    catalog.find((font) => font.catalogId === selection.catalogId)?.family;
  return { ...(family ? { family } : {}), source: "google" };
}

function fontPreviewStyle(preview: ResolvedBrowserFontPreview): { fontFamily?: string } | undefined {
  return preview.fontFamily ? { fontFamily: preview.fontFamily } : undefined;
}

function browserFontSampleText(
  slot: BrowserFontSlot,
  cjkVariant: Exclude<BrowserFontCjkVariant, "auto">
): string {
  if (slot === "cjk") {
    return cjkVariant === "tc" ? "繁體" : cjkVariant === "sc" ? "简体" : "日本語";
  }
  if (slot === "numeric") return "0123";
  if (slot === "monospace") return "Aa 01";
  if (slot === "math") return "√x+1";
  return "Aa Rion";
}
