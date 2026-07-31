// Focused implementation extracted from App.tsx.
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";

import { type JSX } from "react";

import appIconUrl from "../assets/app-icon.png";

import { Button } from "../components/ui/button";

import { Card, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

import { Surface } from "../components/ui/patterns";

import { toMessage } from "./errorUtils";

import { type Language, type Translator } from "../i18n";

export function BootLoadingScreen({
  error,
  language,
  onRetry,
  state,
  t
}: {
  error: unknown | null;
  language: Language;
  onRetry: () => void;
  state: "failed" | "loading";
  t: Translator;
}): JSX.Element {
  const isFailed = state === "failed";

  return (
    <div className="liquid-app-shell app-drag grid h-screen place-items-center overflow-hidden p-6 text-foreground">
      <section
        aria-busy={!isFailed}
        aria-label={!isFailed ? "Loading Rion Studio" : undefined}
        aria-live="polite"
        className="app-no-drag grid w-full max-w-[420px] justify-items-center gap-5 text-center"
      >
        <img
          className="size-16 rounded-md shadow-lg"
          src={appIconUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        {isFailed ? (
          <>
            <div className="grid gap-1">
              <h1 className="text-lg font-semibold leading-7">Rion Studio</h1>
              <p className="text-sm font-medium text-muted-foreground">{t("app.tagline")}</p>
            </div>
            <Surface className="boot-card w-full p-5" variant="strong">
              <div className="grid gap-4 text-left">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 shrink-0 text-destructive" size={18} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-5">{t("loading.failedTitle")}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {error ? toMessage(error, language, t) : t("loading.failedDescription")}
                    </p>
                  </div>
                </div>
                <Button className="justify-self-start" type="button" onClick={onRetry}>
                  <RefreshCw size={15} />
                  {t("loading.retry")}
                </Button>
              </div>
            </Surface>
          </>
        ) : (
          <Loader2 className="spin text-muted-foreground" size={22} aria-hidden="true" />
        )}
      </section>
    </div>
  );
}

export function RouteFallback({ t }: { t: Translator }): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-6" aria-label={t("loading.route")} data-renderer-pending>
      <Surface className="grid size-12 place-items-center boot-card" padding="sm" variant="strong">
        <Loader2 className="spin text-muted-foreground" size={20} />
      </Surface>
    </div>
  );
}

export function BridgeUnavailable({ t }: { t: (key: "bridge.title" | "bridge.description") => string }): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-6">
      <Card className="max-w-lg glass-panel-strong">
        <CardHeader>
          <CardTitle>{t("bridge.title")}</CardTitle>
          <CardDescription>{t("bridge.description")}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
