import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const specPath = "e2e/desktop/specs/chromium-app-crud.e2e.ts";

describe("Chromium app CRUD desktop E2E boundary", () => {
  it("keeps every product mutation on visible WebDriver UI", async () => {
    const source = await readFile(specPath, "utf8");

    expect(source).not.toContain("navigate(");
    expect(source).not.toContain("browser.execute");
    expect(source).not.toContain("dispatchEvent");
    expect(source).not.toContain("selectEntityItems(");
    expect(source).not.toContain("dragEntityTo(");

    const rendererMethods = [...source.matchAll(/rendererCall\("([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(new Set(rendererMethods)).toEqual(new Set([
      "getAppSnapshot",
      "listGames",
      "listLaunchWorkspaces",
      "listMacros",
      "listRoles"
    ]));

    expect(source).toContain("browser.action(\"pointer\"");
    expect(source).toContain(".down(\"left\")");
    expect(source).toContain(".up(\"left\")");
    expect(source).toContain("Key.Command");
    expect(source).toContain("Key.Ctrl");
    expect(source).toContain("clickConfirmation(\"Cancel\")");
    expect(source).toContain("[data-workspace-layout-option='two_columns']");
  });
});
