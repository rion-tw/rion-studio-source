import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_MAIN_PATTERNS = Object.freeze([
  "crx-msg-remote",
  "runtime.connectNative",
  "runtime.sendNativeMessage",
  "websocket.connect",
  "websocket.close",
  "contextMenus.create",
  "downloads.download",
  "identity.launchWebAuthFlow",
  "management.uninstallSelf"
]);

export async function verifyElectronExtensionCompatibilityBundle(
  root = resolve(import.meta.dirname, "..")
) {
  const [main, preload] = await Promise.all([
    readFile(resolve(root, "out/main/index.js"), "utf8"),
    readFile(resolve(root, "out/preload/extensionCompat.cjs"), "utf8")
  ]);
  const violations = FORBIDDEN_MAIN_PATTERNS.filter((pattern) => main.includes(pattern));
  if (violations.length > 0) {
    throw new Error(
      `Forbidden extension compatibility code entered Electron main: ${violations.join(", ")}`
    );
  }
  for (const required of [
    "RION_EXTENSION_API_UNAVAILABLE",
    "compatibility.ready",
    "permissions.onRemoved",
    "webNavigation.onCompleted"
  ]) {
    if (!preload.includes(required)) {
      throw new Error(`Extension compatibility preload is missing ${required}.`);
    }
  }
  return Object.freeze({ mainBytes: main.length, preloadBytes: preload.length });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await verifyElectronExtensionCompatibilityBundle();
  console.log(
    `Verified audited extension compatibility bundle (${result.mainBytes} main bytes, ` +
    `${result.preloadBytes} preload bytes).`
  );
}
