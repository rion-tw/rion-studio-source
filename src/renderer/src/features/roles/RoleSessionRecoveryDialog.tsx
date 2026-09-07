import { useEffect, useId, useRef, useState } from "react";
import type { RoleSessionRecoveryRecord } from "../../../../shared/generated";
import { upgradeDataStatus } from "./upgradeResult";
import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { TranslationKey, Translator } from "../../i18n";

export default function RoleSessionRecoveryDialog({ roleId, t, onClose }: {
  roleId: string; t: Translator; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [record, setRecord] = useState<RoleSessionRecoveryRecord | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<string | null>(null);
  const latest = useRef<RoleSessionRecoveryRecord | null>(null);
  const alive = useRef(true);
  function accept(next: RoleSessionRecoveryRecord) {
    const current = latest.current;
    if (current?.attemptId === next.attemptId && current.revision >= next.revision) return;
    latest.current = next;
    setRecord(next);
    setBusy(["reading", "isolatedImport", "formalImport"].includes(next.phase));
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    const unsubscribe = window.rionStudio.onSessionMigrationRecovery((next) => {
      if (next.roleId !== roleId || next.attemptId !== attempt.current) return;
      accept(next);
    });
    void window.rionStudio.sessionMigrationRecovery({ type: "inspect", roleId }).then((next) => {
      if (!alive.current) return;
      attempt.current = next.attemptId;
      accept(next);
      if (next.candidates.length === 1) setToken(next.candidates[0].token);
    }).catch((reason: unknown) => { if (alive.current) setError(errorCode(reason)); });
    return () => { alive.current = false; unsubscribe(); };
  }, [roleId]);
  const candidate = record?.candidates.find((item) => item.token === token);
  const blockers = [...(record?.blockers ?? []).filter((code) => code !== "RECOVERY_SOURCE_SELECTION_REQUIRED" || !token), ...(candidate?.blockers ?? [])];
  const canRecover = record?.phase === "inspected" && candidate?.supported && blockers.length === 0;
  async function recover() {
    if (!record || !canRecover || busy) return;
    const attemptId = crypto.randomUUID();
    attempt.current = attemptId;
    setBusy(true); setError(null);
    try {
      const next = await window.rionStudio.sessionMigrationRecovery({ type: "recover", roleId, attemptId, expectedJournalRevision: record.journalRevision, sourceToken: token });
      if (alive.current) accept(next);
    } catch (reason) { if (alive.current) setError(errorCode(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function cancel() {
    if (!attempt.current) return;
    try {
      const next = await window.rionStudio.sessionMigrationRecovery({ type: "cancel", roleId, attemptId: attempt.current });
      if (alive.current && next.phase === "failed") setError(next.blockers[0] ?? "RECOVERY_CHECK_FAILED");
    }
    catch (reason) { if (alive.current) setError(errorCode(reason)); }
  }
  return <dialog ref={dialog} aria-labelledby={titleId} className="confirmation-dialog m-auto w-[min(560px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <Surface variant="modal" radius="lg" className="grid max-h-[calc(100vh-2rem)] gap-4 overflow-y-auto p-5">
      <h2 id={titleId} className="text-title font-semibold">{t("recovery.title")}</h2>
      <p className="text-body text-muted-foreground">{t(record?.phase === "freshReady" ? "recovery.upgradeDescription" : "recovery.description")}</p>
      <p role="status" className="text-body">{t(phaseKey(record?.phase))}</p>
      {record?.upgradeResult && <div className="grid gap-2 text-body" data-testid="session-upgrade-result">
        <p>Cookies: {upgradeDataStatus(record.upgradeResult.cookies, t)} ({record.upgradeResult.cookieCount})</p>
        <p>localStorage: {upgradeDataStatus(record.upgradeResult.localStorage, t)} ({record.upgradeResult.localStorageOriginCount} / {record.upgradeResult.localStorageEntryCount})</p>
        <p className="text-caption text-muted-foreground">{t("recovery.upgradeOtherData")}</p>
        {record.upgradeResult.reasons.length > 0 && <details className="text-caption break-words"><summary>{t("recovery.upgradeDetails")}</summary>
          <ul>{record.upgradeResult.reasons.map(code => <li key={code}>{code}</li>)}</ul></details>}
      </div>}
      {record?.phase === "inspected" && <fieldset disabled={busy} className="grid gap-2">
        <legend className="mb-2 text-heading">{t("recovery.source")}</legend>
        {record.candidates.map((item) => <label key={item.token} className="grid gap-1 rounded-md border border-border p-3 text-control">
          <span className="flex items-center gap-2"><input type="radio" name={titleId} checked={token === item.token} onChange={() => setToken(item.token)} />
            {t(item.application === "authenticatedExport" ? "recovery.export" : item.application.includes(".dev") ? "recovery.development" : "recovery.production")}</span>
          <span>{t("recovery.inventory").replace("{cookies}", item.cookieCount === null ? t("recovery.unknown") : String(item.cookieCount)).replace("{origins}", String(item.localStorageOriginCount)).replace("{entries}", item.localStorageEntryCount === null ? t("recovery.unknown") : String(item.localStorageEntryCount))}</span>
          {item.otherWebsiteDataPresent && <span>{t("recovery.otherData")}</span>}
        </label>)}
      </fieldset>}
      {(blockers.length > 0 || error) && <div role="alert" className="grid gap-2 text-body text-destructive">
        <p>{t("recovery.blocked")}</p>
        <ul className="list-disc break-words pl-4">{[...new Set([...blockers, ...(error ? [error] : [])])].map((code) => <li key={code}>{t(blockerKey(code))}<span className="block text-caption text-muted-foreground">{code}</span></li>)}</ul>
      </div>}
      <p className="text-control text-muted-foreground">{t("recovery.login")}</p>
      <div className="flex justify-end gap-2">
        {busy ? <Button variant="secondary" disabled={record?.attemptId !== attempt.current} onClick={() => void cancel()}>{t("recovery.cancel")}</Button> : <Button variant="secondary" onClick={onClose}>{t("recovery.close")}</Button>}
        {record?.phase === "inspected" && <Button disabled={!canRecover || busy} onClick={() => void recover()}>{t("recovery.title")}</Button>}
      </div>
    </Surface>
  </dialog>;
}
function phaseKey(phase?: string): TranslationKey {
  const keys: Record<string, TranslationKey> = { inspected: "recovery.inspected", reading: "recovery.reading", isolatedImport: "recovery.verifying", formalImport: "recovery.importing", complete: "recovery.complete", failed: "recovery.failed", cancelled: "recovery.cancelled", freshReady: "recovery.upgradeReady" };
  return keys[phase ?? ""] ?? "recovery.reading";
}
function blockerKey(code: string): TranslationKey {
  if (code.includes("COOKIE") || code.includes("SAMESITE") || code.includes("PARTITION") || code.includes("HOST_ONLY")) return "recovery.cookieGap";
  if (code.includes("SELECTION")) return "recovery.chooseSource";
  if (code.includes("CONFLICT") || code.includes("IN_USE") || code.includes("HANDLES")) return "recovery.conflict";
  if (code.includes("NATIVE_PLATFORM")) return "recovery.platformPending";
  if (code.includes("NOT_ELIGIBLE")) return "recovery.ineligible";
  return "recovery.sourceGap";
}
function errorCode(reason: unknown): string {
  return typeof reason === "object" && reason !== null && "code" in reason && typeof reason.code === "string" ? reason.code : "RECOVERY_CHECK_FAILED";
}
