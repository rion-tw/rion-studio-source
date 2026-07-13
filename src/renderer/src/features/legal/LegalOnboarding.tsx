import { AlertTriangle, Check, FileText, Loader2, LogOut, Network, ShieldCheck } from "lucide-react";
import { type JSX, useState } from "react";

import appIconUrl from "../../assets/app-icon.png";
import { languageLabelKeys } from "../../app/constants";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { Surface } from "../../components/ui/patterns";
import { languages, type Language, type Translator } from "../../i18n";
import { LegalDocumentDialog } from "./LegalDocumentDialog";
import type { LegalDocumentKind } from "./legalDocuments";

interface LegalOnboardingProps {
  error: unknown;
  isAccepting: boolean;
  language: Language;
  onAccept: () => Promise<void>;
  onLanguageChange: (language: Language) => void;
  onQuit: () => Promise<void>;
  t: Translator;
}

export function LegalOnboarding({
  error,
  isAccepting,
  language,
  onAccept,
  onLanguageChange,
  onQuit,
  t
}: LegalOnboardingProps): JSX.Element {
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acknowledgedPrivacy, setAcknowledgedPrivacy] = useState(false);
  const [documentKind, setDocumentKind] = useState<LegalDocumentKind | null>(null);
  const canContinue = acceptedTerms && acknowledgedPrivacy && !isAccepting;

  return (
    <div className="liquid-app-shell app-drag flex h-screen flex-col overflow-hidden p-5 text-foreground md:p-7">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img className="size-10 rounded-lg shadow-sm" src={appIconUrl} alt="" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Rion Studio</p>
            <p className="text-[11px] text-muted-foreground">{t("legal.onboarding.provider")}</p>
          </div>
        </div>
        <Select
          className="app-no-drag w-36"
          value={language}
          aria-label={t("settings.language")}
          onChange={(event) => onLanguageChange(event.target.value as Language)}
        >
          {languages.map((option) => (
            <option key={option} value={option}>{t(languageLabelKeys[option])}</option>
          ))}
        </Select>
      </header>

      <main className="app-no-drag mx-auto grid min-h-0 w-full max-w-5xl flex-1 place-items-center py-5">
        <Surface className="grid max-h-full w-full max-w-4xl overflow-auto" radius="lg" variant="strong">
          <div className="glass-divider border-b px-5 py-5 md:px-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t("legal.onboarding.kicker")}</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("legal.onboarding.title")}</h1>
            <p className="mt-2 max-w-3xl text-[13px] leading-6 text-muted-foreground">{t("legal.onboarding.description")}</p>
          </div>

          <div className="grid gap-3 p-5 md:grid-cols-3 md:p-7">
            <DisclosureCard icon={ShieldCheck} title={t("legal.onboarding.independentTitle")} description={t("legal.onboarding.independentDescription")} />
            <DisclosureCard icon={FileText} title={t("legal.onboarding.sessionTitle")} description={t("legal.onboarding.sessionDescription")} />
            <DisclosureCard icon={Network} title={t("legal.onboarding.networkTitle")} description={t("legal.onboarding.networkDescription")} />
          </div>

          <div className="grid gap-3 px-5 pb-5 md:px-7 md:pb-7">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <DocumentButton label={t("legal.document.terms")} onClick={() => setDocumentKind("terms")} />
              <DocumentButton label={t("legal.document.privacy")} onClick={() => setDocumentKind("privacy")} />
              <DocumentButton label={t("legal.document.fairUse")} onClick={() => setDocumentKind("fairUse")} />
              <DocumentButton label={t("legal.document.thirdParty")} onClick={() => setDocumentKind("thirdParty")} />
            </div>

            <Surface className="grid gap-3 p-4" variant="inset">
              <AgreementCheckbox checked={acceptedTerms} label={t("legal.onboarding.acceptTerms")} onChange={setAcceptedTerms} />
              <AgreementCheckbox checked={acknowledgedPrivacy} label={t("legal.onboarding.acknowledgePrivacy")} onChange={setAcknowledgedPrivacy} />
            </Surface>

            {error ? (
              <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
                <AlertTriangle className="mt-0.5 shrink-0" size={14} />
                <span>{t("legal.onboarding.error")}</span>
              </p>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => void onQuit()} disabled={isAccepting}>
                <LogOut size={15} />
                {t("legal.onboarding.quit")}
              </Button>
              <Button className="sm:min-w-40" type="button" size="lg" disabled={!canContinue} onClick={() => void onAccept()}>
                {isAccepting ? <Loader2 className="animate-spin" size={16} /> : <Check size={16} />}
                {t("legal.onboarding.continue")}
              </Button>
            </div>
          </div>
        </Surface>
      </main>

      {documentKind ? (
        <LegalDocumentDialog kind={documentKind} language={language} t={t} onClose={() => setDocumentKind(null)} />
      ) : null}
    </div>
  );
}

function DisclosureCard({ icon: Icon, title, description }: { icon: typeof ShieldCheck; title: string; description: string }): JSX.Element {
  return (
    <Surface className="grid content-start gap-2 p-4" variant="inset">
      <Icon className="text-muted-foreground" size={19} />
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
    </Surface>
  );
}

function DocumentButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <Button type="button" variant="outline" className="justify-start" onClick={onClick}>
      <FileText size={14} />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function AgreementCheckbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-xs font-medium leading-5 text-foreground">
      <input
        className="mt-0.5 size-4 shrink-0 accent-primary"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
