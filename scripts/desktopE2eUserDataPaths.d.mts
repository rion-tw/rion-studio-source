export interface DesktopE2eUserDataLayout {
  readonly compactWindowsLayout: boolean;
  readonly userDataRoot: string;
}

export function resolveDesktopE2eUserDataLayout(input: {
  readonly artifactBase: string;
  readonly artifactRoot: string;
  readonly configuredRoot: string | undefined;
  readonly platform: string;
  readonly runId: string;
}): DesktopE2eUserDataLayout;

export function desktopE2eUserDataDir(
  layout: DesktopE2eUserDataLayout,
  namespace: string
): string;
