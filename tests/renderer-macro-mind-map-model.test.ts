import { describe, expect, it } from "vitest";

import type { MacroFormState } from "../src/renderer/src/app/types";
import { calculateMacroMindMapFocus } from "../src/renderer/src/features/macros/macroMindMapFocus";
import { buildMacroMindMap } from "../src/renderer/src/features/macros/macroMindMapModel";
import {
  calculateMacroMindMapViewport,
  MACRO_MIND_MAP_MIN_READABLE_ZOOM
} from "../src/renderer/src/features/macros/macroMindMapViewport";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro, Role } from "../src/shared/types";

const t: Translator = (key) => en[key];

describe("macro mind map model", () => {
  it("uses the live root draft and preserves execution order and settings", () => {
    const persisted = macro({ name: "Saved name" });
    const form = formState({
      name: "Unsaved name",
      repeat: { type: "loop", intervalMs: 500 },
      steps: [
        { id: "key", type: "key", code: "F2" },
        { id: "delay", type: "delay", ms: 250 }
      ]
    });

    const model = buildMacroMindMap({
      expandedOccurrenceIds: new Set<string>(),
      form,
      macros: [persisted],
      roles: [role()],
      t
    });
    const root = model.nodes.find((node) => node.id === "root:macro");
    const settings = model.nodes.find((node) => node.id === "root:settings");
    const rootSteps = model.nodes.filter((node) => node.data.kind === "macroStep");

    expect(root?.data).toMatchObject({
      kind: "macroRoot",
      name: "Unsaved name",
      statusLabel: "Enabled",
      stepCount: 2
    });
    expect(settings?.data).toMatchObject({
      kind: "macroSettings",
      fields: expect.arrayContaining([
        { label: "Execution roles", value: "Main role" },
        { label: "Repeat", value: "Wait 500 ms after completion" }
      ])
    });
    expect(rootSteps.map((node) => node.id)).toEqual(["root:step:key", "root:step:delay"]);
    expect(rootSteps.map((node) => (
      node.data.kind === "macroStep" ? node.data.stepTypeLabel : ""
    ))).toEqual(["Key", "Delay"]);
    expect(model.edges.map((edge) => [edge.source, edge.target])).toEqual(expect.arrayContaining([
      ["root:macro", "root:step:key"],
      ["root:step:key", "root:step:delay"]
    ]));
  });

  it("expands repeated calls independently and exposes wait and trigger edges", () => {
    const child = macro({
      id: "child",
      name: "Child",
      steps: [{ id: "child-key", type: "key", code: "F3" }]
    });
    const form = formState({
      steps: [
        { id: "call-a", type: "macro", macroId: child.id, callMode: "wait" },
        { id: "call-b", type: "macro", macroId: child.id, callMode: "trigger" }
      ]
    });
    const collapsed = buildMacroMindMap({
      expandedOccurrenceIds: new Set(),
      form,
      macros: [macro(), child],
      roles: [role()],
      t
    });

    expect(collapsed.expandableOccurrenceIds).toHaveLength(2);
    expect(new Set(collapsed.expandableOccurrenceIds).size).toBe(2);

    const expanded = buildMacroMindMap({
      expandedOccurrenceIds: new Set(collapsed.expandableOccurrenceIds),
      form,
      macros: [macro(), child],
      roles: [role()],
      t
    });
    const calledRoots = expanded.nodes.filter((node) => (
      node.data.kind === "macroRoot" && !node.data.isCurrent
    ));
    const callEdges = expanded.edges.filter((edge) => edge.kind === "wait" || edge.kind === "trigger");

    expect(calledRoots).toHaveLength(2);
    expect(callEdges.map((edge) => edge.kind)).toEqual(["wait", "trigger"]);
    expect(callEdges.map((edge) => edge.label)).toEqual([
      "Wait for completion",
      "Trigger and continue"
    ]);
    expect(expanded.nodes.find((node) => node.id === "root:step:call-a")?.data).toMatchObject({
      kind: "macroStep",
      call: { modeLabel: "Wait for completion", statusLabel: "Enabled" }
    });
  });

  it("guards missing targets and dependency cycles without abandoning the map", () => {
    const child = macro({
      id: "child",
      name: "Child",
      steps: [{ id: "back", type: "macro", macroId: "macro-1" }]
    });
    const form = formState({
      steps: [
        { id: "missing", type: "macro", macroId: "gone" },
        { id: "child", type: "macro", macroId: child.id }
      ]
    });
    const collapsed = buildMacroMindMap({
      expandedOccurrenceIds: new Set(),
      form,
      macros: [macro(), child],
      roles: [role()],
      t
    });
    const childOccurrence = collapsed.expandableOccurrenceIds[0];
    const expanded = buildMacroMindMap({
      expandedOccurrenceIds: new Set([childOccurrence]),
      form,
      macros: [macro(), child],
      roles: [role()],
      t
    });
    const warnings = expanded.nodes
      .filter((node) => node.data.kind === "macroWarning")
      .map((node) => node.data.kind === "macroWarning" ? node.data.detail : "");

    expect(warnings).toContain("The called macro is unavailable.");
    expect(warnings).toContain("This call would repeat a macro already in the current path.");
    expect(expanded.nodes.filter((node) => node.data.kind === "macroRoot")).toHaveLength(2);
  });

  it("surfaces disabled and unassigned called macros as warnings", () => {
    const child = macro({ id: "child", enabled: false, name: "Unavailable child", roleIds: [] });
    const form = formState({ steps: [{ id: "child", type: "macro", macroId: child.id }] });
    const model = buildMacroMindMap({
      expandedOccurrenceIds: new Set(),
      form,
      macros: [macro(), child],
      roles: [role()],
      t
    });
    const callStep = model.nodes.find((node) => (
      node.data.kind === "macroStep" && node.data.call?.targetName === "Unavailable child"
    ));

    expect(callStep?.data).toMatchObject({
      kind: "macroStep",
      call: { warnings: ["Disabled", "No execution roles"] }
    });
  });

  it("uses measured content heights for every layouted node", () => {
    const child = macro({ id: "child", name: "Child" });
    const options = {
      expandedOccurrenceIds: new Set<string>(),
      form: formState({
        steps: [
          { id: "key", type: "key", code: "F2" },
          { id: "call", type: "macro", macroId: child.id }
        ]
      }),
      macros: [macro(), child],
      roles: [role()],
      t
    };
    const initialModel = buildMacroMindMap(options);
    const model = buildMacroMindMap({
      ...options,
      nodeHeights: new Map([
        ["root:macro", 176],
        ["root:settings", 236],
        ["root:step:key", 137],
        ["root:step:call", 208]
      ])
    });
    const normalStep = model.nodes.find((node) => node.id === "root:step:key");
    const callStep = model.nodes.find((node) => node.id === "root:step:call");

    expect(initialModel.nodes.find((node) => node.id === "root:step:key")?.height).toBe(112);
    expect(normalStep?.height).toBe(137);
    expect(callStep?.height).toBe(208);
    expect(model.nodes.find((node) => node.id === "root:macro")?.height).toBe(176);
    expect(model.nodes.find((node) => node.id === "root:settings")?.height).toBe(236);
    for (const node of model.nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(model.bounds.x);
      expect(node.position.y).toBeGreaterThanOrEqual(model.bounds.y);
      expect(node.position.x + node.width).toBeLessThanOrEqual(
        model.bounds.x + model.bounds.width
      );
      expect(node.position.y + node.height).toBeLessThanOrEqual(
        model.bounds.y + model.bounds.height
      );
    }
  });
});

describe("macro mind map viewport", () => {
  it("does not enlarge a small graph and keeps a compact minimum height", () => {
    const plan = calculateMacroMindMapViewport(
      { height: 180, width: 300, x: 0, y: 0 },
      900
    );

    expect(plan.zoom).toBe(1);
    expect(plan.height).toBe(240);
    expect(plan.horizontalOverflow).toBe(false);
  });

  it("fits a medium graph by width while preserving the readable zoom", () => {
    const plan = calculateMacroMindMapViewport(
      { height: 400, width: 700, x: 20, y: 10 },
      600
    );

    expect(plan.zoom).toBeCloseTo(536 / 700);
    expect(plan.viewport.zoom).toBe(plan.zoom);
    expect(plan.horizontalOverflow).toBe(false);
  });

  it("stops shrinking a wide graph at the readable threshold", () => {
    const plan = calculateMacroMindMapViewport(
      { height: 300, width: 1_200, x: 0, y: 0 },
      600
    );

    expect(plan.zoom).toBe(MACRO_MIND_MAP_MIN_READABLE_ZOOM);
    expect(plan.horizontalOverflow).toBe(true);
  });

  it("lets the canvas keep growing for 21-step and 100-step flows", () => {
    const buildLongModel = (stepCount: number) => buildMacroMindMap({
      expandedOccurrenceIds: new Set(),
      form: formState({
        steps: Array.from({ length: stepCount }, (_, index) => ({
          code: "F2",
          id: `step-${index}`,
          type: "key" as const
        }))
      }),
      macros: [macro()],
      roles: [role()],
      t
    });
    const medium = buildLongModel(21);
    const long = buildLongModel(100);
    const mediumPlan = calculateMacroMindMapViewport(medium.bounds, 640);
    const longPlan = calculateMacroMindMapViewport(long.bounds, 640);

    expect(mediumPlan.height).toBeGreaterThan(1_000);
    expect(longPlan.height).toBeGreaterThan(mediumPlan.height * 4);
  });
});

describe("macro mind map focus", () => {
  it("focuses the complete upstream path without the main downstream steps", () => {
    const model = buildMacroMindMap({
      expandedOccurrenceIds: new Set(),
      form: formState({
        steps: [
          { id: "first", type: "key", code: "F1" },
          { id: "second", type: "delay", ms: 100 },
          { id: "third", type: "click", xPercent: 10, yPercent: 20 }
        ]
      }),
      macros: [macro()],
      roles: [role()],
      t
    });
    const focus = calculateMacroMindMapFocus(model, "root:step:second");

    expect([...focus?.nodeIds ?? []]).toEqual([
      "root:step:second",
      "root:step:first",
      "root:macro"
    ]);
    expect([...focus?.edgeIds ?? []]).toEqual([
      "root:step:first->root:step:second",
      "root:macro->root:step:first"
    ]);
    expect(focus?.nodeIds.has("root:step:third")).toBe(false);
    expect(focus?.nodeIds.has("root:settings")).toBe(false);
  });

  it("includes a direct expanded call branch and its nested upstream path", () => {
    const child = macro({
      id: "child",
      name: "Child",
      steps: [{ id: "child-step", type: "delay", ms: 250 }]
    });
    const form = formState({
      steps: [
        { id: "before", type: "key", code: "F1" },
        { id: "call", type: "macro", macroId: child.id },
        { id: "after", type: "key", code: "F2" }
      ]
    });
    const collapsed = buildMacroMindMap({
      expandedOccurrenceIds: new Set(), form, macros: [macro(), child], roles: [role()], t
    });
    const occurrenceId = collapsed.expandableOccurrenceIds[0];
    const model = buildMacroMindMap({
      expandedOccurrenceIds: new Set([occurrenceId]), form, macros: [macro(), child], roles: [role()], t
    });
    const callFocus = calculateMacroMindMapFocus(model, "root:step:call");
    const childStepId = `${occurrenceId}:step:child-step`;

    expect(callFocus?.nodeIds.has(`${occurrenceId}:macro`)).toBe(true);
    expect(callFocus?.nodeIds.has(`${occurrenceId}:settings`)).toBe(true);
    expect(callFocus?.nodeIds.has(childStepId)).toBe(true);
    expect(callFocus?.nodeIds.has("root:step:after")).toBe(false);

    const nestedFocus = calculateMacroMindMapFocus(model, childStepId);
    expect(nestedFocus?.nodeIds.has("root:step:call")).toBe(true);
    expect(nestedFocus?.nodeIds.has("root:macro")).toBe(true);
  });

  it("focuses warnings and keeps repeated call occurrences isolated", () => {
    const child = macro({ id: "child", name: "Child" });
    const form = formState({
      steps: [
        { id: "missing", type: "macro", macroId: "gone" },
        { id: "first-call", type: "macro", macroId: child.id },
        { id: "second-call", type: "macro", macroId: child.id }
      ]
    });
    const collapsed = buildMacroMindMap({
      expandedOccurrenceIds: new Set(), form, macros: [macro(), child], roles: [role()], t
    });
    const model = buildMacroMindMap({
      expandedOccurrenceIds: new Set(collapsed.expandableOccurrenceIds),
      form,
      macros: [macro(), child],
      roles: [role()],
      t
    });
    const warningFocus = calculateMacroMindMapFocus(model, "root:step:missing");
    expect([...warningFocus?.nodeIds ?? []].some((id) => id.endsWith(":warning"))).toBe(true);

    const firstFocus = calculateMacroMindMapFocus(model, "root:step:first-call");
    const [firstOccurrence, secondOccurrence] = collapsed.expandableOccurrenceIds;
    expect(firstFocus?.nodeIds.has(`${firstOccurrence}:macro`)).toBe(true);
    expect(firstFocus?.nodeIds.has(`${secondOccurrence}:macro`)).toBe(false);
  });

  it("returns no focus for missing node ids", () => {
    const model = buildMacroMindMap({
      expandedOccurrenceIds: new Set(),
      form: formState(),
      macros: [macro()],
      roles: [role()],
      t
    });

    expect(calculateMacroMindMapFocus(model, "missing")).toBeUndefined();
    expect(calculateMacroMindMapFocus(model)).toBeUndefined();
  });
});

function formState(overrides: Partial<MacroFormState> = {}): MacroFormState {
  return {
    activationMode: "toggle",
    enabled: true,
    id: "macro-1",
    name: "Root macro",
    repeat: { type: "once" },
    roleIds: ["role-1"],
    shortcutSourceScope: { type: "all_execution_roles" },
    steps: [{ id: "step", type: "key", code: "F2" }],
    ...overrides
  };
}

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    createdAt: "2026-08-11T00:00:00.000Z",
    enabled: true,
    id: "macro-1",
    name: "Root macro",
    repeat: { type: "once" },
    roleIds: ["role-1"],
    shortcutSourceScope: { type: "all_execution_roles" },
    steps: [{ id: "step", type: "key", code: "F2" }],
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
}

function role(): Role {
  return {
    createdAt: "2026-08-11T00:00:00.000Z",
    gameId: "game-1",
    id: "role-1",
    launchUrl: "https://example.test/play",
    name: "Main role",
    notes: "",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}
