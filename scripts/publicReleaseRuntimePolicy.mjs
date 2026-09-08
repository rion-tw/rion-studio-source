import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const MACOS_UPDATER_ARCHIVE = "Rion.Studio-mac.app.tar.gz";
const REQUIRED_TAURI_ARCHIVE_ENTRY = "Rion Studio.app/Contents/Info.plist";
const REQUIRED_TAURI_EXECUTABLE_ENTRY =
  "Rion Studio.app/Contents/MacOS/rion-tauri";
const MACOS_EXECUTABLE_DIRECTORY = "Rion Studio.app/Contents/MacOS/";
const ELECTRON_ARCHIVE_MARKERS = Object.freeze([
  "/Contents/Frameworks/Electron Framework.framework",
  "/Contents/Resources/app.asar"
]);
const ELECTRON_CANDIDATE_RECEIPTS = Object.freeze([
  "electron-production-candidate-receipt.json",
  "platform-receipt.json"
]);

const ELECTRON_REQUIRED_FILES = Object.freeze([
  "Rion Studio.app/Contents/Info.plist",
  "Rion Studio.app/Contents/MacOS/Rion Studio",
  "Rion Studio.app/Contents/Resources/app.asar",
  "Rion Studio.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
]);

/** Identify a previously published source without treating its engine as a target. */
export async function identifyPublicReleaseRuntime(directory) {
  const archivePath = join(directory, MACOS_UPDATER_ARCHIVE);
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size === 0) {
    throw new Error(`Expected a non-empty regular ${MACOS_UPDATER_ARCHIVE}.`);
  }
  const entries = await listArchiveEntries(archivePath);
  if (entries.some((entry) => ELECTRON_ARCHIVE_MARKERS.some((marker) => entry.includes(marker)))) {
    await assertElectronPublicReleaseAssets(directory);
    return "electron-v23";
  }
  await assertStableTauriV22PublicReleaseAssets(directory);
  return "tauri-v22";
}

/** Require the sole supported target; this is package shape, not publication evidence. */
export async function assertElectronPublicReleaseAssets(directory) {
  const archivePath = join(directory, MACOS_UPDATER_ARCHIVE);
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size === 0) {
    throw new Error(`Expected a non-empty regular ${MACOS_UPDATER_ARCHIVE}.`);
  }
  const entries = await listArchiveEntries(archivePath);
  if (entries.some((entry) => entry.includes("\\") || entry.split("/").includes("..")
    || !entry.startsWith("Rion Studio.app/"))) {
    throw new Error("Electron archive contains a path outside its application bundle.");
  }
  const executables = entries.filter((entry) => entry.startsWith(MACOS_EXECUTABLE_DIRECTORY)
    && entry.slice(MACOS_EXECUTABLE_DIRECTORY.length).length > 0
    && !entry.slice(MACOS_EXECUTABLE_DIRECTORY.length).includes("/"));
  if (executables.length !== 1 || executables[0] !== ELECTRON_REQUIRED_FILES[1]) {
    throw new Error("Electron archive must contain only the Rion Studio main executable.");
  }
  for (const requiredEntry of ELECTRON_REQUIRED_FILES) {
    if (entries.filter((entry) => entry === requiredEntry).length !== 1) {
      throw new Error(`Electron archive must contain exactly one ${requiredEntry}.`);
    }
    await assertRegularArchiveEntry(archivePath, requiredEntry);
  }
}

export async function assertStableTauriV22PublicReleaseAssets(directory) {
  const names = await readdir(directory);
  const receipts = ELECTRON_CANDIDATE_RECEIPTS.filter((name) => names.includes(name));
  if (receipts.length > 0) {
    throw new Error(
      `Electron candidate receipts are not public promotion receipts: ${receipts.join(", ")}`
    );
  }

  const archivePath = join(directory, MACOS_UPDATER_ARCHIVE);
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size === 0) {
    throw new Error(`Expected a non-empty regular ${MACOS_UPDATER_ARCHIVE}.`);
  }

  const entries = await listArchiveEntries(archivePath);
  const electronMarker = entries.find((entry) =>
    ELECTRON_ARCHIVE_MARKERS.some((marker) => entry.includes(marker))
  );
  if (electronMarker) {
    throw new Error(
      `Expected a legacy Tauri source archive, found Electron: ${electronMarker}`
    );
  }

  const topLevelExecutables = entries.filter((entry) => {
    if (!entry.startsWith(MACOS_EXECUTABLE_DIRECTORY)) return false;
    const relativeEntry = entry.slice(MACOS_EXECUTABLE_DIRECTORY.length);
    return relativeEntry.length > 0 && !relativeEntry.includes("/");
  });
  if (
    !entries.includes(REQUIRED_TAURI_ARCHIVE_ENTRY) ||
    topLevelExecutables.length !== 1 ||
    topLevelExecutables[0] !== REQUIRED_TAURI_EXECUTABLE_ENTRY
  ) {
    throw new Error(
      `The public release archive must contain only the stable Tauri v22 executable ${REQUIRED_TAURI_EXECUTABLE_ENTRY}.`
    );
  }
  await assertRegularArchiveEntry(archivePath, REQUIRED_TAURI_EXECUTABLE_ENTRY);
}

async function listArchiveEntries(archivePath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect ${MACOS_UPDATER_ARCHIVE}: ${reason}`, {
      cause: error
    });
  }

  return stdout
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^(?:\.\/)+/u, ""))
    .filter(Boolean);
}

async function assertRegularArchiveEntry(archivePath, requiredEntry) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("tar", ["-tvzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect ${MACOS_UPDATER_ARCHIVE} entry types: ${reason}`, {
      cause: error
    });
  }
  const entry = stdout.split(/\r?\n/u).find((line) =>
    line.endsWith(` ${requiredEntry}`) || line.includes(` ${requiredEntry} -> `)
  );
  if (!entry || entry[0] !== "-") {
    throw new Error(
      `The required payload must be a regular archive entry: ${requiredEntry}.`
    );
  }
}
