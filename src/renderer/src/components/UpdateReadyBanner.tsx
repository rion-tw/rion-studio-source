import { RotateCcw } from "lucide-react";
import { type JSX, useState } from "react";

import type { AppUpdateStatus } from "../../../shared/types";
import type { Translator } from "../i18n";
import { Button } from "./ui/button";
import { Surface } from "./ui/patterns";

interface UpdateReadyBannerProps {
  status: AppUpdateStatus | null;
  t: Translator;
  onInstall: () => Promise<void>;
}

export function UpdateReadyBanner({ status, t, onInstall }: UpdateReadyBannerProps): JSX.Element | null {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const version = status?.state === "downloaded" ? status.availableVersion : undefined;

  if (!version || dismissedVersion === version) return null;

  const install = async (): Promise<void> => {
    setIsInstalling(true);
    try {
      await onInstall();
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <Surface
      className="absolute right-5 top-5 z-[var(--layer-toast)] w-[min(360px,calc(100%_-_2.5rem))] border-activity/35 p-4 shadow-xl"
      role="status"
      variant="strong"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-activity/12 text-activity">
          <RotateCcw size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-foreground">{t("app.updateReadyTitle")}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("app.updateReadyDescription").replace("{version}", version)}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={isInstalling}
              onClick={() => setDismissedVersion(version)}
            >
              {t("app.updateLater")}
            </Button>
            <Button type="button" disabled={isInstalling} onClick={() => void install()}>
              <RotateCcw className={isInstalling ? "animate-spin" : undefined} size={14} />
              {t("app.updateRestartNow")}
            </Button>
          </div>
        </div>
      </div>
    </Surface>
  );
}
