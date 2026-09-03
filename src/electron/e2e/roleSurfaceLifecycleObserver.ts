import type { App, WebContents } from "electron";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const ROLE_SESSION_PATTERN = /(?:^|\/)roles\/([^/]+)\/browser\/chromium$/u;

interface RoleSurfaceLifecycleObservation {
  readonly destroyed: boolean;
  readonly details?: Readonly<Record<string, boolean | number | string>>;
  readonly isLoading: boolean;
  readonly isLoadingMainFrame: boolean;
  readonly roleId: string;
  readonly sequence: number;
  readonly stage: string;
  readonly url: string;
  readonly webContentsId: number;
}

function roleIdFor(contents: WebContents): string | null {
  const storagePath = contents.session.storagePath;
  if (typeof storagePath !== "string") return null;
  return ROLE_SESSION_PATTERN.exec(storagePath.replaceAll("\\", "/"))?.[1] ?? null;
}

/** Records native WebContents events without changing the role-surface lifecycle. */
export function installElectronDesktopE2eRoleSurfaceLifecycleObserver(
  app: App,
  artifactDirectory: string | undefined
): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const observations: RoleSurfaceLifecycleObservation[] = [];
  const outputPath = join(
    artifactDirectory,
    "electron-role-surface-lifecycle-observations.json"
  );
  let nextSequence = 1;
  app.on("web-contents-created", (_event, contents) => {
    const roleId = roleIdFor(contents);
    if (!roleId) return;
    const capture = (
      stage: string,
      details?: Readonly<Record<string, boolean | number | string>>
    ): void => {
      const destroyed = contents.isDestroyed();
      observations.push(Object.freeze({
        destroyed,
        ...(details === undefined ? {} : { details }),
        isLoading: destroyed ? false : contents.isLoading(),
        isLoadingMainFrame: destroyed ? false : contents.isLoadingMainFrame(),
        roleId,
        sequence: nextSequence++,
        stage,
        url: destroyed ? "" : contents.getURL(),
        webContentsId: contents.id
      }));
      writeFileSync(outputPath, `${JSON.stringify(observations, null, 2)}\n`);
    };
    capture("created", { type: contents.getType() });
    contents.on(
      "did-start-navigation",
      (_navigationEvent, url, isSameDocument, isMainFrame) => capture(
        "did-start-navigation",
        { isMainFrame, isSameDocument, url }
      )
    );
    contents.on("did-start-loading", () => capture("did-start-loading"));
    contents.on("dom-ready", () => capture("dom-ready"));
    contents.on("did-finish-load", () => capture("did-finish-load"));
    contents.on(
      "did-fail-load",
      (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) =>
        capture("did-fail-load", {
          errorCode,
          errorDescription,
          isMainFrame,
          validatedURL
        })
    );
    contents.on(
      "did-fail-provisional-load",
      (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) =>
        capture("did-fail-provisional-load", {
          errorCode,
          errorDescription,
          isMainFrame,
          validatedURL
        })
    );
    contents.on("did-stop-loading", () => capture("did-stop-loading"));
    contents.on("render-process-gone", (_goneEvent, details) => capture(
      "render-process-gone",
      { exitCode: details.exitCode, reason: details.reason }
    ));
    contents.on("unresponsive", () => capture("unresponsive"));
    contents.on("responsive", () => capture("responsive"));
    contents.on("destroyed", () => capture("destroyed"));
  });
}
