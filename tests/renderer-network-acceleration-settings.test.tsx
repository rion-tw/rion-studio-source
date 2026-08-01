// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkAccelerationSettingsSection } from "../src/renderer/src/features/settings/NetworkAccelerationSettingsSection";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("network acceleration settings", () => {
  it("saves a local HTTP proxy without probing it and warns about running roles", async () => {
    const onSave = vi.fn(async (settings) => settings);
    render(
      <NetworkAccelerationSettingsSection
        hasRunningRoles
        settings={{ mode: "system" }}
        t={t}
        onError={vi.fn()}
        onSave={onSave}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Local proxy" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Proxy port" }), {
      target: { value: "10090" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save network route" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      mode: "custom",
      custom: { protocol: "http", host: "127.0.0.1", port: 10090 }
    }));
    expect(screen.getByText(/Stop and relaunch them to apply/u)).toBeTruthy();
  });

  it("requires a valid port before saving custom mode", () => {
    render(
      <NetworkAccelerationSettingsSection
        hasRunningRoles={false}
        settings={{
          mode: "custom",
          custom: { protocol: "socks5", host: "::1", port: 1080 }
        }}
        t={t}
        onError={vi.fn()}
        onSave={vi.fn(async (settings) => settings)}
      />
    );

    fireEvent.change(screen.getByRole("spinbutton", { name: "Proxy port" }), {
      target: { value: "0" }
    });
    expect(screen.getByText("Enter a whole-number port from 1 to 65535.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save network route" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});
