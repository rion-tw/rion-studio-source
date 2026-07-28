import appIconUrl from "../assets/app-icon.png";
import { LANGUAGE_STORAGE_KEY } from "./constants";
import {
  createTranslator,
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
  shell.setAttribute("data-tauri-drag-region", "");

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
updateDocumentLanguage();

void loadTranslations(language)
  .then((translations) => {
    translate = createTranslator(language, translations);
    updateDocumentLanguage();
  })
  .catch(() => undefined);
