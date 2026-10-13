import { describe, expect, it, vi } from "vitest";
import { preserveChromiumFunctionKeyInput } from "../src/electron/main/chromiumFunctionKeyInput";

describe.each(["darwin", "win32"])("game function-key menu isolation (%s)", () => {
  it("preserves the complete function-key range and restores menu handling on the next other key", () => {
    const contents = { setIgnoreMenuShortcuts: vi.fn() };
    for (let number = 1; number <= 24; number++) {
      for (const code of [`F${number}`, ""]) {
        preserveChromiumFunctionKeyInput(contents, { code, key: `F${number}` });
        expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
      }
    }
    for (const code of ["ControlLeft", "Tab", "KeyK", "KeyV", "Digit0", "F0", "F25"]) {
      preserveChromiumFunctionKeyInput(contents, { code, key: code });
      expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    }
  });
});
