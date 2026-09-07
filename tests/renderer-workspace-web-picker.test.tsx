// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspaceWebPresetPicker } from "../src/renderer/src/features/workspaces/WorkspaceWebPresetPicker";
import type { TranslationDictionary, Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import tw from "../src/renderer/src/i18n/zh-TW.json";
import cn from "../src/renderer/src/i18n/zh-CN.json";
import ja from "../src/renderer/src/i18n/ja.json";

beforeAll(() => {
  for (const name of ["scrollIntoView", "releasePointerCapture", "setPointerCapture"]) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: () => undefined });
  }
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
});
afterEach(cleanup);

const locales: Array<[string, Partial<TranslationDictionary>]> = [["en", en], ["zh-TW", tw], ["zh-CN", cn], ["ja", ja]];

describe("grouped Website menu", () => {
  it.each(locales)("labels four accessible groups and selects an international platform in %s", async (_language, dictionary) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const t: Translator = key => dictionary[key] ?? en[key];
    render(<WorkspaceWebPresetPicker disabled={false} onSelect={onSelect} t={t} web={{ name: "", startUrl: "" }} />);
    await user.click(screen.getByRole("combobox"));
    for (const [category, count] of [["media", 15], ["live", 2], ["social", 8], ["other", 1]] as const) {
      const group = screen.getByRole("group", { name: t(`workspaces.webCategory.${category}`) });
      expect(within(group).getAllByRole("option")).toHaveLength(count);
    }
    expect(screen.getAllByRole("option")).toHaveLength(26);
    await user.click(screen.getByRole("option", { name: t("workspaces.webSite.iqiyi") }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "iqiyi", startUrl: "https://www.iq.com/" }));
  });

  it("moves across category boundaries and finds sites by typing without selecting headers", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceWebPresetPicker disabled={false} onSelect={onSelect} t={key => en[key]} web={{ name: "", startUrl: "" }} />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Wikipedia" })));
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Bahamut" })));
    await user.keyboard("{Home}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "YouTube" })));
    await user.keyboard("iq");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "iQIYI (International)" })));
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "iqiyi" }));
  });
});
