import appIconUrl from "../assets/app-icon.png";
import { LANGUAGE_STORAGE_KEY } from "./constants";
import {
  createTranslator,
  languages,
  loadTranslations,
  readStoredLanguage,
  type Language,
  type Translator
} from "../i18n";

let language: Language = "en";
let translate: Translator = createTranslator(language);
let lastFailureMessage: string | null = null;

try {
  language = readStoredLanguage(LANGUAGE_STORAGE_KEY);
  translate = createTranslator(language);
} catch {
  // localStorage and navigator language detection can be unavailable during a native startup fault.
}

function updateDocumentLanguage(): void {
  document.documentElement.lang = language;
  const loadingShell = document.querySelector<HTMLElement>("[data-startup-loading]");
  if (loadingShell) {
    loadingShell.setAttribute("aria-label", translate("startup.loading"));
  }
  const loadingLabel = document.querySelector<HTMLElement>("[data-startup-loading-label]");
  if (loadingLabel) {
    loadingLabel.textContent = translate("startup.loading");
  }
  const failureTitle = document.querySelector<HTMLElement>("[data-startup-failure-title]");
  if (failureTitle) {
    failureTitle.textContent = translate("startup.failedTitle");
  }
  updateWindowControlLabels();
}

function updateWindowControlLabels(): void {
  const labels = {
    close: translate("common.close"),
    maximize: translate("common.maximize"),
    minimize: translate("common.minimize"),
    restore: translate("common.restore")
  };
  for (const control of document.querySelectorAll<HTMLButtonElement>("[data-window-control]")) {
    const action = control.dataset.windowControl as "close" | "maximize" | "minimize";
    const label = action === "maximize"
      ? (document.documentElement.dataset.windowMaximized === "true"
        ? labels.restore
        : labels.maximize)
      : labels[action];
    control.ariaLabel = label;
    control.title = label;
  }
}

function installWindowControls(): void {
  const controls = document.querySelector<HTMLElement>("[data-windows-window-controls]");
  if (!controls || controls.dataset.installed === "true") return;
  controls.dataset.installed = "true";
  controls.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-window-control]");
    if (!button) return;
    const api = window.rionStudio;
    const action = button.dataset.windowControl;
    const request = action === "minimize"
      ? api?.minimizeCurrentWindow()
      : action === "maximize"
        ? api?.toggleCurrentWindowMaximize()
        : api?.requestCurrentWindowClose();
    if (!request && action === "close") {
      window.close();
      return;
    }
    void request?.catch((error) => console.error(`Main window ${action} failed.`, error));
  });
  new MutationObserver(updateWindowControlLabels).observe(document.documentElement, {
    attributeFilter: ["data-window-maximized"],
    attributes: true
  });
  window.addEventListener("rion:language-changed", (event) => {
    const nextLanguage = (event as CustomEvent<Language>).detail;
    if (languages.includes(nextLanguage)) loadStartupLanguage(nextLanguage);
  });
}

function loadStartupLanguage(nextLanguage: Language): void {
  language = nextLanguage;
  translate = createTranslator(language);
  updateDocumentLanguage();
  void loadTranslations(nextLanguage)
    .then((translations) => {
      if (language !== nextLanguage) return;
      translate = createTranslator(nextLanguage, translations);
      updateDocumentLanguage();
    })
    .catch(() => undefined);
}

export function startupFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
    && error.message
  ) {
    return error.message;
  }
  return translate("startup.failedDescription");
}

export function showStartupFailure(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;

  lastFailureMessage = startupFailureMessage(error);
  const shell = document.createElement("div");
  shell.className = "boot-fallback";

  const content = document.createElement("main");
  content.className = "boot-fallback-content";
  content.setAttribute("role", "alert");
  content.setAttribute("aria-live", "polite");

  const icon = document.createElement("img");
  icon.className = "boot-fallback-icon";
  icon.src = appIconUrl;
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  icon.draggable = false;

  const panel = document.createElement("section");
  panel.className = "boot-fallback-error";

  const mark = document.createElement("div");
  mark.className = "boot-fallback-error-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "!";

  const status = document.createElement("div");
  status.className = "boot-fallback-status";

  const title = document.createElement("h1");
  title.setAttribute("data-startup-failure-title", "");
  title.textContent = translate("startup.failedTitle");

  const detail = document.createElement("p");
  detail.textContent = lastFailureMessage;

  status.append(title, detail);
  panel.append(mark, status);
  content.append(icon, panel);
  shell.append(content);
  root.replaceChildren(shell);
}

window.__rionShowStartupFailure = showStartupFailure;
installWindowControls();
loadStartupLanguage(language);
