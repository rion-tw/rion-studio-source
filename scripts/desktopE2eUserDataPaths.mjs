import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Windows refuses to create a path longer than MAX_PATH unless long paths are
// enabled machine-wide, and Chromium does not opt in. Nothing reports the
// overflow: Chromium creates every file that fits and silently fails on the
// rest, so a runtime profile rooted too deep loses chrome.storage for every
// extension — the settings store's LOCK and LOG files land, MANIFEST-000001
// does not, and LevelDB gives up with "Unable to create writable file".
const WINDOWS_MAX_PATH = 260;

// Longest path Chromium appends below the user-data root that has to be
// writable for a run to mean anything. The deepest such file is an extension's
// settings store:
//
//   <12-hex phase>\roles\<uuid>\browser\chromium\
//     Local Extension Settings\<32-char extension id>\MANIFEST-000001
//
// which measures 146 characters; the remainder is headroom for longer LevelDB
// manifest and log generations. Chromium's cache trees (Code Cache file names
// are two 64-character hashes) can still exceed this, but a lost cache entry is
// recoverable in a way that a lost extension store is not.
const WINDOWS_RESERVED_DESCENDANT_LENGTH = 160;

const WINDOWS_MAX_USER_DATA_ROOT =
  WINDOWS_MAX_PATH - WINDOWS_RESERVED_DESCENDANT_LENGTH;

function compactName(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function resolveDesktopE2eUserDataLayout({
  artifactBase,
  artifactRoot,
  configuredRoot,
  platform,
  runId,
  temporaryBase = tmpdir()
}) {
  const compactWindowsLayout = platform === "win32" && !configuredRoot;
  if (!compactWindowsLayout) {
    return Object.freeze({
      compactWindowsLayout,
      userDataRoot: resolve(configuredRoot ?? resolve(artifactRoot, "user-data")),
      outsideArtifactBase: false
    });
  }
  // Preferred: beside the run's other evidence, so a failed run's profiles are
  // preserved with the logs and screenshots that explain them.
  const preserved = resolve(artifactBase, `.u-${compactName(runId)}`);
  if (preserved.length <= WINDOWS_MAX_USER_DATA_ROOT) {
    return Object.freeze({
      compactWindowsLayout,
      userDataRoot: preserved,
      outsideArtifactBase: false
    });
  }
  // The checkout itself is too deep to leave room — a git worktree costs about
  // 45 characters over a plain clone, which is enough on its own. Nothing can be
  // shortened below this root (`roles/<uuid>/browser/chromium` is the product's
  // own layout and `Local Extension Settings` is Chromium's), so the only place
  // left to buy the characters back is the root itself.
  return Object.freeze({
    compactWindowsLayout,
    userDataRoot: resolve(temporaryBase, "rion-e2e", compactName(runId)),
    outsideArtifactBase: true
  });
}

export function desktopE2eUserDataDir(layout, namespace) {
  return resolve(
    layout.userDataRoot,
    layout.compactWindowsLayout ? compactName(namespace) : namespace
  );
}
