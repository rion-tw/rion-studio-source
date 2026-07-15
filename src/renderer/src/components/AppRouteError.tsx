import { AlertTriangle, RefreshCw } from "lucide-react";
import { type JSX, useEffect, useMemo, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router";

import appIconUrl from "../assets/app-icon.png";
import { LANGUAGE_STORAGE_KEY } from "../app/constants";
import {
  createTranslator,
  getLoadedTranslations,
  loadTranslations,
  readStoredLanguage,
  type TranslationDictionary,
  type Translator
} from "../i18n";
import { Button } from "./ui/button";
import { Surface } from "./ui/patterns";

interface AppRouteErrorProps {
  onReload?: () => void;
}

export function AppRouteError({ onReload = reloadWindow }: AppRouteErrorProps): JSX.Element {
  const error = useRouteError();
  const language = readStoredLanguage(LANGUAGE_STORAGE_KEY);
  const [translations, setTranslations] = useState<TranslationDictionary | undefined>(() =>
    getLoadedTranslations(language)
  );
  const t = useMemo(() => createTranslator(language, translations), [language, translations]);
  const details = formatRouteError(error, t);

  useEffect(() => {
    let isDisposed = false;

    void loadTranslations(language)
      .then((loadedTranslations) => {
        if (!isDisposed) {
          setTranslations(loadedTranslations);
        }
      })
      .catch(() => undefined);

    return () => {
      isDisposed = true;
    };
  }, [language]);

  return (
    <div className="liquid-app-shell app-drag grid h-screen place-items-center overflow-hidden p-6 text-foreground">
      <main className="app-no-drag grid w-full max-w-[520px] justify-items-center gap-5 text-center" role="alert">
        <img
          className="size-16 rounded-lg shadow-lg shadow-black/10"
          src={appIconUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <Surface className="w-full p-5 text-left" variant="strong">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 shrink-0 text-destructive" size={19} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold leading-6">{t("routeError.title")}</h1>
              <p className="mt-1 text-xs font-medium leading-5 text-muted-foreground">
                {t("routeError.description")}
              </p>
            </div>
          </div>

          <Button className="mt-5" type="button" onClick={onReload}>
            <RefreshCw size={15} aria-hidden="true" />
            {t("routeError.reload")}
          </Button>

          <details className="mt-5 border-t border-border/60 pt-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-semibold text-foreground">
              {t("routeError.details")}
            </summary>
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/50 p-3 font-mono text-[11px] leading-5 text-muted-foreground select-text">
              {details}
            </pre>
          </details>
        </Surface>
      </main>
    </div>
  );
}

function formatRouteError(error: unknown, t: Translator): string {
  if (error instanceof Error) {
    return error.stack?.trim() || `${error.name}: ${error.message}`;
  }

  if (isRouteErrorResponse(error)) {
    const heading = `${error.status} ${error.statusText}`.trim();
    const data = formatUnknownError(error.data);
    return data ? `${heading}\n${data}` : heading;
  }

  return formatUnknownError(error) || t("error.unexpected");
}

function formatUnknownError(error: unknown): string | undefined {
  if (typeof error === "string") {
    return error;
  }

  try {
    const serialized = JSON.stringify(error, null, 2);
    return serialized || undefined;
  } catch {
    return undefined;
  }
}

function reloadWindow(): void {
  window.location.reload();
}
