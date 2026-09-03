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
      `Electron release assets require a separate owner-approved promotion workflow: ${electronMarker}`
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
      `The stable Tauri v22 executable must be a regular archive entry: ${requiredEntry}.`
    );
  }
}
