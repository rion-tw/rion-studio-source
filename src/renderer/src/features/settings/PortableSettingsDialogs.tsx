// Focused implementation extracted from SettingsRoute.tsx.
import { FileJson, Upload } from "lucide-react";

import { type JSX } from "react";

import { Button } from "../../components/ui/button";

import { Checkbox } from "../../components/ui/checkbox";

import { StatusCallout, Surface } from "../../components/ui/patterns";

import { type TranslationKey, type Translator } from "../../i18n";

import type { AppUpdateStatus, PortableDataSelection, PortableExportResult, PortableImportOperations, PortableImportPreview, PortableImportResult, PortableImportWarning, PortableMacroConflictResolution } from "../../../../shared/types";

import { clearPortableDataSelection, createDefaultPortableDataSelection, filterPortableImportWarnings, hasPortableDataSelection, isPortableGameSelectionRequired, isPortableRoleSelectionRequired, isPortableWorkspaceSelectionRequired, updatePortableDataSelection, type PortableDataAvailability, type PortableDataSection } from "./portableSelection";

import type { PortableDataCounts } from "./SettingsRoute";

import { createPortableImportAvailability } from "./MacroBadgePositionSettingsRows";

interface PortableExportDialogProps {
  availability: PortableDataAvailability;
  counts: PortableDataCounts;
  isBusy: boolean;
  selection: PortableDataSelection;
  t: Translator;
  onCancel: () => void;
  onChange: (selection: PortableDataSelection) => void;
  onConfirm: () => void;
}

export function PortableExportDialog({
  availability,
  counts,
  isBusy,
  selection,
  t,
  onCancel,
  onChange,
  onConfirm
}: PortableExportDialogProps): JSX.Element {
  return (
    <div className="app-modal-backdrop app-no-drag fixed inset-0 z-[var(--layer-modal)] grid place-items-center p-5">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-export-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="portable-export-title" className="text-heading font-semibold text-foreground">
            {t("settings.exportSelectionTitle")}
          </h2>
          <p className="mt-1 text-control text-muted-foreground">
            {t("settings.exportSelectionDescription")}
          </p>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-4">
          <PortableDataSelectionControls
            availability={availability}
            counts={counts}
            disabled={isBusy}
            selection={selection}
            t={t}
            onChange={onChange}
          />
          <p className="rounded-sm border border-border/40 bg-background/25 px-3 py-2 text-caption text-muted-foreground">
            {t("settings.portableSafetyNotice")}
          </p>
        </div>

        <div className="glass-divider flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
            {t("settings.importCancel")}
          </Button>
          <Button
            type="button"
            disabled={isBusy || !hasPortableDataSelection(selection)}
            onClick={onConfirm}
          >
            <FileJson size={14} />
            {t("settings.exportJson")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

interface PortableImportDialogProps {
  isBusy: boolean;
  preview: PortableImportPreview;
  resolutions: PortableMacroConflictResolution[];
  selection: PortableDataSelection;
  t: Translator;
  onCancel: () => void;
  onChange: (selection: PortableDataSelection) => void;
  onConfirm: () => void;
  onResolutionsChange: (resolutions: PortableMacroConflictResolution[]) => void;
}

export function PortableImportDialog({
  isBusy,
  preview,
  resolutions,
  selection,
  t,
  onCancel,
  onChange,
  onConfirm,
  onResolutionsChange
}: PortableImportDialogProps): JSX.Element {
  const availability = createPortableImportAvailability(preview);
  const selectedWarnings = filterPortableImportWarnings(preview.warnings, selection);
  const unresolvedConflictCount = selection.macros
    ? preview.conflicts.filter(
        (conflict) => !resolutions.some((resolution) => resolution.conflictId === conflict.id)
      ).length
    : 0;

  function updateConflictResolution(conflictId: string, value: string): void {
    const remaining = resolutions.filter((resolution) => resolution.conflictId !== conflictId);
    if (!value) {
      onResolutionsChange(remaining);
      return;
    }
    if (value === "copy" || value === "skip") {
      onResolutionsChange([...remaining, { conflictId, action: value }]);
      return;
    }
    onResolutionsChange([
      ...remaining,
      { conflictId, action: "update", targetMacroId: value.replace(/^update:/, "") }
    ]);
  }

  return (
    <div className="app-modal-backdrop app-no-drag fixed inset-0 z-[var(--layer-modal)] grid place-items-center p-5">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-import-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="portable-import-title" className="text-heading font-semibold text-foreground">
            {t("settings.importPreview")}
          </h2>
          <p className="mt-1 text-control text-muted-foreground">{t("settings.importPreviewDescription")}</p>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-4">
          <PortableDataSelectionControls
            availability={availability}
            counts={preview}
            disabled={isBusy}
            selection={selection}
            t={t}
            onChange={onChange}
          />

          <PortableImportOperationsSummary
            operations={preview.operations}
            selection={selection}
            t={t}
          />

          {selection.macros && preview.conflicts.length > 0 ? (
            <StatusCallout className="grid gap-3 px-3 py-3" tone="warning">
              <div>
                <p className="text-control font-semibold text-foreground">{t("settings.importConflictsTitle")}</p>
                <p className="text-caption text-muted-foreground">
                  {t("settings.importConflictsDescription")}
                </p>
              </div>
              {preview.conflicts.map((conflict) => {
                const resolution = resolutions.find((item) => item.conflictId === conflict.id);
                const value = resolution?.action === "update"
                  ? `update:${resolution.targetMacroId}`
                  : resolution?.action ?? "";
                return (
                  <label key={conflict.id} className="grid gap-1.5">
                    <span className="text-control font-semibold text-foreground">
                      {conflict.name} · {conflict.roleNames.join(", ")}
                    </span>
                    <select
                      className="h-[var(--control-height)] rounded-sm border border-border/50 bg-background px-2 text-control text-foreground"
                      disabled={isBusy}
                      value={value}
                      onChange={(event) => updateConflictResolution(conflict.id, event.target.value)}
                    >
                      <option value="">{t("settings.importConflictChoose")}</option>
                      {conflict.candidates.map((candidate) => (
                        <option key={candidate.id} value={`update:${candidate.id}`}>
                          {t("settings.importConflictOverwrite")
                            .replace("{name}", candidate.name)
                            .replace("{steps}", String(candidate.stepCount))
                            .replace("{date}", new Date(candidate.updatedAt).toLocaleString())}
                        </option>
                      ))}
                      <option value="copy">{t("settings.importConflictCopy")}</option>
                      <option value="skip">{t("settings.importConflictSkip")}</option>
                    </select>
                  </label>
                );
              })}
            </StatusCallout>
          ) : null}

          <div className="min-w-0 rounded-sm border border-border/40 bg-background/25 px-3 py-2">
            <p className="truncate text-caption font-medium text-muted-foreground">{preview.filePath}</p>
            <p className="mt-1 text-caption text-muted-foreground">
              {formatPortableSource(preview, t)}
            </p>
          </div>

          {selectedWarnings.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-control font-semibold text-foreground">
                {t("settings.importWarnings").replace("{count}", String(selectedWarnings.length))}
              </p>
              <ul className="app-scroll-region max-h-36 space-y-1 overflow-auto text-control text-muted-foreground">
                {selectedWarnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.itemName ?? index}`}>
                    {formatPortableWarning(warning, t)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-control text-muted-foreground">{t("settings.importNoWarnings")}</p>
          )}
          <p className="rounded-sm border border-border/40 bg-background/25 px-3 py-2 text-caption text-muted-foreground">
            {t("settings.importMergeSafetyNotice")}
          </p>
        </div>

        <div className="glass-divider flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
            {t("settings.importCancel")}
          </Button>
          <Button
            type="button"
            disabled={isBusy || !hasPortableDataSelection(selection) || unresolvedConflictCount > 0}
            onClick={onConfirm}
          >
            <Upload size={14} />
            {t("settings.importConfirm")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

function PortableImportOperationsSummary({
  operations,
  selection,
  t
}: {
  operations: PortableImportOperations;
  selection: PortableDataSelection;
  t: Translator;
}): JSX.Element {
  const items: Array<{
    key: keyof PortableImportOperations;
    labelKey: TranslationKey;
    selected: boolean;
  }> = [
    { key: "games", labelKey: "settings.importGames", selected: selection.games },
    { key: "roles", labelKey: "settings.importRoles", selected: selection.roles },
    { key: "launchWorkspaces", labelKey: "settings.importWorkspaces", selected: selection.launchWorkspaces },
    { key: "gameWindows", labelKey: "settings.importGameWindows", selected: selection.gameWindows },
    { key: "macros", labelKey: "settings.importMacros", selected: selection.macros }
  ];
  return (
    <div className="grid gap-1.5 rounded-sm border border-border/40 bg-background/25 px-3 py-2">
      {items.filter((item) => item.selected).map((item) => {
        const summary = operations[item.key];
        return (
          <div key={item.key} className="flex items-center justify-between gap-3 text-caption">
            <span className="font-semibold text-foreground">{t(item.labelKey)}</span>
            <span className="text-right text-muted-foreground">
              {t("settings.importOperationSummary")
                .replace("{create}", String(summary.create))
                .replace("{update}", String(summary.update))
                .replace("{unchanged}", String(summary.unchanged))
                .replace("{skip}", String(summary.skip))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface PortableDataSelectionControlsProps {
  availability: PortableDataAvailability;
  counts: PortableDataCounts;
  disabled: boolean;
  selection: PortableDataSelection;
  t: Translator;
  onChange: (selection: PortableDataSelection) => void;
}

function PortableDataSelectionControls({
  availability,
  counts,
  disabled,
  selection,
  t,
  onChange
}: PortableDataSelectionControlsProps): JSX.Element {
  const roleSelectionRequired = isPortableRoleSelectionRequired(selection);
  const gameSelectionRequired = isPortableGameSelectionRequired(selection);
  const workspaceSelectionRequired = isPortableWorkspaceSelectionRequired(selection);
  const items: Array<{
    count?: number;
    descriptionKey: TranslationKey;
    labelKey: TranslationKey;
    section: PortableDataSection;
  }> = [
    {
      count: counts.gameCount,
      descriptionKey: "settings.portableGamesDescription",
      labelKey: "settings.importGames",
      section: "games"
    },
    {
      count: counts.roleCount,
      descriptionKey: "settings.portableRolesDescription",
      labelKey: "settings.importRoles",
      section: "roles"
    },
    {
      count: counts.workspaceCount,
      descriptionKey: "settings.portableWorkspacesDescription",
      labelKey: "settings.importWorkspaces",
      section: "launchWorkspaces"
    },
    {
      count: counts.gameWindowCount,
      descriptionKey: "settings.portableGameWindowsDescription",
      labelKey: "settings.importGameWindows",
      section: "gameWindows"
    },
    {
      count: counts.macroCount,
      descriptionKey: "settings.portableMacrosDescription",
      labelKey: "settings.importMacros",
      section: "macros"
    },
    {
      descriptionKey: "settings.portablePreferencesDescription",
      labelKey: "settings.portablePreferences",
      section: "preferences"
    }
  ];

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold leading-5 text-foreground">{t("settings.portableChooseData")}</p>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(createDefaultPortableDataSelection(availability))}
          >
            {t("settings.portableSelectAll")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(clearPortableDataSelection())}
          >
            {t("settings.portableClearAll")}
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        {items.map(({ count, descriptionKey, labelKey, section }) => {
          const isAvailable = availability[section];
          const isRoleLocked = section === "roles" && roleSelectionRequired;
          const isGameLocked = section === "games" && gameSelectionRequired;
          const isWorkspaceLocked = section === "launchWorkspaces" && workspaceSelectionRequired;
          const itemDisabled = disabled || !isAvailable || isRoleLocked || isGameLocked || isWorkspaceLocked;
          const description = isRoleLocked
            ? t("settings.portableRolesRequired")
            : isGameLocked
              ? t("settings.portableGamesRequired")
              : isWorkspaceLocked
                ? t("settings.portableWorkspacesRequired")
                : t(descriptionKey);

          return (
            <label
              key={section}
              className={`glass-inset flex min-h-14 items-center gap-3 rounded-md px-3 py-2.5 ${
                itemDisabled ? "opacity-60" : "cursor-pointer"
              }`}
            >
              <Checkbox
                checked={selection[section]}
                disabled={itemDisabled}
                onCheckedChange={(checked) =>
                  onChange(
                    updatePortableDataSelection(selection, section, checked === true, availability)
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold leading-5 text-foreground">{t(labelKey)}</span>
                <span className="block text-caption text-muted-foreground">
                  {isAvailable ? description : t("settings.portableUnavailable")}
                </span>
              </span>
              <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                {count ?? (isAvailable ? t("settings.portableIncluded") : "—")}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function formatPortableExportResult(result: PortableExportResult, t: Translator): string {
  return t("settings.exportComplete").replace("{summary}", formatPortableResultSummary(result, t));
}

export function formatPortableImportResult(result: PortableImportResult, t: Translator): string {
  const selectedOperations = [
    result.selection.games ? result.operations.games : undefined,
    result.selection.roles ? result.operations.roles : undefined,
    result.selection.launchWorkspaces ? result.operations.launchWorkspaces : undefined,
    result.selection.gameWindows ? result.operations.gameWindows : undefined,
    result.selection.macros ? result.operations.macros : undefined
  ].filter((summary): summary is PortableImportOperations[keyof PortableImportOperations] => Boolean(summary));
  const totals = selectedOperations.reduce(
    (summary, item) => ({
      create: summary.create + item.create,
      update: summary.update + item.update,
      unchanged: summary.unchanged + item.unchanged,
      skip: summary.skip + item.skip
    }),
    { create: 0, update: 0, unchanged: 0, skip: 0 }
  );
  const summary = t("settings.importOperationSummary")
    .replace("{create}", String(totals.create))
    .replace("{update}", String(totals.update))
    .replace("{unchanged}", String(totals.unchanged))
    .replace("{skip}", String(totals.skip));
  return t("settings.importComplete").replace(
    "{summary}",
    result.preferencesIncluded ? `${summary} · ${t("settings.portablePreferences")}` : summary
  );
}

function formatPortableResultSummary(
  result: PortableExportResult | PortableImportResult,
  t: Translator
): string {
  const parts: string[] = [];

  if (result.selection.games) {
    parts.push(formatPortableCountSummary(t("settings.importGames"), result.gameCount, t));
  }
  if (result.selection.roles) {
    parts.push(formatPortableCountSummary(t("settings.importRoles"), result.roleCount, t));
  }
  if (result.selection.launchWorkspaces) {
    parts.push(formatPortableCountSummary(t("settings.importWorkspaces"), result.workspaceCount, t));
  }
  if (result.selection.gameWindows) {
    parts.push(formatPortableCountSummary(t("settings.importGameWindows"), result.gameWindowCount, t));
  }
  if (result.selection.macros) {
    parts.push(formatPortableCountSummary(t("settings.importMacros"), result.macroCount, t));
  }
  if (result.preferencesIncluded) {
    parts.push(t("settings.portablePreferences"));
  }

  return parts.join(" · ");
}

function formatPortableCountSummary(label: string, count: number, t: Translator): string {
  return t("settings.portableCountSummary")
    .replace("{label}", label)
    .replace("{count}", String(count));
}

function formatPortableSource(preview: PortableImportPreview, t: Translator): string {
  const exportedAt = preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : t("settings.importUnknown");
  const appVersion = preview.appVersion || t("settings.importUnknown");

  return t("settings.importSource")
    .replace("{version}", appVersion)
    .replace("{date}", exportedAt);
}

function formatPortableWarning(warning: PortableImportWarning, t: Translator): string {
  const itemName = warning.itemName ?? t("settings.importUnknown");
  const replacementName = warning.replacementName ?? t("settings.importUnknown");
  const count = String(warning.count ?? 0);

  switch (warning.code) {
    case "GAME_NAME_RENAMED":
      return t("settings.warningGameRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "BUILTIN_GAME_DEFAULTS_REPLACED":
      return t("settings.warningBuiltinGameReplaced").replace("{name}", itemName);
    case "ROLE_GAME_RECOVERED":
      return t("settings.warningRoleGameRecovered").replace("{name}", itemName);
    case "ROLE_NAME_RENAMED":
      return t("settings.warningRoleRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "LOCAL_STORAGE_SYNC_IGNORED":
      return t("settings.warningLocalStorageSyncIgnored");
    case "WORKSPACE_NAME_RENAMED":
      return t("settings.warningWorkspaceRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "WORKSPACE_ROLE_MISSING":
      return t("settings.warningWorkspaceRoleMissing").replace("{name}", itemName).replace("{count}", count);
    case "GAME_WINDOW_NAME_RENAMED":
      return t("settings.warningGameWindowRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "GAME_WINDOW_TAB_DEPENDENCY_MISSING":
      return t("settings.warningGameWindowTabDependencyMissing").replace("{name}", itemName);
    case "GAME_WINDOW_TAB_ROLE_CONFLICT":
      return t("settings.warningGameWindowTabRoleConflict").replace("{name}", itemName);
    case "MACRO_NAME_RENAMED":
      return t("settings.warningMacroRenamed").replace("{name}", itemName).replace("{next}", replacementName);
    case "MACRO_ROLE_MISSING":
      return t("settings.warningMacroRoleMissing").replace("{name}", itemName).replace("{count}", count);
    case "MACRO_SHORTCUT_CLEARED_CONFLICT":
      return t("settings.warningMacroShortcutConflict").replace("{name}", itemName);
    case "MACRO_SHORTCUT_CLEARED_RESERVED":
      return t("settings.warningMacroShortcutReserved").replace("{name}", itemName);
    case "MACRO_SKIPPED_NO_ROLES":
      return t("settings.warningMacroSkipped").replace("{name}", itemName);
    case "MACRO_SKIPPED_MISSING_DEPENDENCY":
      return t("settings.warningMacroDependencySkipped").replace("{name}", itemName);
    default:
      return t("settings.warningUnknown");
  }
}

export function formatUpdateStatus(status: AppUpdateStatus | null, t: Translator): string {
  if (!status) {
    return t("settings.updateStatusLoading");
  }

  if (status.state === "downloaded" && status.availableVersion) {
    return t("settings.updateDownloaded").replace("{version}", status.availableVersion);
  }

  if (status.state === "downloading") {
    return t("settings.updateDownloading").replace("{progress}", String(status.downloadProgress ?? 0));
  }

  if (status.state === "available" && status.availableVersion) {
    if (status.installMode === "manual") {
      return t("settings.updateManualAvailable").replace("{version}", status.availableVersion);
    }

    return t("settings.updateAvailable").replace("{version}", status.availableVersion);
  }

  if (status.state === "error") {
    return t("settings.updateError").replace("{error}", status.error ?? t("settings.updateErrorUnknown"));
  }

  return t(`settings.updateState.${status.state}`);
}
