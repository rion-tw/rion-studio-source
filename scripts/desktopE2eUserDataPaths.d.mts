export interface DesktopE2eUserDataLayout {
  readonly compactWindowsLayout: boolean;
  readonly userDataRoot: string;
  /** Set when the checkout is too deep to leave Chromium room under MAX_PATH. */
  readonly outsideArtifactBase: boolean;
}

export function resolveDesktopE2eUserDataLayout(input: {
  readonly artifactBase: string;
  readonly artifactRoot: string;
  readonly configuredRoot: string | undefined;
  readonly platform: string;
  readonly runId: string;
  /** Defaults to the OS temporary directory. */
  readonly temporaryBase?: string;
}): DesktopE2eUserDataLayout;

export function desktopE2eUserDataDir(
  layout: DesktopE2eUserDataLayout,
  namespace: string
): string;
