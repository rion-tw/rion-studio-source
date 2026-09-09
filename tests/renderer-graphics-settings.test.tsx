// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphicsSettingsSection } from "../src/renderer/src/features/settings/GraphicsSettingsSection";
import { ApplicationQuitGuardContext } from "../src/renderer/src/components/applicationQuitGuardRegistry";
import { defaultGraphicsSettings, unsupportedGraphicsStatus } from "../src/shared/graphicsSettings";
import type { GraphicsSettingsSnapshotRecord, GraphicsStatusRecord } from "../src/shared/generated";
import type { RionStudioApi } from "../src/shared/api";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
const t: Translator = (key) => en[key] ?? key;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(platform: "mac" | "windows", supported = true) {
  document.documentElement.dataset.platform = platform;
  let saved: GraphicsSettingsSnapshotRecord = { revision: 0, settings: { ...defaultGraphicsSettings } };
  const status: GraphicsStatusRecord = { ...unsupportedGraphicsStatus(), supported, initialized: true,
    hardwareAcceleration: true, appliedSettings: { ...defaultGraphicsSettings }, features: { webgl: "enabled" } };
  let change!: (value: GraphicsSettingsSnapshotRecord) => void;
  const off = vi.fn();
  const api = { getGraphicsStatus: vi.fn(async () => status), getGraphicsSettings: vi.fn(async () => saved),
    updateGraphicsSettings: vi.fn(async (settings) => { saved = { revision: saved.revision + 1, settings }; change(saved); return saved; }),
    onGraphicsSettingsChanged: vi.fn((callback) => { change = callback; return off; }),
    onGraphicsStatusChanged: vi.fn(() => off), copyGraphicsReport: vi.fn(async () => undefined), restartApplication: vi.fn(async () => undefined) };
  window.rionStudio = api as unknown as RionStudioApi;
  return { api, off };
}

describe.each(["mac", "windows"] as const)("%s graphics UI", (platform) => {
  it("preserves subordinate values, distinguishes current state, and clears restart on reverting", async () => {
    const { api, off } = setup(platform);
    const onError = vi.fn();
    const view = render(<GraphicsSettingsSection t={t} onError={onError} />);
    const toggle = await screen.findByRole("switch", { name: "GPU hardware acceleration" });
    fireEvent.click(toggle);
    await screen.findByText("Restart required");
    expect(screen.getByRole("combobox", { name: "GPU Rasterization" }).hasAttribute("disabled")).toBe(true);
    expect(api.updateGraphicsSettings).toHaveBeenLastCalledWith({ ...defaultGraphicsSettings, hardwareAcceleration: false });
    expect(screen.getByText("Hardware acceleration enabled")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText("Restart required")).toBeNull());
    api.updateGraphicsSettings.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(toggle);
    await screen.findByRole("alert");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(onError).toHaveBeenCalled();
    view.unmount(); expect(off).toHaveBeenCalledTimes(2);
  });
  it("shows diagnostics in a separate group without expanding and copies the authoritative report through the bridge", async () => {
    const { api } = setup(platform);
    render(<GraphicsSettingsSection t={t} onError={vi.fn()} />);
    await screen.findByRole("switch", { name: "GPU hardware acceleration" });
    await screen.findByText("Graphics feature status");
    const information = screen.getByRole("region", { name: "Graphics information" });
    expect(information.querySelector("details")).toBeNull();
    expect(information.contains(screen.getByRole("switch", { name: "GPU hardware acceleration" }))).toBe(false);
    expect(api.getGraphicsStatus).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await screen.findByText("Copied");
    expect(api.copyGraphicsReport).toHaveBeenCalledOnce();
  });
  it("hides unsupported shells", async () => {
    const { api } = setup(platform, false);
    render(<GraphicsSettingsSection t={t} onError={vi.fn()} />);
    await waitFor(() => expect(api.getGraphicsStatus).toHaveBeenCalled());
    expect(screen.queryByText("Graphics settings")).toBeNull();
    expect(api.getGraphicsSettings).not.toHaveBeenCalled();
  });
  it("uses the existing quit guard and does not restart when cancelled", async () => {
    const { api } = setup(platform);
    const requestAction = vi.fn(async () => false);
    render(<ApplicationQuitGuardContext.Provider value={{ requestAction, updateBlocker: vi.fn() }}>
      <GraphicsSettingsSection t={t} onError={vi.fn()} />
    </ApplicationQuitGuardContext.Provider>);
    fireEvent.click(await screen.findByRole("switch", { name: "GPU hardware acceleration" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(requestAction).toHaveBeenCalledOnce());
    expect(api.restartApplication).not.toHaveBeenCalled();
  });
});
