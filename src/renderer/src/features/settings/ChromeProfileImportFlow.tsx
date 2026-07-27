import { Loader2, LogIn, Upload } from "lucide-react";
import { createPortal } from "react-dom";
import { type JSX, type ReactNode, useEffect, useId, useMemo, useState } from "react";

import type {
  ChromeProfileImportPreview,
  ChromeProfileImportProgress,
  ChromeProfileImportResolution,
  ChromeProfileImportResult,
  Game,
  Role
} from "../../../../shared/types";
import type { Translator } from "../../i18n";
import { useConfirmation } from "../../components/confirmation";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Surface } from "../../components/ui/patterns";

interface ChromeProfileImportFlowProps {
  games: Game[];
  onClose?: () => void;
  openOnMount?: boolean;
  roles: Role[];
  showTrigger?: boolean;
  t: Translator;
  onError: (error: unknown) => void;
}

export function ChromeProfileImportFlow({
  games,
  onClose,
  openOnMount = false,
  roles,
  showTrigger = true,
  t,
  onError
}: ChromeProfileImportFlowProps): JSX.Element {
  const confirm = useConfirmation();
  const [consentOpen, setConsentOpen] = useState(openOnMount);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [preview, setPreview] = useState<ChromeProfileImportPreview | null>(null);
  const [selectedGameId, setSelectedGameId] = useState("");
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<ChromeProfileImportProgress | null>(null);
  const [result, setResult] = useState<ChromeProfileImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyInProgress, setApplyInProgress] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [launchingRoleId, setLaunchingRoleId] = useState<string | null>(null);

  useEffect(() => {
    if (!preview || !window.rionStudio) return;
    return window.rionStudio.onChromeProfileImportProgress((next) => {
      if (next.importId === preview.importId) setProgress(next);
    });
  }, [preview]);

  const conflicts = useMemo(() => {
    const byProfile = new Map<string, Role[]>();
    if (!preview || !selectedGameId) return byProfile;
    for (const profile of preview.profiles) {
      byProfile.set(
        profile.id,
        roles.filter(
          (role) =>
            role.gameId === selectedGameId &&
            importNamesMatch(role.name, profile.name)
        )
      );
    }
    return byProfile;
  }, [preview, roles, selectedGameId]);

  const unresolved = selectedProfiles.some(
    (profileId) => {
      const profile = preview?.profiles.find((candidate) => candidate.id === profileId);
      const duplicateSelectedName = Boolean(profile) && selectedProfiles.some((candidateId) => {
        if (candidateId === profileId) return false;
        const candidate = preview?.profiles.find((entry) => entry.id === candidateId);
        return candidate ? importNamesMatch(candidate.name, profile!.name) : false;
      });
      return ((conflicts.get(profileId)?.length ?? 0) > 0 || duplicateSelectedName) && !decisions[profileId];
    }
  );

  useEffect(() => {
    if (!preview || !selectedGameId) return;
    const profileNameCounts = new Map<string, number>();
    for (const profile of preview.profiles) {
      const name = normalizedImportName(profile.name);
      profileNameCounts.set(name, (profileNameCounts.get(name) ?? 0) + 1);
    }
    const nextSelected: string[] = [];
    const nextDecisions: Record<string, string> = {};
    for (const profile of preview.profiles) {
      const matchingRoles = conflicts.get(profile.id) ?? [];
      if (profileNameCounts.get(normalizedImportName(profile.name)) !== 1 || matchingRoles.length !== 1) continue;
      nextSelected.push(profile.id);
      nextDecisions[profile.id] = `replace:${matchingRoles[0].id}`;
    }
    setSelectedProfiles(nextSelected);
    setDecisions(nextDecisions);
  }, [conflicts, preview, selectedGameId]);

  async function chooseChromeFolder(): Promise<void> {
    if (!window.rionStudio || !consentAccepted) return;
    setBusy(true);
    try {
      const next = await window.rionStudio.previewChromeProfileImport();
      if (next) {
        setPreview(next);
        setConsentOpen(false);
        setSelectedGameId("");
        setSelectedProfiles([]);
        setDecisions({});
        setResult(null);
        setProgress(null);
      }
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  async function closeChrome(): Promise<void> {
    if (!preview || !window.rionStudio) return;
    const approved = await confirm({
      title: t("settings.chromeImportQuitTitle"),
      description: t("settings.chromeImportQuitDescription"),
      cancelLabel: t("settings.importCancel"),
      confirmLabel: t("settings.chromeImportQuit")
    });
    if (!approved) return;
    setBusy(true);
    try {
      setPreview(await window.rionStudio.requestChromeQuitForImport(preview.importId));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  function toggleProfile(profileId: string, checked: boolean): void {
    setSelectedProfiles((current) =>
      checked ? [...current, profileId] : current.filter((id) => id !== profileId)
    );
    if (!checked) {
      setDecisions((current) => {
        const next = { ...current };
        delete next[profileId];
        return next;
      });
    }
  }

  async function applyImport(): Promise<void> {
    if (!preview || !window.rionStudio || !selectedGameId || unresolved) return;
    const resolutions: ChromeProfileImportResolution[] = selectedProfiles.map((profileId) => {
      const decision = decisions[profileId];
      if (decision === "copy") return { action: "copy", profileId };
      if (decision?.startsWith("replace:")) {
        return {
          action: "replace",
          profileId,
          targetRoleId: decision.slice("replace:".length)
        };
      }
      return { action: "create", profileId };
    });
    const approved = await confirm({
      title: t("settings.chromeImportConfirmTitle"),
      description: t("settings.chromeImportConfirmDescription")
        .replace("{count}", String(resolutions.length)),
      cancelLabel: t("settings.importCancel"),
      confirmLabel: t("settings.chromeImportApply")
    });
    if (!approved) return;
    setBusy(true);
    setApplyInProgress(true);
    setCancelRequested(false);
    setProgress({
      importId: preview.importId,
      profileId: resolutions[0]?.profileId,
      phase: "copying",
      completed: 0,
      total: resolutions.length
    });
    try {
      const next = await window.rionStudio.applyChromeProfileImport({
        importId: preview.importId,
        gameId: selectedGameId,
        consentAccepted: true,
        resolutions
      });
      setResult(next);
    } catch (error) {
      onError(error);
    } finally {
      setApplyInProgress(false);
      setCancelRequested(false);
      setBusy(false);
    }
  }

  async function openRoleForLogin(roleId: string): Promise<void> {
    if (!window.rionStudio || launchingRoleId) return;
    setLaunchingRoleId(roleId);
    try {
      await window.rionStudio.launchRole(roleId);
    } catch (error) {
      onError(error);
    } finally {
      setLaunchingRoleId(null);
    }
  }

  async function closePreview(): Promise<void> {
    const current = preview;
    if (busy) {
      if (!applyInProgress || !current || !window.rionStudio || cancelRequested) return;
      setCancelRequested(true);
      try {
        await window.rionStudio.discardChromeProfileImport(current.importId);
      } catch (error) {
        setCancelRequested(false);
        onError(error);
      }
      return;
    }
    setPreview(null);
    setResult(null);
    setProgress(null);
    if (!current || !window.rionStudio || result) {
      onClose?.();
      return;
    }
    try {
      await window.rionStudio.discardChromeProfileImport(current.importId);
      onClose?.();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      {showTrigger ? (
        <Button
          type="button"
          onClick={() => {
            setConsentAccepted(false);
            setConsentOpen(true);
          }}
        >
          <Upload size={14} />
          {t("settings.chromeImportAction")}
        </Button>
      ) : null}

      {consentOpen ? (
        <Modal
          title={t("settings.chromeImportConsentTitle")}
          description={t("settings.chromeImportConsentDescription")}
          actions={(
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => { setConsentOpen(false); onClose?.(); }}>
                {t("settings.importCancel")}
              </Button>
              <Button type="button" disabled={busy || !consentAccepted} onClick={() => void chooseChromeFolder()}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {t("settings.chromeImportChooseFolder")}
              </Button>
            </>
          )}
        >
          <label className="flex items-start gap-3 rounded-md border border-border/45 bg-background/25 p-3 text-xs leading-5 text-muted-foreground">
            <Checkbox
              className="mt-0.5"
              checked={consentAccepted}
              disabled={busy}
              onCheckedChange={(checked) => setConsentAccepted(checked === true)}
            />
            <span>{t("settings.chromeImportConsentCheckbox")}</span>
          </label>
        </Modal>
      ) : null}

      {preview ? (
        <Modal
          title={t("settings.chromeImportTitle")}
          description={t("settings.chromeImportDescription")}
          wide
          actions={(
            <>
              <Button
                type="button"
                variant="outline"
                disabled={(busy && !applyInProgress) || cancelRequested}
                onClick={() => void closePreview()}
              >
                {cancelRequested ? <Loader2 size={14} className="animate-spin" /> : null}
                {t(cancelRequested ? "settings.chromeImportCancelling" : result ? "common.close" : "settings.importCancel")}
              </Button>
              {!result && !applyInProgress ? (
                <Button
                  type="button"
                  disabled={busy || preview.sourceInUse || !selectedGameId || selectedProfiles.length === 0 || unresolved}
                  onClick={() => void applyImport()}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {t("settings.chromeImportApply")}
                </Button>
              ) : null}
            </>
          )}
        >
          {preview.sourceInUse ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs leading-5 text-muted-foreground">{t("settings.chromeImportRunning")}</p>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void closeChrome()}>
                {t("settings.chromeImportQuit")}
              </Button>
            </div>
          ) : null}

          {result ? (
            <div className="grid gap-2">
              {result.items.length === 0 ? (
                <div className="rounded-md border border-border/45 bg-background/25 p-4 text-center text-xs font-semibold text-muted-foreground">
                  {t("settings.chromeImportCancelled")}
                </div>
              ) : result.items.map((item) => (
                <div key={item.profileId} className="rounded-md border border-border/45 bg-background/25 p-3 text-xs leading-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-foreground">{item.roleName}</span>
                    <span className={chromeImportStatusClass(item.status)}>
                      {chromeImportStatusLabel(item.status, t)}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {t("settings.chromeImportCounts")
                      .replace("{cookies}", String(item.cookieCount))
                      .replace("{storage}", String(item.localStorageCount))}
                  </p>
                  {unsupportedCount(item.unsupported) > 0 ? (
                    <p className="text-amber-600">
                      {t("settings.chromeImportUnsupportedCounts")
                        .replace("{partitioned}", String(item.unsupported.partitionedCookieCount))
                        .replace("{appBound}", String(item.unsupported.appBoundCookieCount))
                        .replace("{decrypt}", String(item.unsupported.decryptFailureCount))
                        .replace("{storage}", String(item.unsupported.storageReadFailureCount))}
                    </p>
                  ) : null}
                  {item.warnings.length > 0 ? (
                    <p className="break-words text-amber-600">
                      {item.warnings.map((warning) => chromeImportWarningLabel(warning, t)).join(" · ")}
                    </p>
                  ) : null}
                  {item.status === "needsLogin" && item.roleId ? (
                    <Button
                      className="mt-2"
                      type="button"
                      variant="outline"
                      disabled={launchingRoleId !== null}
                      onClick={() => void openRoleForLogin(item.roleId!)}
                    >
                      {launchingRoleId === item.roleId
                        ? <Loader2 size={14} className="animate-spin" />
                        : <LogIn size={14} />}
                      {t("settings.chromeImportOpenLogin")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : applyInProgress ? (
            <ChromeImportProgressPanel
              cancelRequested={cancelRequested}
              preview={preview}
              progress={progress}
              selectedCount={selectedProfiles.length}
              t={t}
            />
          ) : (
            <>
              <label className="grid gap-1.5 text-xs font-semibold text-foreground">
                {t("settings.chromeImportGame")}
                <Select value={selectedGameId} disabled={busy} onValueChange={setSelectedGameId}>
                  <SelectTrigger><SelectValue placeholder={t("settings.chromeImportChooseGame")} /></SelectTrigger>
                  <SelectContent>
                    {games.map((game) => <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <div className="grid gap-2">
                {preview.profiles.map((profile) => {
                  const selected = selectedProfiles.includes(profile.id);
                  const matchingRoles = conflicts.get(profile.id) ?? [];
                  const duplicateSelectedName = selectedProfiles.some((candidateId) => {
                    if (candidateId === profile.id) return false;
                    const candidate = preview.profiles.find((entry) => entry.id === candidateId);
                    return candidate ? importNamesMatch(candidate.name, profile.name) : false;
                  });
                  return (
                    <div key={profile.id} className="rounded-md border border-border/45 bg-background/25 p-3">
                      <label className="flex items-center gap-3 text-xs font-semibold text-foreground">
                        <Checkbox
                          checked={selected}
                          disabled={busy}
                          onCheckedChange={(checked) => toggleProfile(profile.id, checked === true)}
                        />
                        <span>{profile.name}</span>
                        <span className="font-normal text-muted-foreground">{profile.directoryName}</span>
                      </label>
                      {selected && (matchingRoles.length > 0 || duplicateSelectedName) ? (
                        <select
                          className="mt-3 h-9 w-full rounded-md border border-border/50 bg-background px-2 text-xs text-foreground"
                          value={decisions[profile.id] ?? ""}
                          disabled={busy}
                          onChange={(event) => setDecisions((current) => ({ ...current, [profile.id]: event.target.value }))}
                        >
                          <option value="">{t("settings.chromeImportConflictChoose")}</option>
                          <option value="copy">{t("settings.chromeImportCreateCopy")}</option>
                          {matchingRoles.map((role) => (
                            <option key={role.id} value={`replace:${role.id}`}>
                              {t("settings.chromeImportReplace").replace("{name}", role.name)}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}

function Modal({
  actions,
  children,
  description,
  title,
  wide = false
}: {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  title: string;
  wide?: boolean;
}): JSX.Element {
  const titleId = useId();
  const descriptionId = useId();

  return createPortal(
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className={`flex max-h-[calc(100vh-2.5rem)] w-full ${wide ? "max-w-[680px]" : "max-w-[520px]"} flex-col overflow-hidden`}
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 id={titleId} className="text-[15px] font-semibold leading-6 text-foreground">{title}</h2>
          <p id={descriptionId} className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4">{children}</div>
        {actions ? (
          <div className="glass-divider flex shrink-0 justify-end gap-2 border-t px-5 py-4">
            {actions}
          </div>
        ) : null}
      </Surface>
    </div>,
    document.body
  );
}

function ChromeImportProgressPanel({
  cancelRequested,
  preview,
  progress,
  selectedCount,
  t
}: {
  cancelRequested: boolean;
  preview: ChromeProfileImportPreview;
  progress: ChromeProfileImportProgress | null;
  selectedCount: number;
  t: Translator;
}): JSX.Element {
  const total = progress?.total || selectedCount;
  const completed = Math.min(progress?.completed ?? 0, total);
  const phase = progress?.phase ?? "copying";
  const profileName = preview.profiles.find((profile) => profile.id === progress?.profileId)?.name;
  const percent = chromeImportProgressPercent(completed, total, phase);

  return (
    <div
      className="grid min-h-56 place-items-center rounded-lg border border-border/45 bg-background/25 p-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="grid w-full max-w-md gap-4">
        <div className="mx-auto grid size-11 place-items-center rounded-full border border-primary/20 bg-primary/10 text-primary">
          <Loader2 size={20} className="animate-spin" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">
            {profileName ?? t("settings.chromeImportApply")}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.chromeImportProgress")
              .replace("{phase}", chromeImportPhaseLabel(phase, t))
              .replace("{completed}", String(completed))
              .replace("{total}", String(total))}
          </p>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-border/60"
          role="progressbar"
          aria-label={t("settings.chromeImportApply")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {t(cancelRequested
            ? "settings.chromeImportCancelNotice"
            : "settings.chromeImportWorking")}
        </p>
      </div>
    </div>
  );
}

function chromeImportProgressPercent(completed: number, total: number, phase: string): number {
  if (total <= 0) return 0;
  const phaseProgress: Record<string, number> = {
    copying: 0.1,
    backingUp: 0.3,
    applying: 0.6,
    verifying: 0.85,
    complete: 0
  };
  return Math.min(
    100,
    Math.max(0, Math.round(((completed + (phaseProgress[phase] ?? 0)) / total) * 100))
  );
}

function chromeImportPhaseLabel(phase: string, t: Translator): string {
  switch (phase) {
    case "copying":
      return t("settings.chromeImportPhaseCopying");
    case "backingUp":
      return t("settings.chromeImportPhaseBackingUp");
    case "applying":
      return t("settings.chromeImportPhaseApplying");
    case "verifying":
      return t("settings.chromeImportPhaseVerifying");
    case "complete":
      return t("settings.chromeImportPhaseComplete");
    default:
      return phase;
  }
}

function normalizedImportName(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function importNamesMatch(left: string, right: string): boolean {
  return normalizedImportName(left) === normalizedImportName(right);
}

function unsupportedCount(value: ChromeProfileImportResult["items"][number]["unsupported"]): number {
  return value.partitionedCookieCount
    + value.appBoundCookieCount
    + value.decryptFailureCount
    + value.storageReadFailureCount;
}

function chromeImportStatusClass(status: ChromeProfileImportResult["items"][number]["status"]): string {
  if (status === "imported" || status === "alreadyAuthenticated") return "text-emerald-600";
  if (status === "cancelled" || status === "needsLogin") return "text-amber-600";
  return "text-destructive";
}

function chromeImportStatusLabel(
  status: ChromeProfileImportResult["items"][number]["status"],
  t: Translator
): string {
  switch (status) {
    case "imported": return t("settings.chromeImportSuccess");
    case "needsLogin": return t("settings.chromeImportNeedsLogin");
    case "alreadyAuthenticated": return t("settings.chromeImportAlreadyAuthenticated");
    case "cancelled": return t("settings.chromeImportCancelled");
    default: return t("settings.chromeImportFailed");
  }
}

function chromeImportWarningLabel(warning: string, t: Translator): string {
  switch (warning) {
    case "COOKIE_PARTITIONED_UNSUPPORTED": return t("settings.chromeImportWarningPartitioned");
    case "COOKIE_APP_BOUND_UNSUPPORTED": return t("settings.chromeImportWarningAppBound");
    case "COOKIE_DECRYPT_FAILED": return t("settings.chromeImportWarningDecrypt");
    case "LOCAL_STORAGE_READ_FAILED": return t("settings.chromeImportWarningStorage");
    default: return warning;
  }
}
