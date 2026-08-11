import type {
  MacroMindMapEdge,
  MacroMindMapModel
} from "./macroMindMapModel";

export interface MacroMindMapFocus {
  edgeIds: ReadonlySet<string>;
  nodeIds: ReadonlySet<string>;
}

export function calculateMacroMindMapFocus(
  model: Pick<MacroMindMapModel, "edges" | "nodes">,
  activeNodeId?: string
): MacroMindMapFocus | undefined {
  if (!activeNodeId || !model.nodes.some((node) => node.id === activeNodeId)) {
    return undefined;
  }

  const nodeIds = new Set<string>([activeNodeId]);
  const edgeIds = new Set<string>();
  const incomingByTarget = groupEdges(model.edges, "target");
  const outgoingBySource = groupEdges(model.edges, "source");

  traverseEdges(activeNodeId, incomingByTarget, "source", nodeIds, edgeIds);

  const activeNode = model.nodes.find((node) => node.id === activeNodeId);
  if (activeNode?.data.kind === "macroStep" && activeNode.data.call) {
    const callEdges = (outgoingBySource.get(activeNodeId) ?? []).filter((edge) => (
      edge.kind === "wait" || edge.kind === "trigger" || edge.kind === "warning"
    ));
    for (const edge of callEdges) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.target);
      traverseEdges(edge.target, outgoingBySource, "target", nodeIds, edgeIds);
    }
  }

  return { edgeIds, nodeIds };
}

function groupEdges(
  edges: readonly MacroMindMapEdge[],
  key: "source" | "target"
): Map<string, MacroMindMapEdge[]> {
  const grouped = new Map<string, MacroMindMapEdge[]>();
  for (const edge of edges) {
    const group = grouped.get(edge[key]) ?? [];
    group.push(edge);
    grouped.set(edge[key], group);
  }
  return grouped;
}

function traverseEdges(
  startNodeId: string,
  edgesByNode: ReadonlyMap<string, readonly MacroMindMapEdge[]>,
  nextNodeKey: "source" | "target",
  nodeIds: Set<string>,
  edgeIds: Set<string>
): void {
  const visited = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    for (const edge of edgesByNode.get(nodeId) ?? []) {
      edgeIds.add(edge.id);
      const nextNodeId = edge[nextNodeKey];
      nodeIds.add(nextNodeId);
      if (!visited.has(nextNodeId)) {
        visited.add(nextNodeId);
        queue.push(nextNodeId);
      }
    }
  }
}
