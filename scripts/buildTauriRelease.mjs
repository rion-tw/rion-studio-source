import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const publicKey = process.env.RION_STUDIO_UPDATER_PUBLIC_KEY?.trim();
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();

if (!publicKey) {
  throw new Error("RION_STUDIO_UPDATER_PUBLIC_KEY is required for a signed Tauri release.");
}
if (!privateKey) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY is required for a signed Tauri release.");
}

const platformBundle = {};
if (process.platform === "darwin") {
  const signingIdentity = requiredEnvironment("APPLE_SIGNING_IDENTITY");
  const hasAppleIdCredentials = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]
    .every((name) => Boolean(process.env[name]?.trim()));
  const hasApiCredentials = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"]
    .every((name) => Boolean(process.env[name]?.trim()));
  if (!hasAppleIdCredentials && !hasApiCredentials) {
    throw new Error(
      "A complete Apple ID or App Store Connect API credential set is required for notarization."
    );
  }
  platformBundle.macOS = { signingIdentity };
}
else if (process.platform === "win32") {
  const certificateThumbprint = requiredEnvironment(
    "RION_STUDIO_WINDOWS_CERTIFICATE_THUMBPRINT"
  );
  const timestampUrl = new URL(requiredEnvironment("RION_STUDIO_WINDOWS_TIMESTAMP_URL"));
  if (timestampUrl.protocol !== "https:") {
    throw new Error("RION_STUDIO_WINDOWS_TIMESTAMP_URL must use HTTPS.");
  }
  platformBundle.windows = {
    certificateThumbprint,
    digestAlgorithm: "sha256",
    timestampUrl: timestampUrl.href
  };
} else {
  throw new Error("Signed Tauri releases are supported only on macOS and Windows builders.");
}

const endpoint = process.env.RION_STUDIO_UPDATER_ENDPOINT?.trim()
  || "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const endpointUrl = new URL(endpoint);
if (endpointUrl.protocol !== "https:") {
  throw new Error("RION_STUDIO_UPDATER_ENDPOINT must use HTTPS.");
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  throw new Error("package.json must contain a valid semantic version for the Tauri release.");
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "rion-tauri-release-"));
const configPath = path.join(temporaryDirectory, "tauri.release.json");
writeFileSync(configPath, JSON.stringify({
  version: packageJson.version,
  bundle: {
    createUpdaterArtifacts: true,
    ...platformBundle
  },
  plugins: {
    updater: {
      endpoints: [endpoint],
      pubkey: publicKey,
      windows: {
        installMode: "passive"
      }
    }
  }
}));

try {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    command,
    ["exec", "tauri", "build", "--config", configPath, ...process.argv.slice(2)],
    {
      env: process.env,
      stdio: "inherit"
    }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a signed Tauri release.`);
  return value;
}
