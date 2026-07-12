export type StartupPageState = "failed" | "loading";
export type StartupTheme = "dark" | "light";

export interface StartupPageOptions {
  iconDataUrl?: string;
  state?: StartupPageState;
  theme: StartupTheme;
}

export interface RevealableWindow {
  focus(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  once(event: "closed" | "ready-to-show", listener: () => void): this;
  removeListener(event: "closed" | "ready-to-show", listener: () => void): this;
  show(): void;
}

export interface RendererLoadingWindow {
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
}

export type StartupSequencePhase = "initialize" | "renderer" | "startup";
export type StartupSequenceResult = "closed" | "failed" | "ready";

interface StartupSequenceOptions {
  initialize: () => void | Promise<void>;
  isWindowAvailable: () => boolean;
  loadRenderer: (options: { revealWhenReady: boolean }) => Promise<void>;
  onError: (phase: StartupSequencePhase, error: unknown) => void;
  showFailure: () => Promise<void>;
  showStartup: () => Promise<boolean>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildStartupPage(options: StartupPageOptions): string {
  const state = options.state ?? "loading";
  const isFailed = state === "failed";
  const icon = options.iconDataUrl
    ? `<img class="startup-icon" src="${escapeHtml(options.iconDataUrl)}" alt="" draggable="false" />`
    : '<div class="startup-icon startup-icon-fallback" aria-hidden="true">R</div>';
  const statusTitle = isFailed ? "Unable to start Rion Studio" : "Loading role workspace";
  const statusDescription = isFailed
    ? "The application could not finish starting. Please quit and try again."
    : "Preparing roles, sessions, and workspaces.";
  const indicator = isFailed
    ? '<div class="startup-error-mark" aria-hidden="true">!</div>'
    : '<div class="startup-spinner" aria-hidden="true"></div><div class="startup-progress" aria-hidden="true"><span></span></div>';

  return `<!doctype html>
<html lang="en" data-theme="${options.theme}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
    <title>Rion Studio</title>
    <style>
      :root {
        color-scheme: light;
        --background: 210 25% 95%;
        --foreground: 222 15% 10%;
        --muted: 222 8% 39%;
        --panel: 0 0% 100% / 0.42;
        --border: 0 0% 100% / 0.38;
        --highlight: 0 0% 100% / 0.2;
        --shadow: 222 32% 14% / 0.08;
        --track: 222 12% 45% / 0.16;
        --progress: 222 12% 34% / 0.5;
        --error: 0 64% 48%;
      }

      :root[data-theme="dark"] {
        color-scheme: dark;
        --background: 0 0% 4%;
        --foreground: 0 0% 90%;
        --muted: 0 0% 58%;
        --panel: 0 0% 100% / 0.072;
        --border: 0 0% 100% / 0.09;
        --highlight: 0 0% 100% / 0.03;
        --shadow: 0 0% 0% / 0.14;
        --track: 0 0% 100% / 0.09;
        --progress: 0 0% 72% / 0.52;
        --error: 0 72% 68%;
      }

      * { box-sizing: border-box; }

      html, body {
        width: 100%;
        min-width: 960px;
        height: 100%;
        min-height: 640px;
        margin: 0;
        overflow: hidden;
        background: transparent;
        color: hsl(var(--foreground));
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      body {
        display: grid;
        place-items: center;
        padding: 24px;
        background: linear-gradient(180deg, hsl(var(--background) / 0.62) 0%, hsl(var(--background) / 0.4) 100%);
        -webkit-app-region: drag;
      }

      main {
        display: grid;
        width: min(420px, calc(100vw - 48px));
        justify-items: center;
        gap: 20px;
        text-align: center;
      }

      .startup-icon {
        display: grid;
        width: 64px;
        height: 64px;
        place-items: center;
        border-radius: 10px;
        box-shadow: 0 8px 22px hsl(var(--shadow));
        object-fit: cover;
      }

      .startup-icon-fallback {
        border: 1px solid hsl(var(--border));
        background: hsl(var(--panel));
        font-size: 26px;
        font-weight: 700;
      }

      .startup-brand { display: grid; gap: 4px; }
      h1, p { margin: 0; }
      h1 { font-size: 18px; font-weight: 650; line-height: 28px; }
      .startup-tagline { color: hsl(var(--muted)); font-size: 13px; font-weight: 500; line-height: 20px; }

      .startup-card {
        display: grid;
        width: 100%;
        justify-items: center;
        gap: 16px;
        overflow: hidden;
        border: 1px solid hsl(var(--border));
        border-radius: 8px;
        padding: 20px;
        background: linear-gradient(180deg, hsl(var(--highlight)) 0%, transparent 54%), hsl(var(--panel));
        box-shadow: inset 0 1px 0 hsl(var(--highlight)), 0 6px 18px hsl(var(--shadow));
        -webkit-backdrop-filter: blur(24px) saturate(1.16);
        backdrop-filter: blur(24px) saturate(1.16);
      }

      .startup-status { display: grid; gap: 4px; }
      .startup-status-title { font-size: 14px; font-weight: 650; line-height: 20px; }
      .startup-status-description { color: hsl(var(--muted)); font-size: 12px; line-height: 20px; }

      .startup-spinner {
        width: 22px;
        height: 22px;
        border: 2px solid hsl(var(--muted) / 0.24);
        border-top-color: hsl(var(--muted));
        border-radius: 999px;
        animation: startup-spin 0.9s linear infinite;
      }

      .startup-progress {
        position: relative;
        width: min(240px, 100%);
        height: 4px;
        overflow: hidden;
        border-radius: 999px;
        background: hsl(var(--track));
      }

      .startup-progress span {
        position: absolute;
        inset: 0 auto 0 0;
        width: 42%;
        border-radius: inherit;
        background: hsl(var(--progress));
        animation: startup-progress 1.2s ease-in-out infinite;
      }

      .startup-error-mark {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 1px solid hsl(var(--error) / 0.32);
        border-radius: 999px;
        color: hsl(var(--error));
        font-size: 15px;
        font-weight: 700;
      }

      @keyframes startup-spin { to { transform: rotate(360deg); } }
      @keyframes startup-progress {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(240%); }
      }

      @media (prefers-reduced-motion: reduce) {
        .startup-spinner, .startup-progress span { animation: none; }
        .startup-progress span { width: 100%; opacity: 0.48; transform: none; }
      }

      @media (max-width: 1040px) {
        html, body { min-width: 0; }
      }
    </style>
  </head>
  <body>
    <main role="${isFailed ? "alert" : "status"}" aria-live="polite" aria-busy="${String(!isFailed)}">
      ${icon}
      <div class="startup-brand">
        <h1>Rion Studio</h1>
        <p class="startup-tagline">Browser roles, ready when you are.</p>
      </div>
      <section class="startup-card">
        ${indicator}
        <div class="startup-status">
          <p class="startup-status-title">${statusTitle}</p>
          <p class="startup-status-description">${statusDescription}</p>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function createStartupPageUrl(options: StartupPageOptions): string {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(buildStartupPage(options))}`;
}

export function loadRendererPage(
  window: RendererLoadingWindow,
  rendererUrl: string | undefined,
  rendererHtmlPath: string
): Promise<void> {
  if (rendererUrl) {
    return window.loadURL(rendererUrl);
  }

  return window.loadFile(rendererHtmlPath);
}

export async function loadWindowAndReveal(
  window: RevealableWindow,
  load: () => Promise<void>
): Promise<boolean> {
  if (window.isDestroyed()) {
    return false;
  }

  let finishReady: (ready: boolean) => void = () => undefined;
  let loadError: unknown;
  const readyPromise = new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      window.removeListener("ready-to-show", onReady);
      window.removeListener("closed", onClosed);
    };
    const finish = (ready: boolean): void => {
      cleanup();
      resolve(ready);
    };
    const onReady = (): void => finish(true);
    const onClosed = (): void => finish(false);

    finishReady = finish;
    window.once("ready-to-show", onReady);
    window.once("closed", onClosed);
  });
  const loadPromise = load().catch((error: unknown) => {
    loadError = error;
    finishReady(false);
  });
  const ready = await readyPromise;

  if (ready && !window.isDestroyed()) {
    window.show();
    window.focus();
  }

  await loadPromise;

  if (loadError && !window.isDestroyed()) {
    throw loadError;
  }

  return ready && !window.isDestroyed();
}

export function showStartupWindow(window: RevealableWindow, options: StartupPageOptions): Promise<boolean> {
  return loadWindowAndReveal(window, () => window.loadURL(createStartupPageUrl(options)));
}

async function safelyShowFailure(options: StartupSequenceOptions): Promise<void> {
  if (!options.isWindowAvailable()) {
    return;
  }

  try {
    await options.showFailure();
  } catch (error) {
    options.onError("startup", error);
  }
}

export async function runStartupSequence(options: StartupSequenceOptions): Promise<StartupSequenceResult> {
  let startupShown = false;

  try {
    startupShown = await options.showStartup();
  } catch (error) {
    options.onError("startup", error);
  }

  try {
    await options.initialize();
  } catch (error) {
    options.onError("initialize", error);
    await safelyShowFailure(options);
    return "failed";
  }

  if (!options.isWindowAvailable()) {
    return "closed";
  }

  try {
    await options.loadRenderer({ revealWhenReady: !startupShown });
    return "ready";
  } catch (error) {
    options.onError("renderer", error);
    await safelyShowFailure(options);
    return "failed";
  }
}
