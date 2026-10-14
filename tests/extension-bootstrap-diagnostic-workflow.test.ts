import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const branch = "refs/heads/codex/extension-bootstrap-evidence";
const electronJob = workflow.split("  electron-platform-validation:")[1]!;

function step(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = electronJob.indexOf(marker);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = electronJob.indexOf("      - name: ", start + marker.length);
  return electronJob.slice(start, end < 0 ? undefined : end);
}

describe("isolated extension bootstrap diagnostic CI", () => {
  it("runs the three focused phases in their original process order on the exact branch", () => {
    const shell = step("Run macOS AppKit Chromium shell E2E");
    expect(shell).toContain(`if [ "$GITHUB_REF" = "${branch}" ]; then`);
    expect(shell).toContain("pnpm run test:e2e:desktop:chromium:macos-appkit -- --phase=chromium-extensions-seed");
    expect([...shell.matchAll(/--phase=([a-z-]+)/gu)].map(match => match[1])).toEqual([
      "chromium-extensions-context-menu",
      "chromium-extension-filtering",
      "chromium-extensions-seed"
    ]);
    expect(shell).toContain("in their original process order");
    expect(shell).not.toContain("dependencies");
    expect(shell).toContain("else\n            pnpm run test:e2e:desktop:chromium:macos-appkit\n          fi");
    expect(shell).toContain("does not provide full desktop profile, package, or release quality evidence");
    expect(shell).not.toContain("continue-on-error");
    expect(electronJob).toContain("'Electron Chromium extension bootstrap diagnostics' || 'Electron Chromium package validation'");
  });

  it("captures independent native evidence after a failed seed without swallowing failure", () => {
    const name = "Diagnose native extension bootstrap independently of desktop instrumentation";
    const probe = step(name);
    expect(probe).toContain("if: ${{ always() && github.ref == '" + branch + "' && runner.os == 'macOS' }}");
    expect(probe).toContain("timeout-minutes: 10");
    expect(probe).toContain("run: node scripts/diagnoseElectronExtensionBootstrap.mjs .desktop-e2e-artifacts");
    expect(probe).not.toContain("continue-on-error");
    expect(probe).not.toContain("|| true");
    expect(electronJob.indexOf(name)).toBeGreaterThan(electronJob.indexOf("Run macOS AppKit Chromium shell E2E"));
    expect(electronJob.indexOf(name)).toBeLessThan(electronJob.indexOf("Run Windows Chromium shell E2E"));
  });

  it("keeps probe reports separate from shell evidence and excludes isolated profiles", () => {
    const upload = step("Upload independent extension bootstrap diagnostics");
    expect(upload).toContain("if: ${{ always() && github.ref == '" + branch + "' && runner.os == 'macOS' }}");
    expect(upload).toContain("name: extension-bootstrap-diagnostics-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(upload).toContain("include-hidden-files: true");
    expect(upload).toContain(".desktop-e2e-artifacts/extension-bootstrap-diagnostics\n");
    expect(upload).toContain("!.desktop-e2e-artifacts/extension-bootstrap-diagnostics/**/package/**");
    expect(upload).toContain("!.desktop-e2e-artifacts/extension-bootstrap-diagnostics/**/cases/*/session/**");
    expect(step("Upload Chromium shell E2E diagnostics")).toContain("!.desktop-e2e-artifacts/extension-bootstrap-diagnostics/**");
  });

  it("skips distribution validation only on the exact diagnostic branch", () => {
    for (const name of [
      "Build macOS Electron Chromium release artifacts",
      "Build Windows Electron Chromium release artifacts",
      "Build previous-version updater fixtures",
      "Verify Chromium extension isolation and fresh-process persistence",
      "Verify exact Electron, Chromium, Rust Core, and AppKit ABI runtime",
      "Verify macOS Electron package structure",
      "Verify Windows Electron package structure",
      "Verify macOS Electron distribution payloads",
      "Verify Windows Electron distribution payload",
      "Verify exact Windows NSIS installed payload",
      "Verify packaged macOS Rust-owned updater transaction",
      "Verify packaged Windows Rust-owned updater transactions",
      "Run packaged macOS AppKit Chromium Role black-box E2E",
      "Run packaged Windows Chromium Role black-box E2E",
      "Upload packaged Chromium Role black-box E2E diagnostics"
    ]) {
      const condition = step(name).match(/^ {8}if: (.+)$/mu)?.[1];
      expect(condition, name).toContain(`github.ref != '${branch}'`);
      expect(condition, name).not.toContain("startsWith");
    }
    expect(step("Build macOS Electron Chromium release artifacts")).toContain("runner.os == 'macOS'");
    expect(step("Build Windows Electron Chromium release artifacts")).toContain("runner.os == 'Windows'");
    expect(step("Require complete Windows Chromium E2E after independent package evidence"))
      .toContain("steps.chromium_windows_smoke.outcome != 'success'");
  });

  it("preserves ordinary native checks and refuses manual diagnostics as release evidence", () => {
    expect(workflow.split("  electron-platform-validation:")[0]).not.toContain(branch);
    expect(step("Restore Electron Rust build cache")).not.toContain(branch);
    expect(step("Verify desktop shell migration boundary")).not.toContain(branch);
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    expect(release).toContain("github.event.workflow_run.event == 'push'");
    expect(release).not.toContain("extension-bootstrap-evidence");
  });
});
