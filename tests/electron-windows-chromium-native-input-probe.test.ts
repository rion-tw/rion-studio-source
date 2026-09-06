import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Windows Chromium physical input candidate gate", () => {
  it("uses exact public Electron ownership plus read-only Win32 proof", async () => {
    const [probe, preload, nativeAttachment, nativeProbe, nativeSubmission] =
      await Promise.all([
      readFile("scripts/electronWindowsChromiumTrustedInputProbe.cjs", "utf8"),
      readFile(
        "scripts/electronWindowsChromiumTrustedInputProbePreload.cjs",
        "utf8"
      ),
      readFile(
        "crates/rion-node/src/windows_chromium_input_attachment.rs",
        "utf8"
      ),
      readFile("crates/rion-node/src/windows_chromium_input_probe.rs", "utf8"),
      readFile("src/electron/main/chromiumOwnedInputSubmission.ts", "utf8")
    ]);

    expect(probe).toContain("new BaseWindow({");
    expect(probe).toContain("parent,");
    expect(probe).toContain("child.contentView.addChildView(view)");
    expect(probe).toContain("child.contentView.children.length !== 1");
    expect(probe).toContain("addon.attachWindowsChromiumInputHwnd");
    expect(probe).toContain("addon.probeWindowsChromiumInputHwnd");
    expect(probe).toContain("targetWasForeground");
    expect(probe).toContain("parentWasForeground");
    expect(probe).toContain("targetHadThreadFocus");
    expect(probe).toContain('candidateEvidence: "foreground-and-hidden-product-path"');
    expect(probe).toContain('deliveryMode: "background"');
    expect(probe).toContain("controlProbe");
    expect(probe).toContain("hiddenPresentationPreserved");
    expect(preload).toContain("event.isTrusted");
    expect(nativeSubmission).toContain("sendChromiumKey");
    expect(nativeSubmission).not.toContain("SendMessageTimeoutW");
    expect(probe).toContain("require(\"./electronLoadChromiumInputOwner.cjs\")");
    expect(nativeAttachment).toContain("SetParent(");
    expect(nativeAttachment).toContain("SetLastError(WIN32_ERROR(0))");
    expect(nativeAttachment).not.toContain(
      "Electron did not retain the exact requested runtime parent owner."
    );
    expect(nativeAttachment).not.toContain(
      "Win32 changed an unexpected Chromium input-surface parent."
    );
    expect(nativeAttachment).toContain("SetWindowLongPtrW(");
    expect(nativeAttachment).toContain("SetWindowPos(");
    expect(nativeAttachment).toContain("SWP_NOACTIVATE");
    expect(nativeAttachment).not.toContain("EnumChildWindows");
    expect(nativeAttachment).not.toContain("FindWindow");
    for (const forbiddenMutation of [
      "SetParent(", "SetWindowLong", "SetWindowPos(", "ShowWindow(",
      "PostMessage", "EnumChildWindows", "FindWindow"
    ]) {
      expect(nativeProbe).not.toContain(forbiddenMutation);
      expect(nativeSubmission).not.toContain(forbiddenMutation);
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
