import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Electron Chromium runtime recovery lifecycle wiring", () => {
  it("journals live topology and persists clean exit before normal drains", async () => {
    const [main, bootstrap, executor, runtimeUi] = await Promise.all([
      readFile("src/electron/main/index.ts", "utf8"),
      readFile("src/electron/main/chromiumRuntimeBootstrap.ts", "utf8"),
      readFile("src/electron/main/chromiumRuntimeEffectExecutor.ts", "utf8"),
      readFile("crates/rion-core/src/app/section_19_runtime_ui_actions.rs", "utf8")
    ]);

    expect(main).toContain(
      "runtimeRestoreSession = new ChromiumRuntimeRestoreSessionCoordinator({ core })"
    );
    expect(main).toContain(
      "chromiumLaunchCompletions = new ChromiumRuntimeLaunchCompletionCoordinator({"
    );
    expect(main).toContain("chromiumLaunchCompletions.start();");
    expect(main).toContain("launchCompletions: chromiumLaunchCompletions");
    expect(main).toContain("projectAppSnapshot: (snapshot, native, displayTopology) =>");
    expect(main).toContain("chromiumLaunchCompletions?.dispose();");
    expect(main).toContain("restoreSession: activeRuntimeRestoreSession()");
    expect(main).toContain("prepareCleanExit: () => prepareElectronCleanExit({");
    expect(main).toContain("runtime: chromiumRuntime");
    expect(main).toContain(
      "activeRuntimeRestoreSession().persistCleanExit(snapshot)"
    );
    expect(main).toContain("ipcBridge?.dispose();");
    expect(main).toContain(
      "drainShellAndCore: () => activeLifecycle().prepareCleanQuit()"
    );
    expect(main).toMatch(
      /prepareElectronMainQuit\(\): Promise<void> \{\s*return activeLifecycle\(\)\.prepareCleanQuit\(\);/u
    );
    expect(main).toContain("new ElectronFatalTerminationCoordinator({");
    const startupFailure = main.slice(main.indexOf("void startup.catch"));
    expect(startupFailure).toContain("fatalTerminationCoordinator().terminate()");
    expect(startupFailure).not.toContain("prepareCleanQuit");
    expect(bootstrap).toContain("await this.#executor.dispose();");
    expect(bootstrap).toContain("await persist(snapshot);");
    expect(bootstrap).toContain("this.#closeNativeActionIngress();");
    expect(runtimeUi).toContain("self.commit_runtime_window_snapshot_batch_inner(inputs)?");
    expect(runtimeUi).toContain("self.update_runtime_restore_session(|session|");
    expect(runtimeUi).toContain("session.clean_exit = false;");
    expect(runtimeUi).toContain("session.live_window_ids = Some(live_window_ids);");
    expect(bootstrap).not.toContain("persistAcknowledgedRuntimeRecovery");
    expect(executor).not.toContain("restoreSession");
    expect(executor).not.toContain("gameWindowRuntimeSnapshotBatchCommit");
    expect(executor).not.toContain("windowSnapshots");
  });
});
