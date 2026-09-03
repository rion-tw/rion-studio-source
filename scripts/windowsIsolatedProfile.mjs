import { win32 } from "node:path";

const ISOLATION_KIND = "temporary-local-windows-user-profile-v1";
const PRODUCT_NAME = "Rion Studio";

export function resolveVerifiedWindowsProfileIsolation(environment) {
  if (environment.RION_WINDOWS_ISOLATED_PROFILE_KIND !== ISOLATION_KIND) {
    throw new Error(
      "Windows packaged gates require the verified temporary-user profile runner."
    );
  }
  const sid = requiredValue(environment.RION_WINDOWS_ISOLATED_PROFILE_SID, "SID");
  const parentSid = requiredValue(
    environment.RION_WINDOWS_ISOLATED_PROFILE_PARENT_SID,
    "parent SID"
  );
  if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(sid) || sid === parentSid) {
    throw new Error("Windows packaged gates require a distinct temporary local user SID.");
  }

  const profileDirectory = requiredCanonicalAbsolutePath(
    environment.RION_WINDOWS_ISOLATED_PROFILE_ROOT,
    "profile root"
  );
  const roamingAppDataDirectory = requiredCanonicalAbsolutePath(
    environment.RION_WINDOWS_ISOLATED_PROFILE_ROAMING_APP_DATA,
    "Roaming AppData"
  );
  const localAppDataDirectory = requiredCanonicalAbsolutePath(
    environment.RION_WINDOWS_ISOLATED_PROFILE_LOCAL_APP_DATA,
    "Local AppData"
  );
  const userProgramFilesDirectory = requiredCanonicalAbsolutePath(
    environment.RION_WINDOWS_ISOLATED_PROFILE_USER_PROGRAM_FILES,
    "UserProgramFiles"
  );
  assertSamePath(
    roamingAppDataDirectory,
    win32.join(profileDirectory, "AppData", "Roaming"),
    "Roaming AppData"
  );
  assertSamePath(
    localAppDataDirectory,
    win32.join(profileDirectory, "AppData", "Local"),
    "Local AppData"
  );
  assertSamePath(
    userProgramFilesDirectory,
    win32.join(localAppDataDirectory, "Programs"),
    "UserProgramFiles"
  );
  assertSamePath(environment.USERPROFILE, profileDirectory, "USERPROFILE");
  assertSamePath(environment.APPDATA, roamingAppDataDirectory, "APPDATA");
  assertSamePath(environment.LOCALAPPDATA, localAppDataDirectory, "LOCALAPPDATA");

  return Object.freeze({
    kind: ISOLATION_KIND,
    localAppDataDirectory,
    profileDirectory,
    roamingAppDataDirectory,
    sid,
    userDataDirectory: win32.join(roamingAppDataDirectory, PRODUCT_NAME),
    userProgramFilesDirectory
  });
}

function requiredCanonicalAbsolutePath(value, name) {
  const path = requiredValue(value, name);
  if (!win32.isAbsolute(path) || win32.normalize(path) !== path) {
    throw new Error(`The isolated Windows ${name} must be canonical and absolute.`);
  }
  const root = win32.parse(path).root;
  if (!root || path.toLowerCase() === root.toLowerCase()) {
    throw new Error(`The isolated Windows ${name} must not be a drive root.`);
  }
  return path;
}

function requiredValue(value, name) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`The isolated Windows ${name} is required.`);
  }
  return value;
}

function assertSamePath(actual, expected, name) {
  if (
    typeof actual !== "string" ||
    win32.normalize(actual).toLowerCase() !== win32.normalize(expected).toLowerCase()
  ) {
    throw new Error(`The isolated Windows ${name} did not match the loaded profile.`);
  }
}
