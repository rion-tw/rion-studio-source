import { Chrome, X } from "lucide-react";
import { type JSX, useEffect } from "react";

import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import type { Role } from "../../../../shared/types";
import { LoginSessionGuide } from "./LoginSessionGuide";

interface LoginGuideModalProps {
  role: Role;
  t: Translator;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function LoginGuideModal({ role, t, onCancel, onConfirm }: LoginGuideModalProps): JSX.Element {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-5">
      <button
        className="app-modal-backdrop absolute inset-0 cursor-default"
        type="button"
        aria-label={t("loginGuide.aria.close")}
        onClick={onCancel}
      />
      <Surface
        className="relative z-10 grid max-h-[calc(100vh-2.5rem)] w-full max-w-3xl gap-4 overflow-auto p-5 text-card-foreground"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-guide-title"
        radius="lg"
        variant="modal"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="login-guide-title" className="text-base font-semibold leading-6 text-foreground">
              {t("loginGuide.modalTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("loginGuide.modalDescription").replace("{name}", role.name)}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("loginGuide.aria.close")}
            aria-label={t("loginGuide.aria.close")}
            onClick={onCancel}
          >
            <X size={17} />
          </Button>
        </div>

        <LoginSessionGuide roleName={role.name} t={t} />

        <div className="glass-divider flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="sm:min-w-[120px]" onClick={onCancel}>
            {t("loginGuide.cancel")}
          </Button>
          <Button type="button" className="sm:min-w-[210px]" onClick={onConfirm}>
            <Chrome size={16} />
            {t("loginGuide.confirm")}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
