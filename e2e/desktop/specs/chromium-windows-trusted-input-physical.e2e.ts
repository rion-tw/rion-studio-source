import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect } from "@wdio/globals";

// [journey:CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009]

const execFileAsync = promisify(execFile);
const PROBE_PREFIX = "RION_ELECTRON_WINDOWS_CHROMIUM_INPUT_PROBE=";

interface ProbeDomReceipt {
  readonly received: boolean;
  readonly value: readonly Readonly<{
    readonly isTrusted: boolean;
    readonly matches: boolean;
  }>[];
}

interface WindowsInputProbeEvidence {
  readonly candidateEvidence: "foreground-and-hidden-product-path";
  readonly platform: "win32";
  readonly singleWebContentsSurface: boolean;
  readonly displayScaleFactor: number;
  readonly foregroundProbe: Readonly<{
    readonly childWindowStyle: boolean;
    readonly dpi: number;
    readonly exactParent: boolean;
    readonly noActivateStyle: boolean;
    readonly parentWasForeground: boolean;
    readonly popupWindowStyleAbsent: boolean;
    readonly targetHadThreadFocus: boolean;
    readonly targetWasForeground: boolean;
  }>;
  readonly controlProbe: Readonly<{
    readonly exactParent: boolean;
    readonly parentVisible: boolean;
    readonly parentWasForeground: boolean;
    readonly surfaceVisible: boolean;
  }>;
  readonly finalProbe: Readonly<{
    readonly foregroundWindowPreserved: boolean;
    readonly activeWindowPreserved: boolean;
    readonly focusWindowPreserved: boolean;
    readonly parentVisible: boolean;
    readonly parentWasForeground: boolean;
    readonly surfaceVisible: boolean;
    readonly targetHadThreadFocus: boolean;
    readonly targetWasForeground: boolean;
  }>;
  readonly keyDom: ProbeDomReceipt;
  readonly mouseDom: ProbeDomReceipt;
  readonly hiddenProbe: Readonly<{
    readonly parentVisible: boolean;
    readonly parentWasForeground: boolean;
    readonly surfaceVisible: boolean;
    readonly targetHadThreadFocus: boolean;
    readonly targetWasForeground: boolean;
  }>;
  readonly hiddenKeyDom: ProbeDomReceipt;
  readonly hiddenPresentationPreserved: boolean;
}

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
    ) as WindowsInputProbeEvidence;

    expect(evidence).toMatchObject({
      candidateEvidence: "foreground-and-hidden-product-path",
      platform: "win32",
      singleWebContentsSurface: true,
      controlProbe: {
        exactParent: true,
        parentVisible: true,
        parentWasForeground: true,
        surfaceVisible: true
      },
      foregroundProbe: {
        childWindowStyle: true,
        exactParent: true,
        noActivateStyle: true,
        parentWasForeground: true,
        popupWindowStyleAbsent: true,
        targetHadThreadFocus: false,
        targetWasForeground: false
      },
      finalProbe: {
        activeWindowPreserved: true,
        focusWindowPreserved: true,
        foregroundWindowPreserved: true,
        parentVisible: true,
        parentWasForeground: true,
        surfaceVisible: false,
        targetHadThreadFocus: false,
        targetWasForeground: false
      },
      hiddenProbe: {
        parentVisible: true,
        parentWasForeground: true,
        surfaceVisible: false,
        targetHadThreadFocus: false,
        targetWasForeground: false
      },
      hiddenPresentationPreserved: true
    });
    expect(evidence.foregroundProbe.dpi).toBe(
      Math.round(evidence.displayScaleFactor * 96)
    );
    for (const dom of [
      evidence.keyDom,
      evidence.mouseDom,
      evidence.hiddenKeyDom
    ]) {
      expect(dom.received).toBe(true);
      expect(dom.value.length).toBeGreaterThan(0);
      expect(dom.value.every((receipt) =>
        receipt.isTrusted && receipt.matches
      )).toBe(true);
    }
  });
});
