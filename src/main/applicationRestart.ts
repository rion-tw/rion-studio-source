export interface RelaunchableApplication {
  exit(exitCode?: number): void;
  relaunch(): void;
}

export const DEVELOPMENT_RESTART_ERROR =
  "Rion Studio cannot restart itself while the renderer development server is running. Stop and rerun `pnpm run dev` to apply the graphics settings.";

export function restartApplication(
  application: RelaunchableApplication,
  rendererDevelopmentUrl: string | undefined
): void {
  if (rendererDevelopmentUrl) {
    throw new Error(DEVELOPMENT_RESTART_ERROR);
  }

  application.relaunch();
  application.exit(0);
}
