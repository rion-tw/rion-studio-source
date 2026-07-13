import { describe, expect, it } from "vitest";

import {
  createEditEditorPath,
  createNewEditorPath,
  getEditorParentPath,
  normalizeAppReturnTo,
  readRequestedMacroRoleId
} from "../src/renderer/src/app/editorNavigation";

describe("editor navigation", () => {
  it("builds new and edit routes", () => {
    expect(createNewEditorPath("roles")).toBe("/roles/new");
    expect(createEditEditorPath("workspaces", "workspace 1")).toBe("/workspaces/workspace%201/edit");
    expect(createNewEditorPath("macros", new URLSearchParams({ roleId: "role-1" }))).toBe(
      "/macros/new?roleId=role-1"
    );
  });

  it("maps editor routes to their parent lists", () => {
    expect(getEditorParentPath("/roles/new")).toBe("/roles");
    expect(getEditorParentPath("/workspaces/workspace-1/edit")).toBe("/workspaces");
    expect(getEditorParentPath("/macros/macro-1/edit")).toBe("/macros");
    expect(getEditorParentPath("/roles")).toBeNull();
    expect(getEditorParentPath("/roles/role-1")).toBeNull();
  });

  it("normalizes settings return locations away from discarded editors", () => {
    expect(normalizeAppReturnTo("/roles/role-1/edit", "?ignored=true")).toBe("/roles");
    expect(normalizeAppReturnTo("/macros", "?role=role-1")).toBe("/macros?role=role-1");
  });

  it("reads optional macro role selections", () => {
    expect(readRequestedMacroRoleId("?roleId=role-1")).toBe("role-1");
    expect(readRequestedMacroRoleId("?roleId=%20%20")).toBeUndefined();
    expect(readRequestedMacroRoleId("")).toBeUndefined();
  });
});
