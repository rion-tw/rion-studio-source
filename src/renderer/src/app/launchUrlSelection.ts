export const CUSTOM_LAUNCH_URL_OPTION = "__custom__";

export function resolveLaunchUrlSelection(launchUrl: string, presetUrls: readonly string[]): string {
  return presetUrls.includes(launchUrl) ? launchUrl : CUSTOM_LAUNCH_URL_OPTION;
}

export function resolveLaunchUrlFromSelection(selection: string): string {
  return selection === CUSTOM_LAUNCH_URL_OPTION ? "" : selection;
}
