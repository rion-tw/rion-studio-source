import { Loader2, Upload } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useMemo, useState } from "react";

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
  roles: Role[];
  t: Translator;
  onError: (error: unknown) => void;
}

export function ChromeProfileImportFlow({
  games,
  roles,
  t,
  onError
}: ChromeProfileImportFlowProps): JSX.Element {
  const confirm = useConfirmation();
  const [consentOpen, setConsentOpen] = useState(false);
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
            role.name.localeCompare(profile.name, undefined, { sensitivity: "accent" }) === 0
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
        return candidate?.name.localeCompare(profile!.name, undefined, { sensitivity: "accent" }) === 0;
      });
      return ((conflicts.get(profileId)?.length ?? 0) > 0 || duplicateSelectedName) && !decisions[profileId];
    }
  );

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
    setBusy(true);
    setApplyInProgress(true);
    setCancelRequested(false);
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
    if (!current || !window.rionStudio || result) return;
    try {
      await window.rionStudio.discardChromeProfileImport(current.importId);
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
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

      {consentOpen ? (
        <Modal title={t("settings.chromeImportConsentTitle")} description={t("settings.chromeImportConsentDescription")}>
          <label className="flex items-start gap-3 rounded-md border border-border/45 bg-background/25 p-3 text-xs leading-5 text-muted-foreground">
            <Checkbox
              className="mt-0.5"
              checked={consentAccepted}
              disabled={busy}
              onCheckedChange={(checked) => setConsentAccepted(checked === true)}
            />
            <span>{t("settings.chromeImportConsentCheckbox")}</span>
          </label>
          <ModalActions>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConsentOpen(false)}>
              {t("settings.importCancel")}
            </Button>
            <Button type="button" disabled={busy || !consentAccepted} onClick={() => void chooseChromeFolder()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {t("settings.chromeImportChooseFolder")}
            </Button>
          </ModalActions>
        </Modal>
      ) : null}

      {preview ? (
        <Modal title={t("settings.chromeImportTitle")} description={t("settings.chromeImportDescription")} wide>
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
              {result.items.map((item) => (
                <div key={item.profileId} className="rounded-md border border-border/45 bg-background/25 p-3 text-xs leading-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-foreground">{item.roleName}</span>
                    <span className={item.status === "imported" ? "text-emerald-600" : item.status === "cancelled" ? "text-amber-600" : "text-destructive"}>
                      {t(item.status === "imported"
                        ? "settings.chromeImportSuccess"
                        : item.status === "cancelled"
                          ? "settings.chromeImportCancelled"
                          : "settings.chromeImportFailed")}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {t("settings.chromeImportCounts")
                      .replace("{cookies}", String(item.cookieCount))
                      .replace("{storage}", String(item.localStorageCount))}
                  </p>
                  {item.warnings.length > 0 ? (
                    <p className="break-words text-amber-600">{item.warnings.join(" · ")}</p>
                  ) : null}
                </div>
              ))}
            </div>
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
                    return candidate?.name.localeCompare(profile.name, undefined, { sensitivity: "accent" }) === 0;
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
              {progress ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("settings.chromeImportProgress")
                    .replace("{phase}", chromeImportPhaseLabel(progress.phase, t))
                    .replace("{completed}", String(progress.completed))
                    .replace("{total}", String(progress.total))}
                </p>
              ) : null}
            </>
          )}

          <ModalActions>
            <Button
              type="button"
              variant="outline"
              disabled={(busy && !applyInProgress) || cancelRequested}
              onClick={() => void closePreview()}
            >
              {t(cancelRequested ? "settings.chromeImportCancelling" : result ? "common.close" : "settings.importCancel")}
            </Button>
            {!result ? (
              <Button
                type="button"
                disabled={busy || preview.sourceInUse || !selectedGameId || selectedProfiles.length === 0 || unresolved}
                onClick={() => void applyImport()}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {t("settings.chromeImportApply")}
              </Button>
            ) : null}
          </ModalActions>
        </Modal>
      ) : null}
    </>
  );
}

function Modal({
  children,
  description,
  title,
  wide = false
}: {
  children: ReactNode;
  description: string;
  title: string;
  wide?: boolean;
}): JSX.Element {
  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-black/35 p-5 backdrop-blur-sm">
      <Surface
        className={`flex max-h-[calc(100vh-2.5rem)] w-full ${wide ? "max-w-[680px]" : "max-w-[520px]"} flex-col overflow-hidden`}
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
      >
        <div className="glass-divider border-b px-5 py-4">
          <h2 className="text-[15px] font-semibold leading-6 text-foreground">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <div className="grid gap-4 overflow-y-auto px-5 py-4">{children}</div>
      </Surface>
    </div>
  );
}

function ModalActions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="glass-divider -mx-5 -mb-4 flex justify-end gap-2 border-t px-5 py-4">{children}</div>;
}

function chromeImportPhaseLabel(phase: string, t: Translator): string {
  switch (phase) {
    case "copying":
      return t("settings.chromeImportPhaseCopying");
    case "backingUp":
      return t("settings.chromeImportPhaseBackingUp");
    case "applying":
      return t("settings.chromeImportPhaseApplying");
    case "complete":
      return t("settings.chromeImportPhaseComplete");
    default:
      return phase;
  }
}
