import { X } from "lucide-react";
import { type JSX, useEffect } from "react";

import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Language, Translator } from "../../i18n";
import { CURRENT_LEGAL_RELEASE } from "../../../../shared/legal";
import { getLegalDocument, type LegalDocumentKind } from "./legalDocuments";
import { LegalMarkdown } from "./legalMarkdown";

interface LegalDocumentDialogProps {
  kind: LegalDocumentKind;
  language: Language;
  onClose: () => void;
  t: Translator;
}

const titleKeys = {
  fairUse: "legal.document.fairUse",
  privacy: "legal.document.privacy",
  terms: "legal.document.terms",
  thirdParty: "legal.document.thirdParty"
} as const;

export function LegalDocumentDialog({ kind, language, onClose, t }: LegalDocumentDialogProps): JSX.Element {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="app-no-drag fixed inset-0 z-[70] grid place-items-center p-4">
      <button className="app-modal-backdrop absolute inset-0" type="button" aria-label={t("legal.close")} onClick={onClose} />
      <Surface
        className="relative z-10 flex h-[min(760px,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden"
        radius="lg"
        variant="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-document-title"
      >
        <header className="glass-divider flex items-center justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 id="legal-document-title" className="text-base font-semibold">{t(titleKeys[kind])}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("legal.version").replace("{version}", CURRENT_LEGAL_RELEASE)}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" title={t("legal.close")} onClick={onClose}>
            <X size={17} />
          </Button>
        </header>
        <div className="app-scroll-region min-h-0 flex-1 overflow-auto px-6 py-5 md:px-10 md:py-7">
          <LegalMarkdown markdown={getLegalDocument(kind, language)} />
        </div>
      </Surface>
    </div>
  );
}
