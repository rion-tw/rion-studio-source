import { basename, dirname, resolve } from "node:path";
import process from "node:process";

import { removeMacosGameModePrivateRoot } from
  "./electronMacosGameModeBundle.mjs";

const [privateRoot, temporaryDirectory] = process.argv.slice(2);
if (
  !privateRoot || !temporaryDirectory ||
  resolve(privateRoot) !== privateRoot ||
  resolve(temporaryDirectory) !== temporaryDirectory ||
  dirname(privateRoot) !== temporaryDirectory ||
  !basename(privateRoot).startsWith("rion-electron-game-mode-") ||
  typeof process.send !== "function"
) {
  throw new Error("The macOS Game Mode cleanup guardian received invalid arguments.");
}

let cleaning = false;
const cleanAndExit = () => {
  if (cleaning) return;
  cleaning = true;
  try {
    removeMacosGameModePrivateRoot(privateRoot, temporaryDirectory);
  } finally {
    if (process.connected) process.disconnect();
  }
};

process.once("disconnect", cleanAndExit);
process.send("ready");
