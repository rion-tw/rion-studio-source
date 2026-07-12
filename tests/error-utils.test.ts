import { describe, expect, it } from "vitest";

import { localizeErrorMessage } from "../src/renderer/src/i18n";

describe("renderer error localization", () => {
  it("localizes hidden browser helper launch failures", () => {
    expect(localizeErrorMessage("Unable to start the hidden Rion Studio browser helper.", "en")).toBe(
      "Unable to start the hidden browser helper."
    );
  });
});
