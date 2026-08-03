// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateReadyBanner } from "../src/renderer/src/components/UpdateReadyBanner";
import type { Translator, TranslationKey } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import ja from "../src/renderer/src/i18n/ja.json";
import zhCN from "../src/renderer/src/i18n/zh-CN.json";
import zhTW from "../src/renderer/src/i18n/zh-TW.json";
import type { AppUpdateStatus } from "../src/shared/types";

const translations: Partial<Record<TranslationKey, string>> = {
  "app.updateLater": "Later",
  "app.updateReadyDescription": "Version {version} is downloaded.",
  "app.updateReadyTitle": "Update ready",
  "app.updateRestartNow": "Restart and update"
};
const t: Translator = (key) => translations[key] ?? key;

afterEach(cleanup);

describe("UpdateReadyBanner", () => {
  it("offers a guarded restart for a downloaded update", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn().mockResolvedValue(undefined);
    render(<UpdateReadyBanner status={downloadedStatus("2.0.0")} t={t} onInstall={onInstall} />);

    expect(screen.getByText("Version 2.0.0 is downloaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restart and update" }));

    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("dismisses only the current downloaded version", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <UpdateReadyBanner status={downloadedStatus("2.0.0")} t={t} onInstall={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<UpdateReadyBanner status={downloadedStatus("2.1.0")} t={t} onInstall={vi.fn()} />);
    expect(screen.getByText("Version 2.1.0 is downloaded.")).toBeTruthy();
  });

  it("stays hidden until a download is ready", () => {
    render(
      <UpdateReadyBanner
        status={{ ...downloadedStatus("2.0.0"), state: "downloading" }}
        t={t}
        onInstall={vi.fn()}
      />
    );

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers retry only when a failed install still has a verified pending payload", () => {
    const { rerender } = render(
      <UpdateReadyBanner
        status={{ ...downloadedStatus("2.0.0"), state: "install_failed", canRetryInstall: false }}
        t={t}
        onInstall={vi.fn()}
      />
    );
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <UpdateReadyBanner
        status={{ ...downloadedStatus("2.0.0"), state: "install_failed", canRetryInstall: true }}
        t={t}
        onInstall={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Restart and update" })).toBeTruthy();
  });

  it("provides the update policy and ready prompt in every supported language", () => {
    for (const dictionary of [en, zhTW, zhCN, ja]) {
      expect(dictionary["app.updateReadyTitle"]).toBeTruthy();
      expect(dictionary["app.updateReadyDescription"]).toContain("{version}");
      expect(dictionary["app.updateRestartNow"]).toBeTruthy();
      expect(dictionary["app.updateLater"]).toBeTruthy();
      expect(dictionary["settings.autoUpdateEnabled"]).toBeTruthy();
      expect(dictionary["settings.autoUpdateDisabled"]).toBeTruthy();
      expect(dictionary["settings.updateInstallFailed"]).toContain("{error}");
      for (const state of [
        "preparing",
        "installing",
        "draining",
        "restart_pending",
        "install_failed"
      ] as const) {
        expect(dictionary[`settings.updateState.${state}`]).toBeTruthy();
      }
    }
  });
});

function downloadedStatus(version: string): AppUpdateStatus {
  return {
    autoUpdateEnabled: true,
    availableVersion: version,
    currentVersion: "1.0.0",
    installMode: "automatic",
    isPackaged: true,
    state: "downloaded"
  };
}
