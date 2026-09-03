import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const ELECTRON_E2E_BUNDLE_SIGNATURES = Object.freeze([
  Object.freeze({
    bundle: "main",
    path: ["out", "main", "index.js"],
    signatures: ["rion:e2e:invoke", "retainedV22Precondition"]
  }),
  Object.freeze({
    bundle: "preload",
    path: ["out", "preload", "index.cjs"],
    signatures: ["rionStudioDesktopE2e", "retainedV22Precondition"]
  })
]);
const ELECTRON_PRELOAD_BUNDLES = Object.freeze([
  "index.cjs",
  "role.cjs",
  "runtimeWindowsHost.cjs",
  "workspaceWebChrome.cjs"
]);

export async function verifyDesktopE2eBuild({ driver, repositoryRoot }) {
  if (driver !== "electron") return;

  for (const expectation of ELECTRON_E2E_BUNDLE_SIGNATURES) {
    const bundlePath = resolve(repositoryRoot, ...expectation.path);
    let source;
    try {
      source = await readFile(bundlePath, "utf8");
    } catch (error) {
      throw new Error(
        `Electron desktop E2E ${expectation.bundle} bundle is unavailable at ${bundlePath}. ` +
        "Run the desktop E2E command without RION_STUDIO_E2E_SKIP_BUILD=1.",
        { cause: error }
      );
    }
    const missing = expectation.signatures.filter((signature) =>
      !source.includes(signature)
    );
    if (missing.length > 0) {
      throw new Error(
        `Electron desktop E2E ${expectation.bundle} bundle is not an E2E build ` +
        `(missing ${missing.join(", ")}). Run the desktop E2E command without ` +
        "RION_STUDIO_E2E_SKIP_BUILD=1."
      );
    }
  }
  const preloadRoot = resolve(repositoryRoot, "out", "preload");
  const entries = await readdir(preloadRoot, { withFileTypes: true });
  const chunkDirectory = entries.find((entry) =>
    entry.isDirectory() && entry.name === "chunks"
  );
  if (chunkDirectory) {
    throw new Error("Electron desktop E2E preload bundles are not self-contained.");
  }
  for (const bundle of ELECTRON_PRELOAD_BUNDLES) {
    const bundlePath = resolve(preloadRoot, bundle);
    const source = await readFile(bundlePath, "utf8");
    if (/\b(?:import|require)\s*\(\s*["']\.\.?\//u.test(source)) {
      throw new Error(
        `Electron desktop E2E preload bundle ${bundle} is not self-contained.`
      );
    }
  }
}
