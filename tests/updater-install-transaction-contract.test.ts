import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("updater install transaction contract", () => {
  it("pins the updater version and preserves Tauri cleanup in the exit hook", async () => {
    const [cargo, manager, transaction] = await Promise.all([
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("src-tauri/src/update_manager.rs", "utf8"),
      readFile("src-tauri/src/update_transaction.rs", "utf8")
    ]);

    expect(cargo).toContain('tauri-plugin-updater = "=2.10.1"');
    expect(manager).toContain(".on_before_exit(move ||");
    expect(manager).toContain("before_exit_app.cleanup_before_exit();");
    expect(transaction).toContain('Ok(("installerHandoff", "restart_pending"))');
  });

  it("exports typed attempts and every recoverable update state", async () => {
    const [attempt, status, api] = await Promise.all([
      readFile("src/shared/generated/AppUpdateInstallAttemptRecord.ts", "utf8"),
      readFile("src/shared/generated/AppUpdateStatusRecord.ts", "utf8"),
      readFile("src/shared/api.ts", "utf8")
    ]);

    for (const phase of [
      "accepted",
      "preparing",
      "installing",
      "draining",
      "installerHandoff",
      "restartPending",
      "applied",
      "failedBeforeDrain",
      "failedAfterDrain"
    ]) {
      expect(attempt).toContain(`"${phase}"`);
    }
    for (const stateName of [
      "preparing",
      "installing",
      "draining",
      "restart_pending",
      "install_failed"
    ]) {
      expect(status).toContain(`"${stateName}"`);
    }
    expect(api).toContain("installDownloadedUpdate: () => Promise<AppUpdateInstallAttempt>");
  });

  it("does not hold the pending payload lock while the native installer runs", async () => {
    const manager = await readFile("src-tauri/src/update_manager.rs", "utf8");
    const clonePayload = manager.indexOf("(pending.update.clone(), Arc::clone(&pending.bytes))");
    const install = manager.indexOf("update.install(bytes.as_slice())", clonePayload);

    expect(clonePayload).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(clonePayload);
    expect(manager.slice(clonePayload, install)).toContain("};");
    expect(manager).toContain("self.install_gate.active_attempt()?");
  });

  it("stages before macOS drain and checks post-drain failures before returning", async () => {
    const source = await readFile("src-tauri/src/lib/section_01_update_install.rs", "utf8");
    const install = source.indexOf("updates.install_downloaded()");
    const macDrain = source.indexOf('#[cfg(target_os = "macos")]', install);
    const postDrainCheck = source.indexOf("updates.install_has_started_draining()");

    expect(install).toBeGreaterThan(-1);
    expect(macDrain).toBeGreaterThan(install);
    expect(postDrainCheck).toBeGreaterThan(-1);
    expect(source).toContain('Some("UPDATE_INSTALL_HANDOFF_FAILED")');
    expect(source).toContain("app.restart();");
  });
});
