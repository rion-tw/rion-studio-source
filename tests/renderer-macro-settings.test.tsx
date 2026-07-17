// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MacroSettingsSection } from "../src/renderer/src/features/settings/MacroSettingsSection";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_MACRO_SETTINGS, MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";

const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

describe("MacroSettingsSection", () => {
  it("warns below recommendations and blocks values below hard limits", async () => {
    const onSave = vi.fn(async (settings) => settings);
    render(
      <MacroSettingsSection
        settings={DEFAULT_MACRO_SETTINGS}
        t={t}
        onError={vi.fn()}
        onSave={onSave}
      />
    );

    fireEvent.change(screen.getByRole("spinbutton", { name: "Startup buffer" }), {
      target: { value: "0" }
    });
    expect(screen.getByText("For reliable browser-game input, we recommend at least 100 ms.")).toBeTruthy();

    const keyHold = screen.getByRole("spinbutton", { name: "Key hold time" });
    fireEvent.change(keyHold, { target: { value: "19" } });
    expect(screen.getByText("Enter a whole number from 20 to 1000 ms.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(keyHold, { target: { value: "20" } });
    expect(screen.getByText("For reliable browser-game input, we recommend at least 30 ms.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      startupDelayMs: 0,
      keyHoldMs: 20,
      postInputDelayMs: 30,
      defaultLoopDelayMs: 1000
    }));
  });

  it("restores the complete recommended draft before saving", () => {
    render(
      <MacroSettingsSection
        settings={{
          startupDelayMs: 0,
          keyHoldMs: 20,
          postInputDelayMs: 10,
          defaultLoopDelayMs: 0
        }}
        t={t}
        onError={vi.fn()}
        onSave={vi.fn(async (settings) => settings)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore recommended" }));

    expect((screen.getByRole("spinbutton", { name: "Startup buffer" }) as HTMLInputElement).value).toBe("100");
    expect((screen.getByRole("spinbutton", { name: "Key hold time" }) as HTMLInputElement).value).toBe("30");
    expect((screen.getByRole("spinbutton", { name: "Post-input delay" }) as HTMLInputElement).value).toBe("30");
    expect((screen.getByRole("spinbutton", { name: "Default wait after each loop" }) as HTMLInputElement).value).toBe("1000");
  });

  it("accepts a 24-hour default loop wait and blocks larger values", async () => {
    const onSave = vi.fn(async (settings) => settings);
    render(
      <MacroSettingsSection
        settings={DEFAULT_MACRO_SETTINGS}
        t={t}
        onError={vi.fn()}
        onSave={onSave}
      />
    );

    const loopDelay = screen.getByRole("spinbutton", { name: "Default wait after each loop" }) as HTMLInputElement;
    expect(loopDelay.max).toBe(String(MACRO_DELAY_MAX_MS));

    fireEvent.change(loopDelay, { target: { value: String(MACRO_DELAY_MAX_MS + 1) } });
    expect(screen.getByText(`Enter a whole number from 0 to ${MACRO_DELAY_MAX_MS} ms.`)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(loopDelay, { target: { value: String(MACRO_DELAY_MAX_MS) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      ...DEFAULT_MACRO_SETTINGS,
      defaultLoopDelayMs: MACRO_DELAY_MAX_MS
    }));
  });
});
