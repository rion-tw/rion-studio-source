import { X } from "lucide-react";
import { type JSX, useLayoutEffect, useRef } from "react";

import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Language, Translator } from "../../i18n";
import { getLegalDocumentVersion } from "../../../../shared/legal";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRegionRef = useRef<HTMLDivElement>(null);

  // A native modal makes the consent controls behind it inert and keeps focus
  // inside; the opener regains focus before the dialog leaves the DOM.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    // Keyboard scrolling targets the document text, not the header controls.
    scrollRegionRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="legal-document-title"
      className="app-dialog m-auto w-[min(56rem,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Surface
        className="flex h-[min(760px,calc(100vh-2rem))] w-full flex-col overflow-hidden"
        radius="lg"
        variant="modal"
      >
        <header className="glass-divider flex items-center justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 id="legal-document-title" className="text-heading font-semibold">{t(titleKeys[kind])}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("legal.version").replace("{version}", getLegalDocumentVersion(kind))}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" title={t("legal.close")} aria-label={t("legal.close")} onClick={onClose}>
            <X size={17} />
          </Button>
        </header>
        <div
          ref={scrollRegionRef}
          aria-labelledby="legal-document-title"
          className="app-scroll-region min-h-0 flex-1 overflow-auto px-6 py-5 focus-visible:outline-none md:px-10 md:py-7"
          role="region"
          tabIndex={0}
        >
          <LegalMarkdown markdown={getLegalDocument(kind, language)} />
        </div>
      </Surface>
    </dialog>
  );
}
