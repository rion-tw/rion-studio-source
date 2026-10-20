// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MacroFailureMessage } from "../src/renderer/src/features/macros/MacroListControls";
import { createTranslator, loadTranslations } from "../src/renderer/src/i18n";
import type { Macro, MacroRunStatus, Role } from "../src/shared/types";

const macro: Macro = {
  id: "macro-1",
  enabled: true,
  name: "Buff",
  roleIds: ["role-1"],
  shortcutSourceScope: { type: "all_execution_roles" },
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "Digit1" }],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z"
};
const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Role 1",
  launchUrl: "https://example.test/",
  notes: "",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z"
};

function failed(error: string): Map<string, MacroRunStatus> {
  return new Map([["role-1:macro-1", {
    roleId: role.id, macroId: macro.id, state: "failed", error,
    startedAt: macro.createdAt, updatedAt: macro.updatedAt
  }]]);
}

describe("macro failure message", () => {
  it("localizes a known Core failure instead of showing English text", async () => {
    const translations = await loadTranslations("zh-TW");
    const t = createTranslator("zh-TW", translations);
    render(<MacroFailureMessage macro={macro} roleById={new Map([[role.id, role]])} t={t}
      macroStatusByRun={failed("A role assigned to this macro must be restarted before it can accept automatic input.")} />);

    expect(screen.getByText(`${translations["macros.status.failed"]}: ${translations["error.macroRoleInputRestartRequired"]}`))
      .toBeTruthy();
  });

  it("keeps an unknown diagnostic message intact", async () => {
    const t = createTranslator("zh-TW", await loadTranslations("zh-TW"));
    render(<MacroFailureMessage macro={macro} roleById={new Map([[role.id, role]])} t={t}
      macroStatusByRun={failed("SYSTEM_EXAMPLE_FAILURE")} />);

    expect(screen.getByText(/SYSTEM_EXAMPLE_FAILURE/u)).toBeTruthy();
  });
});
