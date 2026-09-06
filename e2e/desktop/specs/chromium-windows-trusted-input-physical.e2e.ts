import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { validateWindowsPhysicalInputEvidence } from
  "../../../scripts/desktopE2eChromiumMacroCutoverEvidence.mjs";

// [journey:CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009]

const execFileAsync = promisify(execFile);
const PROBE_PREFIX = "RION_ELECTRON_WINDOWS_CHROMIUM_INPUT_PROBE=";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Windows native probe`);
  return value;
}

describe("Windows Chromium physical trusted-input candidate", () => {
  it("proves foreground and hidden sibling trusted DOM input", async () => {
    if (process.platform !== "win32") {
      throw new Error("The Windows physical input phase ran on a non-Windows host.");
    }
    const root = resolve(import.meta.dirname, "../../..");
    const electronBinary = createRequire(import.meta.url)("electron") as string;
    const addonPath = resolve(
      root,
      "build/native",
      `${process.platform}-${process.arch}`,
      "rion-core.node"
    );
    const artifactDir = required("RION_STUDIO_E2E_ARTIFACT_DIR");
    let output: Readonly<{ stdout: string; stderr: string }>;
    try {
      const result = await execFileAsync(
        electronBinary,
        [resolve(root, "scripts/electronWindowsChromiumTrustedInputProbe.cjs")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            RION_ELECTRON_ADDON_PATH: addonPath
          },
          // External native/renderer liveness bound for this diagnostic phase.
          timeout: 120_000
        }
      );
      output = { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      const stdout = failure.stdout ?? "";
      const stderr = failure.stderr ?? failure.stack ?? String(error);
      await writeFile(
        resolve(artifactDir, "windows-input-physical-probe.log"),
        `${stdout}${stderr}`
      );
      throw error;
    }
    const { stdout, stderr } = output;
    await writeFile(
      resolve(artifactDir, "windows-input-physical-probe.log"),
      `${stdout}${stderr}`
    );
    const evidenceLine = stdout.split(/\r?\n/u).find((line) =>
      line.startsWith(PROBE_PREFIX)
    );
    if (!evidenceLine) throw new Error("The Windows input probe emitted no evidence.");
    const evidence = JSON.parse(
      evidenceLine.slice(PROBE_PREFIX.length)
    );

    validateWindowsPhysicalInputEvidence(evidence);
  });
});
