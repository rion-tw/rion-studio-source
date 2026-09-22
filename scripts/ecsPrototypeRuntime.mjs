/** Isolated prototype only. These archive hashes come from the pinned ECS release. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ECS_PROTOTYPE_DIST = fileURLToPath(new URL("../.electron-cache/ecs-prototype/dist/", import.meta.url));
export function ecsPrototypeExecutable(platform = process.platform) {
  if (platform === "darwin") return join(ECS_PROTOTYPE_DIST, "Electron.app", "Contents", "MacOS", "Electron");
  if (platform === "win32") return join(ECS_PROTOTYPE_DIST, "electron.exe");
  throw new Error(`Unsupported ECS prototype platform: ${platform}`);
}

export const ECS_PROTOTYPE = Object.freeze({
  dependency: "github:castlabs/electron-releases#v44.1.0+wvcus",
  version: "44.1.0+wvcus",
  commit: "bbb3862120430db6fa3ffa1ce22c3b66fe99e0b8",
  mirror: "https://github.com/castlabs/electron-releases/releases/download/",
  hashes: Object.freeze({
    "darwin-arm64": "07e9384402bc528502350e95f021c73d1629d9b01b46a0952af485c9cf7b45bd",
    "win32-x64": "1eb1ce84dfe387052123578a595578bd48a489bb6d1278f1c45ef8f0ceea5f36"
  })
});
