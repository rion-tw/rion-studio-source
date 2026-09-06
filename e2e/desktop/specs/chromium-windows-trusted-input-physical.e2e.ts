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
  readonly ownerKind: "view";
  readonly exactSiblingViews: boolean;
  readonly displayScaleFactor: number;
  readonly foregroundProbe: ViewProbe;
  readonly controlProbe: ViewProbe;
  readonly hiddenProbe: ViewProbe;
  readonly finalProbe: ViewProbe;
  readonly focusReceipt: { status: string };
  readonly hiddenFocusReceipt: { status: string };
  readonly viewportAcknowledgement: { status: string; width: number; height: number };
  readonly keyDom: ProbeDomReceipt;
  readonly mouseDom: ProbeDomReceipt;
  readonly hiddenKeyDom: ProbeDomReceipt;
  readonly hiddenMouseDom: ProbeDomReceipt;
  readonly hiddenPresentationPreserved: boolean;
}

interface ViewProbe {
  readonly ownerKind: "view";
  readonly parentIdentity: string;
  readonly webContentsId: number;
  readonly observation: {
    readonly bounds: { width: number; height: number };
    readonly zoomFactor: number;
    readonly focusedWebContentsId: number | null;
    readonly focusIdentity: string;
  };
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
      candidateEvidence: "foreground-and-hidden-product-path", platform: "win32", ownerKind: "view",
      exactSiblingViews: true, hiddenPresentationPreserved: true,
      focusReceipt: { status: "applied" }, hiddenFocusReceipt: { status: "applied" },
      viewportAcknowledgement: { status: "applied" }
    });
    for (const [probe, visible] of [[evidence.foregroundProbe, true], [evidence.controlProbe, true],
      [evidence.hiddenProbe, false], [evidence.finalProbe, false]] as const) {
      expect(probe).toMatchObject({ ownerKind: "view", status: "verified", observation: {
        parentForeground: true, parentVisible: true, parentMinimized: false,
        viewAttached: true, viewVisible: visible, contentsDestroyed: false, contentsFocused: visible
      } });
      expect(probe.parentIdentity).toMatch(/^[0-9a-f]{64}$/u);
      expect(probe.parentIdentity).toBe(evidence.foregroundProbe.parentIdentity);
      expect(probe.observation.focusIdentity).toMatch(/^[0-9a-f]{64}$/u);
      expect(probe.observation.focusedWebContentsId).toBe(visible ? probe.webContentsId : evidence.controlProbe.webContentsId);
    }
    expect(evidence.foregroundProbe.webContentsId).not.toBe(evidence.controlProbe.webContentsId);
    expect(evidence.finalProbe.webContentsId).toBe(evidence.foregroundProbe.webContentsId);
    expect(evidence.finalProbe.observation.focusIdentity).toBe(evidence.hiddenProbe.observation.focusIdentity);
    expect(evidence.finalProbe.observation.zoomFactor).toBe(1.25);
    expect(evidence.viewportAcknowledgement.width).toBe(Math.round(evidence.finalProbe.observation.bounds.width / 1.25));
    expect(evidence.viewportAcknowledgement.height).toBe(Math.round(evidence.finalProbe.observation.bounds.height / 1.25));
    expect(evidence.displayScaleFactor).toBeGreaterThan(0);
    for (const dom of [
      evidence.keyDom,
      evidence.mouseDom,
      evidence.hiddenKeyDom,
      evidence.hiddenMouseDom
    ]) {
      expect(dom.received).toBe(true);
      expect(dom.value.length).toBeGreaterThan(0);
      expect(dom.value.every((receipt) =>
        receipt.isTrusted && receipt.matches
      )).toBe(true);
    }
  });
});
