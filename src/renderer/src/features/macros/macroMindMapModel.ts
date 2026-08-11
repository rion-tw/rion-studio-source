import dagre from "@dagrejs/dagre";

import type { MacroFormState } from "../../app/types";
import type { Translator } from "../../i18n";
import type { Macro, MacroCallMode, MacroStep, Role } from "../../../../shared/types";
import {
  formatMacroActivationMode,
  formatMacroRepeat,
  formatMacroShortcut,
  formatMacroStep
} from "./macroUtils";

export type MacroMindMapNodeKind = "macroRoot" | "macroSettings" | "macroStep" | "macroWarning";
export type MacroMindMapEdgeKind = "sequence" | "settings" | "wait" | "trigger" | "warning";

interface MacroMindMapNodeBase {
  ariaLabel: string;
  kind: MacroMindMapNodeKind;
}

export interface MacroRootNodeData extends MacroMindMapNodeBase {
  enabled: boolean;
  isCurrent: boolean;
  kind: "macroRoot";
  name: string;
  scopeLabel: string;
  statusLabel: string;
  stepCount: number;
  stepCountLabel: string;
  warnings: string[];
}

export interface MacroSettingsNodeData extends MacroMindMapNodeBase {
  fields: Array<{ label: string; value: string }>;
  kind: "macroSettings";
  title: string;
}

export interface MacroStepNodeData extends MacroMindMapNodeBase {
  call?: {
    canExpand: boolean;
    isExpanded: boolean;
    mode: MacroCallMode;
    modeLabel: string;
    occurrenceId: string;
    statusLabel: string;
    targetEnabled?: boolean;
    targetName: string;
    targetStepCount?: number;
    targetSummary?: string;
    warnings: string[];
  };
  currentStepId?: string;
  detail: string;
  index: number;
  kind: "macroStep";
  stepType: MacroStep["type"];
  stepTypeLabel: string;
}

export interface MacroWarningNodeData extends MacroMindMapNodeBase {
  detail: string;
  kind: "macroWarning";
  title: string;
  tone: "neutral" | "warning";
}

export type MacroMindMapNodeData =
  | MacroRootNodeData
  | MacroSettingsNodeData
  | MacroStepNodeData
  | MacroWarningNodeData;

export interface MacroMindMapNode {
  data: MacroMindMapNodeData;
  height: number;
  id: string;
  position: { x: number; y: number };
  type: MacroMindMapNodeKind;
  width: number;
}

export interface MacroMindMapBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface MacroMindMapEdge {
  id: string;
  kind: MacroMindMapEdgeKind;
  label?: string;
  source: string;
  target: string;
}

export interface MacroMindMapModel {
  bounds: MacroMindMapBounds;
  callCount: number;
  edges: MacroMindMapEdge[];
  expandedOccurrenceCount: number;
  expandableOccurrenceIds: string[];
  nodes: MacroMindMapNode[];
  stepCount: number;
  structureKey: string;
}

interface MacroDefinition {
  activationMode: Macro["activationMode"];
  enabled: boolean;
  id: string;
  isCurrent: boolean;
  name: string;
  repeat: Macro["repeat"];
  roleIds: string[];
  shortcutSourceScope: Macro["shortcutSourceScope"];
  steps: MacroStep[];
  trigger: Macro["trigger"];
}

interface BuildMacroMindMapOptions {
  expandedOccurrenceIds: ReadonlySet<string>;
  form: MacroFormState;
  macros: Macro[];
  nodeHeights?: ReadonlyMap<string, number>;
  roles: Role[];
  t: Translator;
}

const estimatedNodeSizeByKind: Record<MacroMindMapNodeKind, { height: number; width: number }> = {
  macroRoot: { height: 148, width: 252 },
  macroSettings: { height: 224, width: 284 },
  macroStep: { height: 112, width: 276 },
  macroWarning: { height: 104, width: 264 }
};
const estimatedMacroCallNodeSize = { height: 220, width: 276 };

export function buildMacroMindMap({
  expandedOccurrenceIds,
  form,
  macros,
  nodeHeights = new Map(),
  roles,
  t
}: BuildMacroMindMapOptions): MacroMindMapModel {
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const macroById = new Map(macros.map((macro) => [macro.id, toMacroDefinition(macro)]));
  const macroNameById = new Map(macros.map((macro) => [macro.id, macro.name]));
  const root = toRootDefinition(form);
  if (form.id) {
    macroNameById.set(form.id, form.name);
  }

  const nodes: MacroMindMapNode[] = [];
  const edges: MacroMindMapEdge[] = [];
  const expandableOccurrenceIds: string[] = [];

  addMacroOccurrence({
    definition: root,
    expandedOccurrenceIds,
    expandableOccurrenceIds,
    macroById,
    macroNameById,
    nodeHeights,
    nodes,
    edges,
    occurrenceId: "root",
    roleById,
    t,
    visitedMacroIds: new Set(form.id ? [form.id] : [])
  });

  const layoutedNodes = layoutNodes(nodes, edges);
  const structureKey = [
    ...layoutedNodes.map((node) => (
      `${node.id}:${node.width}x${node.height}@${node.position.x},${node.position.y}`
    )),
    ...edges.map((edge) => edge.id)
  ].join("|");

  return {
    bounds: getNodeBounds(layoutedNodes),
    callCount: form.steps.filter((step) => step.type === "macro").length,
    edges,
    expandedOccurrenceCount: expandableOccurrenceIds.filter((id) => expandedOccurrenceIds.has(id)).length,
    expandableOccurrenceIds,
    nodes: layoutedNodes,
    stepCount: form.steps.length,
    structureKey
  };
}

interface AddMacroOccurrenceOptions {
  definition: MacroDefinition;
  edges: MacroMindMapEdge[];
  expandedOccurrenceIds: ReadonlySet<string>;
  expandableOccurrenceIds: string[];
  macroById: ReadonlyMap<string, MacroDefinition>;
  macroNameById: ReadonlyMap<string, string>;
  nodeHeights: ReadonlyMap<string, number>;
  nodes: MacroMindMapNode[];
  occurrenceId: string;
  roleById: ReadonlyMap<string, Role>;
  t: Translator;
  visitedMacroIds: ReadonlySet<string>;
}

function addMacroOccurrence(options: AddMacroOccurrenceOptions): void {
  const {
    definition,
    edges,
    expandedOccurrenceIds,
    expandableOccurrenceIds,
    macroById,
    macroNameById,
    nodeHeights,
    nodes,
    occurrenceId,
    roleById,
    t,
    visitedMacroIds
  } = options;
  const rootId = `${occurrenceId}:macro`;
  const settingsId = `${occurrenceId}:settings`;
  const warnings = getMacroWarnings(definition, t);

  nodes.push(createNode(rootId, "macroRoot", {
    ariaLabel: `${definition.name}. ${t("macroForm.steps")}: ${definition.steps.length}.`,
    enabled: definition.enabled,
    isCurrent: definition.isCurrent,
    kind: "macroRoot",
    name: definition.name,
    scopeLabel: t(definition.isCurrent ? "mindMap.currentMacro" : "mindMap.calledMacro"),
    statusLabel: t(definition.enabled ? "mindMap.status.enabled" : "mindMap.status.disabled"),
    stepCount: definition.steps.length,
    stepCountLabel: t("mindMap.stepCount").replace("{count}", String(definition.steps.length)),
    warnings
  }, nodeHeights));
  nodes.push(createNode(settingsId, "macroSettings", {
    ariaLabel: `${t("mindMap.settings")}: ${definition.name}`,
    fields: createSettingsFields(definition, roleById, t),
    kind: "macroSettings",
    title: t("mindMap.settings")
  }, nodeHeights));
  edges.push(createEdge(`${rootId}->${settingsId}`, rootId, settingsId, "settings"));

  if (definition.steps.length === 0) {
    const emptyId = `${occurrenceId}:empty`;
    nodes.push(createNode(emptyId, "macroWarning", {
      ariaLabel: t("mindMap.emptySteps"),
      detail: t("macroForm.stepsEmptyHint"),
      kind: "macroWarning",
      title: t("mindMap.emptySteps"),
      tone: "neutral"
    }, nodeHeights));
    edges.push(createEdge(`${rootId}->${emptyId}`, rootId, emptyId, "sequence"));
    return;
  }

  let previousStepId = rootId;
  definition.steps.forEach((step, index) => {
    const stepId = `${occurrenceId}:step:${step.id}`;
    const call = step.type === "macro"
      ? createMacroCallData({
          expandedOccurrenceIds,
          expandableOccurrenceIds,
          index,
          macroById,
          occurrenceId,
          step,
          t,
          visitedMacroIds
        })
      : undefined;
    const detail = formatMacroStep(step, t, macroNameById);

    nodes.push(createNode(stepId, "macroStep", {
      ariaLabel: `${index + 1}. ${detail}`,
      call,
      currentStepId: definition.isCurrent ? step.id : undefined,
      detail,
      index,
      kind: "macroStep",
      stepType: step.type,
      stepTypeLabel: getStepTypeLabel(step.type, t)
    }, nodeHeights));
    edges.push(createEdge(`${previousStepId}->${stepId}`, previousStepId, stepId, "sequence"));
    previousStepId = stepId;

    if (step.type !== "macro") {
      return;
    }

    const target = macroById.get(step.macroId);
    if (!target) {
      addCallWarning(nodes, edges, stepId, call?.occurrenceId ?? `${occurrenceId}:missing`, {
        detail: t("mindMap.warning.missingMacro"),
        title: t("mindMap.warning.title")
      }, nodeHeights, t);
      return;
    }
    if (visitedMacroIds.has(target.id)) {
      addCallWarning(nodes, edges, stepId, call?.occurrenceId ?? `${occurrenceId}:cycle`, {
        detail: t("mindMap.warning.cycle"),
        title: t("mindMap.warning.title")
      }, nodeHeights, t);
      return;
    }
    if (!call?.isExpanded) {
      return;
    }

    const nextVisited = new Set(visitedMacroIds);
    nextVisited.add(target.id);
    addMacroOccurrence({
      ...options,
      definition: target,
      occurrenceId: call.occurrenceId,
      visitedMacroIds: nextVisited
    });
    edges.push(createEdge(
      `${stepId}->${call.occurrenceId}:macro`,
      stepId,
      `${call.occurrenceId}:macro`,
      call.mode,
      t(call.mode === "trigger"
        ? "macroForm.macroCallMode.trigger"
        : "macroForm.macroCallMode.wait")
    ));
  });
}

function createMacroCallData({
  expandedOccurrenceIds,
  expandableOccurrenceIds,
  index,
  macroById,
  occurrenceId,
  step,
  t,
  visitedMacroIds
}: {
  expandedOccurrenceIds: ReadonlySet<string>;
  expandableOccurrenceIds: string[];
  index: number;
  macroById: ReadonlyMap<string, MacroDefinition>;
  occurrenceId: string;
  step: Extract<MacroStep, { type: "macro" }>;
  t: Translator;
  visitedMacroIds: ReadonlySet<string>;
}): MacroStepNodeData["call"] {
  const target = macroById.get(step.macroId);
  const callOccurrenceId = `${occurrenceId}/call:${step.id}:${index}:${step.macroId}`;
  const warnings = target ? getMacroWarnings(target, t) : [t("mindMap.warning.missingMacro")];
  if (target && visitedMacroIds.has(step.macroId)) {
    warnings.push(t("mindMap.warning.cycle"));
  }
  const canExpand = Boolean(target) && !visitedMacroIds.has(step.macroId);
  if (canExpand) {
    expandableOccurrenceIds.push(callOccurrenceId);
  }

  return {
    canExpand,
    isExpanded: canExpand && expandedOccurrenceIds.has(callOccurrenceId),
    mode: step.callMode ?? "wait",
    modeLabel: t((step.callMode ?? "wait") === "trigger"
      ? "macroForm.macroCallMode.trigger"
      : "macroForm.macroCallMode.wait"),
    occurrenceId: callOccurrenceId,
    statusLabel: getCallStatusLabel(target, warnings, t),
    targetEnabled: target?.enabled,
    targetName: target?.name ?? t("macros.unknownMacro"),
    targetStepCount: target?.steps.length,
    targetSummary: target
      ? t("mindMap.stepCount").replace("{count}", String(target.steps.length))
      : undefined,
    warnings
  };
}

function getCallStatusLabel(
  target: MacroDefinition | undefined,
  warnings: readonly string[],
  t: Translator
): string {
  if (!target) return t("mindMap.status.attention");
  if (!target.enabled) return t("mindMap.status.disabled");
  return t(warnings.length > 0 ? "mindMap.status.attention" : "mindMap.status.enabled");
}

function getStepTypeLabel(stepType: MacroStep["type"], t: Translator): string {
  switch (stepType) {
    case "key": return t("macroForm.addKey");
    case "click": return t("macroForm.addClick");
    case "delay": return t("macroForm.addDelay");
    case "macro": return t("macroForm.addMacro");
  }
}

function addCallWarning(
  nodes: MacroMindMapNode[],
  edges: MacroMindMapEdge[],
  sourceId: string,
  occurrenceId: string,
  warning: { detail: string; title: string },
  nodeHeights: ReadonlyMap<string, number>,
  t: Translator
): void {
  const warningId = `${occurrenceId}:warning`;
  nodes.push(createNode(warningId, "macroWarning", {
    ariaLabel: `${warning.title}. ${warning.detail}`,
    detail: warning.detail,
    kind: "macroWarning",
    title: warning.title,
    tone: "warning"
  }, nodeHeights));
  edges.push(createEdge(
    `${sourceId}->${warningId}`,
    sourceId,
    warningId,
    "warning",
    t("mindMap.warning.title")
  ));
}

function createSettingsFields(
  definition: MacroDefinition,
  roleById: ReadonlyMap<string, Role>,
  t: Translator
): MacroSettingsNodeData["fields"] {
  const roleNames = (roleIds: string[]): string => roleIds.length > 0
    ? roleIds.map((roleId) => roleById.get(roleId)?.name ?? t("macros.unknownRole")).join(", ")
    : t("macroForm.noRoleSelected");
  const shortcutSources = definition.shortcutSourceScope.type === "all_execution_roles"
    ? t("macroForm.shortcutScope.allExecutionRoles")
    : roleNames(definition.shortcutSourceScope.roleIds);

  return [
    { label: t("macroForm.roles"), value: roleNames(definition.roleIds) },
    { label: t("macroForm.shortcut"), value: formatMacroShortcut(definition.trigger, t) },
    { label: t("macroForm.shortcutSourceRoles"), value: shortcutSources },
    { label: t("macroForm.activation"), value: formatMacroActivationMode(definition.activationMode, t) },
    { label: t("macroForm.repeat"), value: formatMacroRepeat(definition.repeat, t) }
  ];
}

function getMacroWarnings(definition: MacroDefinition, t: Translator): string[] {
  const warnings: string[] = [];
  if (!definition.enabled) {
    warnings.push(t("mindMap.warning.disabled"));
  }
  if (definition.roleIds.length === 0) {
    warnings.push(t("mindMap.warning.unassigned"));
  }
  return warnings;
}

function createNode<T extends MacroMindMapNodeData>(
  id: string,
  type: T["kind"],
  data: T,
  nodeHeights: ReadonlyMap<string, number>
): MacroMindMapNode {
  const size = type === "macroStep" && data.kind === "macroStep" && data.call
    ? estimatedMacroCallNodeSize
    : estimatedNodeSizeByKind[type];
  const height = nodeHeights.get(id) ?? size.height;
  return { data, height, id, position: { x: 0, y: 0 }, type, width: size.width };
}

function createEdge(
  id: string,
  source: string,
  target: string,
  kind: MacroMindMapEdgeKind,
  label?: string
): MacroMindMapEdge {
  return { id, kind, label, source, target };
}

function layoutNodes(nodes: MacroMindMapNode[], edges: MacroMindMapEdge[]): MacroMindMapNode[] {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    edgesep: 16,
    marginx: 0,
    marginy: 0,
    nodesep: 28,
    rankdir: "TB",
    ranksep: 32
  });

  nodes.forEach((node) => graph.setNode(node.id, { height: node.height, width: node.width }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target, {
    weight: edge.kind === "sequence" ? 5 : edge.kind === "settings" ? 1 : 2
  }));
  dagre.layout(graph);

  return nodes.map((node) => {
    const layout = graph.node(node.id) as { x: number; y: number };
    return {
      ...node,
      position: {
        x: layout.x - node.width / 2,
        y: layout.y - node.height / 2
      }
    };
  });
}

function getNodeBounds(nodes: MacroMindMapNode[]): MacroMindMapBounds {
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.position.y + node.height));
  return { height: bottom - top, width: right - left, x: left, y: top };
}

function toRootDefinition(form: MacroFormState): MacroDefinition {
  return {
    activationMode: form.activationMode,
    enabled: form.enabled,
    id: form.id ?? "__draft__",
    isCurrent: true,
    name: form.name,
    repeat: form.repeat,
    roleIds: form.roleIds,
    shortcutSourceScope: form.shortcutSourceScope,
    steps: form.steps,
    trigger: form.trigger
  };
}

function toMacroDefinition(macro: Macro): MacroDefinition {
  return {
    activationMode: macro.activationMode,
    enabled: macro.enabled,
    id: macro.id,
    isCurrent: false,
    name: macro.name,
    repeat: macro.repeat,
    roleIds: macro.roleIds,
    shortcutSourceScope: macro.shortcutSourceScope,
    steps: macro.steps,
    trigger: macro.trigger
  };
}
