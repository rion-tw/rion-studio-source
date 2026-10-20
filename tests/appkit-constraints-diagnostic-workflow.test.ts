import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const branch = "refs/heads/codex/appkit-constraints-evidence";
const diagnostic = `github.event_name == 'workflow_dispatch' && github.ref == '${branch}' && runner.os == 'macOS'`;
const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/gu, "\n");
const job = workflow.split("  electron-platform-validation:")[1]!;
function step(name: string) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = job.indexOf("      - name: ", start + marker.length);
  return job.slice(start, end < 0 ? undefined : end);
}

describe("isolated AppKit constraint evidence workflow", () => {
  it("routes only manual exact-branch macOS to the focused seed with native diagnostics", () => {
    const shell = step("Run macOS AppKit Chromium shell E2E");
    expect(shell).toContain('if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" && "$GITHUB_REF" == "' + branch + '" ]]; then');
    expect(shell).toContain("pnpm run test:e2e:desktop:chromium:macos-appkit -- --phase=chromium-workspace-gap-dividers-seed");
    expect(shell).toContain("else\n            pnpm run test:e2e:desktop:chromium:macos-appkit -- --shard=${{ matrix.shard }}\n          fi");
    expect(shell).toContain(`RION_STUDIO_E2E_NATIVE_CONSTRAINT_DIAGNOSTIC: \${{ ${diagnostic} && '1' || '0' }}`);
    expect(shell).toContain("if: runner.os == 'macOS'");
    expect(shell).toContain("timeout-minutes: 90");
    expect(shell).not.toContain("continue-on-error");
    expect(shell).not.toContain("|| true");
  });

  it("labels its outcome as diagnostic evidence and preserves uploads after a failed seed", () => {
    const summary = step("Summarize isolated AppKit constraint evidence");
    expect(summary).toContain(`if: \${{ always() && ${diagnostic} }}`);
    expect(summary).toContain("NOT quality or release evidence");
    expect(summary).toContain("steps.chromium_macos_appkit_smoke.outcome");
    expect(job).toContain("AppKit constraints diagnostics (NOT quality/release)");
    const upload = step("Upload Chromium shell E2E diagnostics");
    expect(upload).toContain("if: always()");
    expect(upload).toContain("include-hidden-files: true");
    expect(upload).toContain("!.desktop-e2e-artifacts/**/roles/*/browser/**");
    expect(upload).toContain("!.desktop-e2e-artifacts/**/user-data/**");
  });

  it("collects only native witness-bound public logs before the existing always upload", () => {
    const collect = step("Collect exact native AppKit constraint logs");
    expect(collect).toContain(`if: \${{ always() && ${diagnostic} }}`);
    expect(collect).toContain("node scripts/collectAppKitConstraintDiagnostics.mjs .desktop-e2e-artifacts");
    expect(collect).not.toContain("continue-on-error");
    expect(job.indexOf("Collect exact native AppKit constraint logs"))
      .toBeLessThan(job.indexOf("Upload Chromium shell E2E diagnostics"));
  });

  it.each([
    "Build macOS Electron Chromium release artifacts",
    "Build previous-version updater fixtures", "Verify Chromium extension isolation and fresh-process persistence",
    "Verify exact Electron, Chromium, Rust Core, and AppKit ABI runtime", "Verify macOS Electron package structure",
    "Verify macOS Electron distribution payloads", "Verify packaged macOS Rust-owned updater transaction",
    "Run packaged macOS AppKit Chromium Role black-box E2E",
    "Upload packaged Chromium Role black-box E2E diagnostics"
  ])("excludes %s only from this exact manual macOS diagnostic", name => {
    const condition = step(name).match(/^ {8}if: (.+)$/mu)?.[1];
    expect(condition, name).toContain(`!(${diagnostic})`);
    expect(condition, name).not.toContain("startsWith");
    if (name.includes("macOS")) expect(condition).toContain("runner.os == 'macOS'");
  });

  it.each(["Build Windows Electron Chromium release artifacts", "Verify Windows Electron package structure",
    "Verify Windows Electron distribution payload", "Verify exact Windows NSIS installed payload",
    "Verify packaged Windows Rust-owned updater transactions", "Run packaged Windows Chromium Role black-box E2E"])(
    "preserves the original Windows-only %s condition", name => {
      expect(step(name)).toContain("if: runner.os == 'Windows'");
      expect(step(name)).not.toContain(branch);
    }
  );

  it("retains the paired native checks, Windows path and original shell preconditions", () => {
    expect(workflow.split("  electron-platform-validation:")[0]).not.toContain(branch);
    expect(step("Run Windows Chromium shell E2E")).not.toContain(branch);
    expect(step("Restore Electron Rust build cache")).not.toContain(branch);
    expect(step("Prepare ephemeral Electron updater trust fixture")).not.toContain(branch);
    expect(step("Apply and verify ephemeral Electron updater fixture version")).not.toContain(branch);
    expect(step("Require complete Windows Chromium E2E after independent package evidence"))
      .toContain("steps.chromium_windows_smoke.outcome != 'success'");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    expect(release).toContain("github.event.workflow_run.event == 'push'");
    expect(release).not.toContain("appkit-constraints-evidence");
  });
});

describe("native AppKit diagnostic authority boundaries", () => {
  const fullscreen = readFileSync("crates/rion-appkit/native/macos/RionRuntimeTabsController/06_fullscreen.mm", "utf8");
  const corner = readFileSync("crates/rion-appkit/native/macos/RionRuntimeTabsController/03_workspace_divider_views.mm", "utf8");
  it("keeps native logger mutations out of the desktop-E2E and environment guarded blocks", () => {
    const read = fullscreen.slice(fullscreen.indexOf("- (BOOL)desktopE2EFullscreenToolbarState:"),
      fullscreen.indexOf("  if (!std::isfinite(minimumFrameSize.width)"));
    expect(fullscreen.slice(0, fullscreen.indexOf("- (BOOL)desktopE2EFullscreenToolbarState:")))
      .toMatch(/#if defined\(RION_DESKTOP_E2E\)\s*$/u);
    expect(read).toContain('std::getenv("RION_STUDIO_E2E_NATIVE_CONSTRAINT_DIAGNOSTIC")');
    expect(read).toContain('std::strcmp(diagnostic, "1") == 0');
    expect(read).toContain('RionEmitAppKitConstraintDiagnostic(@"RION_APPKIT_CONSTRAINT_DIAGNOSTIC ", evidence)');
    expect(read).not.toContain("NSProcessInfo");
    expect(read).not.toMatch(/setFrame:|setContentSize:|setMinSize:|setContentMinSize:|\.minSize\s*=|\.contentMinSize\s*=/u);
    expect(read).not.toMatch(/\.title\b|session|userData|cookie|token/iu);
    const logger = corner.slice(corner.indexOf("#if defined(RION_DESKTOP_E2E)"),
      corner.indexOf("@implementation RionRuntimeWorkspaceDividerOverlayView"));
    expect(logger).toContain('std::getenv("RION_STUDIO_E2E_NATIVE_CONSTRAINT_DIAGNOSTIC")');
    expect(logger).toContain('std::strcmp(diagnostic, "1") != 0');
    expect(logger).toContain('os_log_with_type(OS_LOG_DEFAULT, OS_LOG_TYPE_DEFAULT, "%{public}s"');
    expect(logger).toContain('RionEmitAppKitConstraintDiagnostic(@"RION_APPKIT_CORNER_CONSTRAINT_DIAGNOSTIC ", evidence)');
    expect(logger).not.toContain("NSProcessInfo");
    expect(logger).not.toMatch(/setFrame:|setContentSize:|setMinSize:|setContentMinSize:/u);
    expect(logger).not.toMatch(/\.title\b|session|userData|cookie|token/iu);
  });

  it("serializes each snapshot once and emits only bounded desktop-E2E Base64 fragments", () => {
    const emitter = corner.slice(corner.indexOf("static void RionEmitAppKitConstraintDiagnostic"),
      corner.indexOf("#endif"));
    expect(emitter).toContain("encoded.length > 16 * 1024");
    expect(emitter).toContain("base64EncodedStringWithOptions:0");
    expect(emitter).toContain("NSUUID.UUID.UUIDString");
    expect(emitter).toContain("chunkSize = 320");
    expect(emitter).toContain("NSJSONWritingWithoutEscapingSlashes");
    expect(emitter).toContain("lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= 700");
    expect(emitter).not.toMatch(/setFrame:|setContentSize:|setMinSize:|setContentMinSize:|dispatch_after|NSTimer/u);
  });

  it("observes actual corner geometry on both sides of the existing native setter", () => {
    const before = corner.indexOf('RionLogWorkspaceCornerConstraintDiagnostic(self, @"mouseDragged-before"');
    const setter = corner.indexOf("[window setFrame:frame display:YES]");
    const after = corner.indexOf('RionLogWorkspaceCornerConstraintDiagnostic(self, @"mouseDragged-after"');
    expect(before).toBeLessThan(setter);
    expect(after).toBeGreaterThan(setter);
    expect(corner).toContain('@"windowFrame" : rect(window.frame)');
    expect(corner).toContain('@"contentViewFrame" : contentView ? rect(contentView.frame)');
    expect(corner).toContain('@"contentViewBounds" : contentView ? rect(contentView.bounds)');
    expect(fullscreen).toContain("NSStringFromClass(object_getClass(_window))");
  });

  it("keeps the harness witness confined to a native PID and boolean flag read", () => {
    const config = readFileSync("e2e/desktop/wdio.electron.conf.ts", "utf8");
    const start = config.indexOf('if (process.env.RION_STUDIO_E2E_NATIVE_CONSTRAINT_DIAGNOSTIC === "1")');
    const witness = config.slice(start, config.indexOf('if (process.platform === "win32"', start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(witness).toContain("runnerBrowser.electron.execute(() => ({");
    expect(witness).toContain("processId: process.pid");
    expect(witness).toContain("native.processId !== bridge.processId");
    expect(witness).toContain("appkit-constraint-launch-witness.json");
    expect(witness).not.toMatch(/process\.env[;,\s]*\}|Object\.(?:keys|entries)\(process\.env\)|\.focus\(|\.show\(|\.setBounds\(/u);
  });
});
