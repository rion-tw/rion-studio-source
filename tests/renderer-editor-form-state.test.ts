import { describe, expect, it } from "vitest";

import {
  areEditorFormsEqual,
  createMacroFormState,
  createNewMacroForm,
  createNewRoleForm,
  createNewWorkspaceForm,
  createRoleFormState,
  createWorkspaceFormState
} from "../src/renderer/src/app/editorFormState";
import type { LaunchWorkspace, Macro, Role } from "../src/shared/types";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => key;

describe("editor form state", () => {
  it("creates role forms from defaults and saved roles", () => {
    expect(createNewRoleForm({ windowWidth: 1600, windowHeight: 900 })).toMatchObject({
      windowWidth: 1600,
      windowHeight: 900
    });
    expect(createRoleFormState(role())).toMatchObject({
      id: "role-1",
      name: "Main",
      notes: "Ready"
    });
  });

  it("creates workspace forms with defaults and copies saved slot state", () => {
    const newForm = createNewWorkspaceForm([], t);
    expect(newForm).toMatchObject({
      template: "two_columns",
      browserZoomPercent: 100,
      resourcePolicy: { mode: "adaptive" }
    });
    expect(newForm).not.toHaveProperty("targetDisplayId");
    expect(newForm.slots).toHaveLength(2);

    const savedForm = createWorkspaceFormState(workspace());
    expect(savedForm.id).toBe("workspace-1");
    expect(savedForm.targetDisplayId).toBe(22);
    expect(savedForm.resourcePolicy).toEqual({
      mode: "adaptive",
      primaryRoleId: "role-1"
    });
    expect(savedForm.slots[0].roleId).toBe("role-1");
  });

  it("creates macro forms with a valid requested role and clones saved nested values", () => {
    const roles = [role(), role({ id: "role-2", name: "Support" })];
    const newForm = createNewMacroForm([], roles, t, "role-2");
    expect(newForm.enabled).toBe(true);
    expect(newForm.roleIds).toEqual(["role-2"]);
    expect(createNewMacroForm([], roles, t, "missing").roleIds).toEqual(["role-1"]);

    const saved = macro({ enabled: false });
    const form = createMacroFormState(saved);
    expect(form.enabled).toBe(false);
    const firstStep = form.steps[0];
    if (firstStep.type !== "key") {
      throw new Error("Expected a key step.");
    }
    form.steps[0] = { ...firstStep, code: "F2" };
    expect(saved.steps[0]).toMatchObject({ code: "F1" });
  });

  it("detects nested changes while ignoring object key order and undefined properties", () => {
    const a = createMacroFormState(macro());
    const b = {
      steps: a.steps.map((step) => ({ ...step })),
      repeat: { ...a.repeat },
      roleIds: [...a.roleIds],
      name: a.name,
      id: a.id,
      enabled: a.enabled,
      trigger: undefined
    };

    expect(areEditorFormsEqual(a, b)).toBe(true);
    b.enabled = !b.enabled;
    expect(areEditorFormsEqual(a, b)).toBe(false);
    b.enabled = a.enabled;
    const firstStep = b.steps[0];
    if (firstStep.type !== "key") {
      throw new Error("Expected a key step.");
    }
    b.steps[0] = { ...firstStep, code: "F3" };
    expect(areEditorFormsEqual(a, b)).toBe(false);
  });
});

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main",
    launchUrl: "https://example.com/game",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "Ready",
    authState: "authenticated",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

function workspace(): LaunchWorkspace {
  return {
    id: "workspace-1",
    browserLaunchMode: "inherit",
    name: "Party",
    template: "two_columns",
    browserZoomPercent: 100,
    resourcePolicy: {
      mode: "adaptive",
      primaryRoleId: "role-1"
    },
    targetDisplayId: 22,
    slots: [
      { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { id: "slot-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
    ],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: "macro-1",
    enabled: true,
    name: "Heal",
    roleIds: ["role-1"],
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F1" }],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}
