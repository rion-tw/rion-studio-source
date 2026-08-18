import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("native role LocalStorage ownership", () => {
  it("rejects retired synchronization and automatic checkpoint replay paths", async () => {
    const paths = [
      "../src-tauri/src/system_runtime.rs",
      "../src-tauri/src/system_runtime/section_29_session_storage.rs",
      "../src-tauri/src/system_runtime/section_19_webview_builder.rs",
      "../src-tauri/src/system_runtime/section_26_sync_native_tab_metadata.rs",
      "../src-tauri/src/system_runtime/section_10_live_tab_drag_commit.rs"
    ];
    const sources = await Promise.all(paths.map((path) =>
      readFile(new URL(path, import.meta.url), "utf8")
    ));
    for (const retired of [
      "rion_local_storage_sync_changed",
      "LocalStorageRuntimeConfig",
      "FLYFF_SETTINGS_INVALID",
      "local-storage-sync-v1.enc",
      "local-storage-sync-v2.enc",
      "ROLE_LOCAL_STORAGE_CHECKPOINT",
      "role_local_storage_checkpoint",
      "persist_role_local_storage_checkpoint",
      "__rionRoleLocalStorageCheckpoint",
      "local-storage-checkpoint.enc"
    ]) {
      for (const source of sources) expect(source).not.toContain(retired);
    }

    const session = sources[1];
    expect(session).toContain("fn local_storage_document_start_script(");
    expect(session).toContain("globalThis.top !== globalThis");
    expect(session).toContain("fn local_storage_restore_script(");
  });

  it("retires only the exact replay artifacts at Core startup", async () => {
    const [startup, storage] = await Promise.all([
      readFile(new URL(
        "../crates/rion-core/src/app/section_01_event_queue_capacity.rs",
        import.meta.url
      ), "utf8"),
      readFile(new URL("../crates/rion-core/src/role_browser_data.rs", import.meta.url), "utf8")
    ]);

    expect(startup).toContain("retire_local_storage_replay_artifacts(&user_data_dir)");
    for (const retired of [
      "local-storage-sync-v1.enc",
      "local-storage-sync-v2.enc",
      "local-storage-checkpoint.enc"
    ]) {
      expect(storage).toContain(retired);
    }
    expect(storage).toContain('system.join("cookie-checkpoint.enc")');
    expect(storage).toContain('webview2.join("Local Storage")');
  });
});
