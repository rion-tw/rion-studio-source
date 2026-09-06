import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Windows Chromium physical input candidate gate", () => {
  it("uses exact public Electron ownership plus read-only Win32 proof", async () => {
    const [probe, preload, submission, parentBinding, loader] = await Promise.all([
      readFile("scripts/electronWindowsChromiumTrustedInputProbe.cjs", "utf8"),
      readFile("scripts/electronWindowsChromiumTrustedInputProbePreload.cjs", "utf8"),
      readFile("src/electron/main/chromiumViewInputSubmission.ts", "utf8"),
      readFile("src/electron/main/windowsChromiumViewParentBinding.ts", "utf8"),
      readFile("scripts/electronLoadChromiumInputOwner.cjs", "utf8")
    ]);
    expect(probe.match(/new BrowserWindow\(/gu)).toHaveLength(1);
    for (const owner of ["ChromiumViewAttachmentCoordinator", "ChromiumViewTrustedInputHost", "ChromiumViewFocusAdmission", "windowsChromiumViewParentBinding"]) {
      expect(probe).toContain(owner);
    }
    expect(probe).toContain('require("./electronLoadChromiumInputOwner.cjs")');
    expect(loader).toContain('"chromiumViewFocusAdmission"');
    expect(loader).not.toContain("chromiumOwnedInputSubmission");
    expect(parentBinding).toContain("readWindowsRuntimeForeground");
    expect(submission).toContain("sendChromiumKey");
    expect(probe).toContain('candidateEvidence: "foreground-and-hidden-product-path"');
    expect(probe).toContain("hiddenPresentationPreserved");
    expect(probe).toContain("exactSiblingViews");
    expect(probe).toContain("viewportAcknowledgement");
    expect(probe).toContain("hiddenMouseDom");
    expect(preload).toContain("event.isTrusted");
    for (const forbidden of ["attachWindowsChromiumInputHwnd", "projectWindowsChromiumInputHwnd",
      "probeWindowsChromiumInputHwnd", "surfaceHandleToken", "submitOwnedChromiumKey", "SetParent(", "SendMessageTimeoutW"]) {
      expect(probe).not.toContain(forbidden);
      expect(submission).not.toContain(forbidden);
      expect(parentBinding).not.toContain(forbidden);
    }
  });

  it("runs the addon-independent API experiment before native Rust gates", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const nativeJob = workflow.slice(workflow.indexOf("  platform-validation:"));
    const probe = nativeJob.indexOf("tests/electron-chromium-input.native-integration.ts");
    const rust = nativeJob.indexOf("name: Test target-platform Rust workspace");
    expect(probe).toBeGreaterThan(0);
    expect(rust).toBeGreaterThan(probe);
    expect(nativeJob.indexOf("name: Upload Chromium input compatibility evidence")).toBeLessThan(rust);
    expect(nativeJob).toContain("id: chromium_input_api_probe\n        continue-on-error: true");
    expect(nativeJob).toContain("steps.chromium_input_api_probe.outcome == 'failure'");
    expect(nativeJob).toContain("run: exit 1");
    expect(nativeJob.slice(0, probe)).toContain("os: macos-latest");
    expect(nativeJob.slice(0, probe)).toContain("os: windows-latest");
    expect(nativeJob.slice(probe, rust)).toContain("RION_CHROMIUM_INPUT_REPORT_DIR");
  });

  it("routes the foreground physical gate only through the Windows profile", async () => {
    const [manifestSource, phaseSource, bootstrapSource] = await Promise.all([
      readFile("docs/e2e-coverage.json", "utf8"),
      readFile("e2e/desktop/phaseSpecs.ts", "utf8"),
      readFile("src/electron/main/chromiumRuntimeBootstrap.ts", "utf8")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    const phase = "chromium-windows-trusted-input-physical";
    const spec = "e2e/desktop/specs/chromium-windows-trusted-input-physical.e2e.ts";

    expect(manifest.profiles["chromium-windows-smoke"]?.phases).toContain(phase);
    expect(manifest.profiles["chromium-windows-smoke"]?.specs).toContain(spec);
    expect(manifest.profiles["chromium-macos-appkit-smoke"]?.phases)
      .not.toContain(phase);
    expect(manifest.profiles["chromium-macos-appkit-smoke"]?.specs)
      .not.toContain(spec);
    expect(phaseSource).toContain(`"${phase}": "${spec}"`);
    expect(bootstrapSource).toMatch(
      /trustedInput: "supported",\n\s+backgroundInput: "supported"/u
    );
  });
});
