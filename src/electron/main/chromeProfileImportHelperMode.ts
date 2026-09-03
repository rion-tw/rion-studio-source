export const CHROME_PROFILE_IMPORT_HELPER_SWITCH =
  "--rion-internal-chrome-profile-helper" as const;

/**
 * Matches only the fixed native-launcher mode. Operation identity and payload
 * remain confined to the inherited request pipe.
 */
export function isChromeProfileImportHelperInvocation(
  argv: readonly string[]
): boolean {
  return argv.includes(CHROME_PROFILE_IMPORT_HELPER_SWITCH);
}
