import type { App, Event, Input, WebContents } from "electron";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ChromiumRoleSurfaceNativeAttachmentInput } from
  "../main/chromiumRoleSurfacePorts";

const ROLE_SESSION_PATTERN = /(?:^|\/)roles\/([^/]+)\/browser\/chromium$/u;

interface RoleSurfaceLifecycleObservation {
  readonly capturedAt: string;
  readonly destroyed: boolean;
  readonly details?: Readonly<Record<string, boolean | number | string>>;
  readonly isLoading: boolean;
  readonly isLoadingMainFrame: boolean;
  readonly roleId?: string;
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

function isObservedApplicationShortcut(input: Input): boolean {
  if (input.code === "F11" || input.key === "F11") return true;
  if ((!input.control && !input.meta) || input.alt) return false;
  return [
    "Digit0", "Equal", "KeyK", "Minus", "Numpad0", "NumpadAdd",
    "NumpadSubtract"
  ].includes(input.code) || ["+", "-", "0", "=", "k"].includes(
    input.key.toLowerCase()
  );
}

/** Records native WebContents events without changing the role-surface lifecycle. */
export function installElectronDesktopE2eRoleSurfaceLifecycleObserver(
  app: App,
  artifactDirectory: string | undefined
): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const roleObservations: RoleSurfaceLifecycleObservation[] = [];
  const chromeObservations: RoleSurfaceLifecycleObservation[] = [];
  let nextSequence = 1;
  app.on("web-contents-created", (_event, contents) => {
    const roleId = roleIdFor(contents);
    if (!roleId && contents.session.storagePath !== null) return;
    let localChrome = false;
    const observations = roleId ? roleObservations : chromeObservations;
    const outputPath = join(artifactDirectory, roleId
      ? "electron-role-surface-lifecycle-observations.json"
      : "electron-local-web-chrome-lifecycle-observations.json");
    const capture = (
      stage: string,
      details?: Readonly<Record<string, boolean | number | string>>
    ): void => {
      if (!roleId && !localChrome) return;
      const destroyed = contents.isDestroyed();
      observations.push(Object.freeze({
        capturedAt: new Date().toISOString(),
        destroyed,
        ...(details === undefined ? {} : { details }),
        isLoading: destroyed ? false : contents.isLoading(),
        isLoadingMainFrame: destroyed ? false : contents.isLoadingMainFrame(),
        ...(roleId ? { roleId } : {}),
        sequence: nextSequence++,
        stage,
        url: destroyed ? "" : contents.getURL(),
        webContentsId: contents.id
      }));
      writeFileSync(outputPath, `${JSON.stringify(observations, null, 2)}\n`);
    };
    if (!roleId) {
      const originalLoadURL = contents.loadURL;
      contents.loadURL = function (url, options) {
        if (!localChrome && /^file:\/\/.*\/runtime-(?:web-chrome|role-placeholder)-electron\.html$/u.test(url)) {
          localChrome = true;
          capture("local-chrome-identified", { type: contents.getType() });
        }
        if (!localChrome) return originalLoadURL.call(this, url, options);
        capture("load-url-entered", { url });
        const completion = originalLoadURL.call(this, url, options);
        void completion.then(
          () => capture("load-url-resolved", { url }),
          (error: unknown) => capture("load-url-rejected", {
            url, error: error instanceof Error ? error.message : String(error)
          })
        );
        return completion;
      };
    }
    const originalClose = contents.close;
    contents.close = function (options) {
      capture("close-entered", {
        waitForBeforeUnload: options?.waitForBeforeUnload ?? false
      });
      try {
        const result = originalClose.call(this, options);
        capture("close-returned");
        return result;
      } catch (error) {
        capture("close-threw", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    };
    capture("created", { type: contents.getType() });
    contents.on("before-input-event", (inputEvent: Event, input: Input) => {
      if (!isObservedApplicationShortcut(input)) return;
      const details = Object.freeze({
        alt: input.alt,
        code: input.code,
        control: input.control,
        isAutoRepeat: input.isAutoRepeat,
        key: input.key,
        meta: input.meta,
        shift: input.shift,
        type: input.type
      });
      // Observe after every synchronous product listener has had the chance to
      // claim the same native event; this microtask records but never owns it.
      queueMicrotask(() => capture("before-input-event", {
        ...details,
        defaultPrevented: inputEvent.defaultPrevented
      }));
    });
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

interface NativeAttachmentPrototype {
  attach: (input: ChromiumRoleSurfaceNativeAttachmentInput) => Promise<void>;
}

interface NativeAttachmentObservation {
  readonly capturedAt: string;
  readonly details?: string;
  readonly generation: number;
  readonly parentId: number;
  readonly roleId: string;
  readonly sequence: number;
  readonly stage: "attach-entered" | "attach-returned" | "attach-resolved" |
    "attach-rejected" | "attach-threw";
  readonly webContentsId: number | null;
}

/** Records the Windows native-attachment Promise boundary without changing it. */
export function installElectronDesktopE2eNativeAttachmentLifecycleObserver(
  prototype: NativeAttachmentPrototype,
  artifactDirectory: string | undefined
): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const observations: NativeAttachmentObservation[] = [];
  const outputPath = join(
    artifactDirectory,
    "electron-windows-role-attachment-observations.json"
  );
  const originalAttach = prototype.attach;
  let nextSequence = 1;
  const capture = (
    input: ChromiumRoleSurfaceNativeAttachmentInput,
    stage: NativeAttachmentObservation["stage"],
    details?: string
  ): void => {
    observations.push(Object.freeze({
      capturedAt: new Date().toISOString(),
      ...(details === undefined ? {} : { details }),
      generation: input.generation,
      parentId: input.parent.id,
      roleId: input.roleId,
      sequence: nextSequence++,
      stage,
      webContentsId: input.view?.webContents.id ?? null
    }));
    writeFileSync(outputPath, `${JSON.stringify(observations, null, 2)}\n`);
  };
  prototype.attach = function (
    this: NativeAttachmentPrototype,
    input: ChromiumRoleSurfaceNativeAttachmentInput
  ): Promise<void> {
    capture(input, "attach-entered");
    let completion: Promise<void>;
    try {
      completion = originalAttach.call(this, input);
      capture(input, "attach-returned");
    } catch (error) {
      capture(input, "attach-threw", error instanceof Error ? error.message : String(error));
      throw error;
    }
    return completion.then(
      () => capture(input, "attach-resolved"),
      (error: unknown) => {
        capture(
          input,
          "attach-rejected",
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    );
  };
}
