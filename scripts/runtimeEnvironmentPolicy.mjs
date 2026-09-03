const PACKAGED_RUNTIME_EXACT_DENYLIST = new Set([
  "RION_STUDIO_DESKTOP_E2E_BUILD",
  "RION_STUDIO_ELECTRON_PACKAGE_VERSION",
  "RION_STUDIO_USER_DATA_DIR"
]);

const PACKAGED_RUNTIME_DENIED_PREFIXES = Object.freeze([
  "RION_STUDIO_E2E_",
  "RION_STUDIO_UPDATER_",
  "RION_UPDATER_",
  "RION_WINDOWS_ISOLATED_PROFILE_"
]);

const UPDATER_PRIVATE_ENVIRONMENT_PREFIXES = Object.freeze([
  "TAURI_SIGNING_",
  "RION_STUDIO_UPDATER_PRIVATE_"
]);

const UPDATER_PROBE_RUNTIME_ENVIRONMENT_NAMES = new Set([
  "APPDATA",
  "AR",
  "CARGO_HOME",
  "CARGO_TARGET_DIR",
  "CC",
  "CFFIXED_USER_HOME",
  "CI",
  "COMSPEC",
  "CXX",
  "DEVELOPER_DIR",
  "GITHUB_ACTIONS",
  "HOME",
  "INCLUDE",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LIB",
  "LIBCLANG_PATH",
  "LIBPATH",
  "LOCALAPPDATA",
  "MACOSX_DEPLOYMENT_TARGET",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "RANLIB",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SDKROOT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "UCRTVERSION",
  "UNIVERSALCRTSDKDIR",
  "USERPROFILE",
  "VCINSTALLDIR",
  "VCTOOLSINSTALLDIR",
  "VSINSTALLDIR",
  "WINDIR",
  "WINDOWSSDKDIR",
  "WINDOWSSDKVERSION"
]);
const UPDATER_PROBE_RUNTIME_OVERRIDE_NAMES = new Set([
  "RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER",
  "RION_UPDATER_PREVIOUS_TAURI_V22_VERSION",
  "RION_UPDATER_PREVIOUS_V23_INSTALLER",
  "RION_UPDATER_PREVIOUS_V23_VERSION"
]);

export function isUpdaterPrivateEnvironmentName(name) {
  const normalized = String(name).toUpperCase();
  return UPDATER_PRIVATE_ENVIRONMENT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix));
}

export function sanitizeUpdaterRuntimeEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (isUpdaterPrivateEnvironmentName(name)) {
      delete sanitized[name];
    }
  }
  return sanitized;
}

export function createUpdaterProbeRuntimeEnvironment(
  environment,
  overrides = {}
) {
  const runtimeEnvironment = {};
  const selectedNames = new Set();
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    const normalizedName = name.toUpperCase();
    if (!UPDATER_PROBE_RUNTIME_ENVIRONMENT_NAMES.has(normalizedName)) continue;
    if (selectedNames.has(normalizedName)) {
      throw new Error(
        `The updater probe runtime environment contains duplicate ${normalizedName} entries.`
      );
    }
    selectedNames.add(normalizedName);
    runtimeEnvironment[name] = value;
  }
  const overrideNames = new Set();
  for (const [name, value] of Object.entries(overrides)) {
    const normalizedName = name.toUpperCase();
    if (
      typeof value !== "string" ||
      (
        !normalizedName.startsWith("RION_UPDATER_PROBE_") &&
        !UPDATER_PROBE_RUNTIME_OVERRIDE_NAMES.has(normalizedName)
      ) ||
      isUpdaterPrivateEnvironmentName(normalizedName)
    ) {
      throw new Error(`Unsupported updater probe runtime override: ${name}.`);
    }
    if (overrideNames.has(normalizedName)) {
      throw new Error(
        `The updater probe runtime overrides contain duplicate ${normalizedName} entries.`
      );
    }
    overrideNames.add(normalizedName);
    runtimeEnvironment[normalizedName] = value;
  }
  return runtimeEnvironment;
}

export function createPackagedElectronRuntimeEnvironment(
  environment,
  overrides = {}
) {
  const sanitized = sanitizeUpdaterRuntimeEnvironment({
    ...environment,
    ...overrides
  });
  for (const name of Object.keys(sanitized)) {
    if (
      PACKAGED_RUNTIME_EXACT_DENYLIST.has(name) ||
      PACKAGED_RUNTIME_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      delete sanitized[name];
    }
  }
  return sanitized;
}
