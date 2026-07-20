import { Power, ShieldAlert, Upload } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Surface } from "../../components/ui/patterns";
import { type Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  ChromeProfileEntry,
  ChromeProfileImportInput,
  ChromeProfileImportPreview,
  ChromeProfileImportResult,
  Game
} from "../../../../shared/types";

export interface ChromeProfileImportFlowProps {
  games: Game[];
  isOpen: boolean;
  t: Translator;
  onApply: (input: ChromeProfileImportInput) => Promise<ChromeProfileImportResult>;
  onCloseChrome: () => Promise<void>;
  onDiscard: (importId: string) => Promise<void>;
  onError: (error: unknown) => void;
  onOpenChange: (open: boolean) => void;
  onPreview: () => Promise<ChromeProfileImportPreview | null>;
}

export function ChromeProfileImportFlow({
  games,
  isOpen,
  t,
  onApply,
  onCloseChrome,
  onDiscard,
  onError,
  onOpenChange,
  onPreview
}: ChromeProfileImportFlowProps): JSX.Element | null {
  const [isBusy, setIsBusy] = useState(false);
  const [noticeConsent, setNoticeConsent] = useState(false);
  const [preview, setPreview] = useState<ChromeProfileImportPreview | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [selectedGameId, setSelectedGameId] = useState("");
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [chromeRunning, setChromeRunning] = useState(false);
  const [closeChromeState, setCloseChromeState] = useState<"idle" | "success" | "error">("idle");
  const [result, setResult] = useState<ChromeProfileImportResult | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setIsBusy(false);
    setNoticeConsent(false);
    setPreview(null);
    setSelectedProfileIds([]);
    setSelectedGameId("");
    setConsentAccepted(false);
    setChromeRunning(false);
    setCloseChromeState("idle");
    setResult(null);
  }, [isOpen]);

  async function handleCloseChrome(): Promise<void> {
    setIsBusy(true);
    setCloseChromeState("idle");
    try {
      await onCloseChrome();
      setChromeRunning(false);
      setCloseChromeState("success");
    } catch (error) {
      setCloseChromeState("error");
      onError(error);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStartImport(): Promise<void> {
    if (!noticeConsent) {
      return;
    }

    setIsBusy(true);
    try {
      const nextPreview = await onPreview();
      if (!nextPreview) {
        onOpenChange(false);
        return;
      }

      setPreview(nextPreview);
      setSelectedProfileIds([]);
      setSelectedGameId(games[0]?.id ?? "");
      setConsentAccepted(false);
      setChromeRunning(false);
    } catch (error) {
      if (isChromeStillRunningError(error)) {
        setChromeRunning(true);
        return;
      }
      onError(error);
      onOpenChange(false);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleApplyImport(): Promise<void> {
    if (!preview || selectedProfileIds.length === 0 || !selectedGameId || !consentAccepted) {
      return;
    }

    setIsBusy(true);
    try {
      const nextResult = await onApply({
        consentAccepted: true,
        gameId: selectedGameId,
        importId: preview.importId,
        profileIds: selectedProfileIds
      });
      setResult(nextResult);
      setPreview(null);
    } catch (error) {
      onError(error);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCancelImport(): Promise<void> {
    const pendingPreview = preview;
    setPreview(null);
    setSelectedProfileIds([]);
    setConsentAccepted(false);
    onOpenChange(false);

    if (!pendingPreview) {
      return;
    }

    try {
      await onDiscard(pendingPreview.importId);
    } catch (error) {
      onError(error);
    }
  }

  function handleCloseResult(): void {
    setResult(null);
    onOpenChange(false);
  }

  if (!isOpen) {
    return null;
  }

  return (
    <>
      {!preview && !result ? (
        <ChromeProfileImportNoticeDialog
          chromeRunning={chromeRunning}
          closeChromeState={closeChromeState}
          consentAccepted={noticeConsent}
          isBusy={isBusy}
          t={t}
          onCancel={() => onOpenChange(false)}
          onCloseChrome={() => void handleCloseChrome()}
          onConsentChange={setNoticeConsent}
          onConfirm={() => void handleStartImport()}
        />
      ) : null}

      {preview ? (
        <ChromeProfileImportDialog
          consentAccepted={consentAccepted}
          games={games}
          isBusy={isBusy}
          preview={preview}
          selectedGameId={selectedGameId}
          selectedProfileIds={selectedProfileIds}
          t={t}
          onCancel={() => void handleCancelImport()}
          onConsentChange={setConsentAccepted}
          onGameChange={setSelectedGameId}
          onProfileSelectionChange={setSelectedProfileIds}
          onConfirm={() => void handleApplyImport()}
        />
      ) : null}

      {result ? (
        <ChromeProfileImportResultDialog
          isBusy={isBusy}
          result={result}
          t={t}
          onClose={handleCloseResult}
        />
      ) : null}
    </>
  );
}

interface ChromeProfileImportNoticeDialogProps {
  chromeRunning: boolean;
  closeChromeState: "idle" | "success" | "error";
  consentAccepted: boolean;
  isBusy: boolean;
  t: Translator;
  onCancel: () => void;
  onCloseChrome: () => void;
  onConsentChange: (accepted: boolean) => void;
  onConfirm: () => void;
}

function ChromeProfileImportNoticeDialog({
  chromeRunning,
  closeChromeState,
  consentAccepted,
  isBusy,
  t,
  onCancel,
  onCloseChrome,
  onConsentChange,
  onConfirm
}: ChromeProfileImportNoticeDialogProps): JSX.Element {
  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[560px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chrome-profile-import-notice-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="chrome-profile-import-notice-title" className="text-[15px] font-semibold leading-6 text-foreground">
            {t("settings.chromeProfileImportNoticeTitle")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.chromeProfileImportNoticeDescription")}
          </p>
        </div>
        <div className="grid gap-2 overflow-y-auto px-5 py-4 text-xs leading-5 text-muted-foreground">
          <p>{t("settings.chromeProfileImportNoticeData")}</p>
          <p>{t("settings.chromeProfileImportNoticeLocalOnly")}</p>
          <p>{t("settings.chromeProfileImportNoticeCloseChrome")}</p>
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-900 dark:text-amber-100">
            {t("settings.chromeProfileImportCloseChromeWarning")}
          </p>
          {chromeRunning ? (
            <p className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-[11px] leading-5 text-destructive" role="alert">
              {t("settings.chromeProfileImportChromeRunning")}
            </p>
          ) : null}
          {closeChromeState === "success" ? (
            <p className="text-[11px] leading-5 text-emerald-700 dark:text-emerald-300" role="status">
              {t("settings.chromeProfileImportCloseChromeSuccess")}
            </p>
          ) : null}
          {closeChromeState === "error" ? (
            <p className="text-[11px] leading-5 text-destructive" role="alert">
              {t("settings.chromeProfileImportCloseChromeFailed")}
            </p>
          ) : null}
          <label className="mt-1 flex items-start gap-1 text-xs leading-5 text-foreground">
            <Checkbox
              className="mt-[3px]"
              checked={consentAccepted}
              disabled={isBusy}
              onCheckedChange={(checked) => onConsentChange(checked === true)}
            />
            <span>{t("settings.chromeProfileImportConsent")}</span>
          </label>
        </div>
        <div className="glass-divider flex flex-wrap items-center justify-between gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCloseChrome}>
            <Power size={14} />
            {t("settings.chromeProfileImportCloseChromeAction")}
          </Button>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
              {t("settings.importCancel")}
            </Button>
            <Button type="button" disabled={isBusy || !consentAccepted} onClick={onConfirm}>
              <ShieldAlert size={14} />
              {t("settings.chromeProfileImportChooseFolder")}
            </Button>
          </div>
        </div>
      </Surface>
    </div>
  );
}

function isChromeStillRunningError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "CHROME_RUNNING" || candidate.message === "Chrome is still using the selected profile. Quit Chrome and try again.";
}

interface ChromeProfileImportDialogProps {
  consentAccepted: boolean;
  games: Game[];
  isBusy: boolean;
  preview: ChromeProfileImportPreview;
  selectedGameId: string;
  selectedProfileIds: string[];
  t: Translator;
  onCancel: () => void;
  onConsentChange: (accepted: boolean) => void;
  onGameChange: (gameId: string) => void;
  onProfileSelectionChange: (profileIds: string[]) => void;
  onConfirm: () => void;
}

function ChromeProfileImportDialog({
  consentAccepted,
  games,
  isBusy,
  preview,
  selectedGameId,
  selectedProfileIds,
  t,
  onCancel,
  onConsentChange,
  onGameChange,
  onProfileSelectionChange,
  onConfirm
}: ChromeProfileImportDialogProps): JSX.Element {
  function toggleProfile(profile: ChromeProfileEntry): void {
    onProfileSelectionChange(
      selectedProfileIds.includes(profile.id)
        ? selectedProfileIds.filter((id) => id !== profile.id)
        : [...selectedProfileIds, profile.id]
    );
  }

  const canConfirm = selectedProfileIds.length > 0 && Boolean(selectedGameId) && consentAccepted;

  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[600px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chrome-profile-import-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="chrome-profile-import-title" className="text-[15px] font-semibold leading-6 text-foreground">
            {t("settings.chromeProfileImportPreview")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.chromeProfileImportSource").replace("{source}", preview.sourceLabel)}
          </p>
        </div>
        <div className="grid gap-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-2">
            <p className="text-xs font-semibold leading-5 text-foreground">
              {t("settings.chromeProfileImportProfiles")}
            </p>
            <div className="flex max-h-52 flex-wrap gap-2 overflow-auto p-0.5">
              {preview.profiles.map((profile) => (
                <button
                  key={profile.id}
                  aria-pressed={selectedProfileIds.includes(profile.id)}
                  className={cn(
                    "glass-control inline-flex h-[30px] min-h-[var(--control-min-size)] w-auto max-w-full flex-none items-center gap-1 rounded-md px-2.5 text-left transition-[background-color,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60",
                    selectedProfileIds.includes(profile.id)
                      ? "macro-role-card-selected text-foreground"
                      : "cursor-pointer text-muted-foreground hover:text-foreground"
                  )}
                  disabled={isBusy}
                  type="button"
                  onClick={() => toggleProfile(profile)}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-xs font-semibold leading-none">{profile.name}</span>
                    <span className="shrink-0 whitespace-nowrap text-right text-[11px] leading-none text-muted-foreground">
                      {profile.directoryName}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <label className="grid gap-1.5">
            <span className="text-xs font-semibold leading-5 text-foreground">
              {t("settings.chromeProfileImportGame")}
            </span>
            <Select value={selectedGameId} onValueChange={onGameChange} disabled={isBusy || games.length === 0}>
              <SelectTrigger aria-label={t("settings.chromeProfileImportGame")}>
                <SelectValue placeholder={t("settings.chromeProfileImportGamePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {games.map((game) => <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-[11px] leading-5 text-muted-foreground">
            <p>{t("settings.chromeProfileImportFinalNotice")}</p>
            <p className="mt-1">{t("settings.chromeProfileImportPasswordNotice")}</p>
            <p className="mt-1">{t("settings.chromeProfileImportLoginDataNotice")}</p>
          </div>
          <label className="flex items-start gap-1 text-xs leading-5 text-foreground">
            <Checkbox
              className="mt-[3px]"
              checked={consentAccepted}
              disabled={isBusy}
              onCheckedChange={(checked) => onConsentChange(checked === true)}
            />
            <span>{t("settings.chromeProfileImportConsent")}</span>
          </label>
        </div>
        <div className="glass-divider flex justify-end gap-2 border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onCancel}>
            {t("settings.importCancel")}
          </Button>
          <Button type="button" disabled={isBusy || !canConfirm} onClick={onConfirm}>
            <Upload size={14} />
            {t("settings.chromeProfileImportConfirm")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

interface ChromeProfileImportResultDialogProps {
  isBusy: boolean;
  result: ChromeProfileImportResult;
  t: Translator;
  onClose: () => void;
}

function ChromeProfileImportResultDialog({
  isBusy,
  result,
  t,
  onClose
}: ChromeProfileImportResultDialogProps): JSX.Element {
  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className="flex max-h-[calc(100vh-2.5rem)] w-full max-w-[600px] flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chrome-profile-import-result-title"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id="chrome-profile-import-result-title" className="text-[15px] font-semibold leading-6 text-foreground">
            {t("settings.chromeProfileImportComplete")}
          </h2>
        </div>
        <div className="grid gap-2 overflow-y-auto px-5 py-4">
          {result.roles.map((role) => (
            <div key={role.id} className="glass-inset rounded-md px-3 py-2.5 text-xs">
              <p className="font-semibold text-foreground">{role.name}</p>
            </div>
          ))}
          {result.warnings.length > 0 ? (
            <p className="text-[11px] leading-5 text-muted-foreground">
              {t("settings.chromeProfileImportWarnings").replace("{count}", String(result.warnings.length))}
            </p>
          ) : null}
        </div>
        <div className="glass-divider flex justify-end border-t px-5 py-4">
          <Button type="button" disabled={isBusy} onClick={onClose}>{t("common.close")}</Button>
        </div>
      </Surface>
    </div>
  );
}
