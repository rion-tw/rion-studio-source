import { FoldVertical, Network, Scan } from "lucide-react";
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type ReactFlowInstance
} from "@xyflow/react";

import type { MacroFormState } from "../../app/types";
import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import type { Macro, Role } from "../../../../shared/types";
import {
  MacroRootNode,
  MacroSettingsNode,
  MacroStepNode,
  MacroWarningNode,
  type MacroMindMapCanvasNode,
  type MacroMindMapCanvasNodeData
} from "./MacroMindMapNodes";
import {
  buildMacroMindMap,
  type MacroMindMapEdge,
  type MacroMindMapNodeData,
  type MacroMindMapModel
} from "./macroMindMapModel";
import { calculateMacroMindMapViewport } from "./macroMindMapViewport";

interface MacroMindMapPanelProps {
  form: MacroFormState;
  macros: Macro[];
  onSelectStep: (stepId: string) => void;
  roles: Role[];
  selectedStepId?: string;
  t: Translator;
}

const macroMindMapNodeTypes = {
  macroRoot: MacroRootNode,
  macroSettings: MacroSettingsNode,
  macroStep: MacroStepNode,
  macroWarning: MacroWarningNode
};

export function MacroMindMapPanel({
  form,
  macros,
  onSelectStep,
  roles,
  selectedStepId,
  t
}: MacroMindMapPanelProps): JSX.Element {
  const [expandedOccurrenceIds, setExpandedOccurrenceIds] = useState<Set<string>>(() => new Set());
  const [fitRevision, setFitRevision] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const model = useMemo(() => buildMacroMindMap({
    expandedOccurrenceIds,
    form,
    macros,
    roles,
    t
  }), [expandedOccurrenceIds, form, macros, roles, t]);

  const toggleOccurrence = useCallback((occurrenceId: string): void => {
    if (!occurrenceId) return;
    setExpandedOccurrenceIds((current) => {
      const next = new Set(current);
      if (next.has(occurrenceId)) {
        for (const expandedId of next) {
          if (expandedId === occurrenceId || expandedId.startsWith(`${occurrenceId}/`)) {
            next.delete(expandedId);
          }
        }
      } else {
        next.add(occurrenceId);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback((): void => {
    setExpandedOccurrenceIds(new Set());
  }, []);

  const requestFit = useCallback((): void => {
    setFitRevision((current) => current + 1);
  }, []);

  return (
    <MindMapFrame
      fitRevision={fitRevision}
      model={model}
      selectedNodeId={selectedNodeId}
      selectedStepId={selectedStepId}
      t={t}
      onCollapseAll={collapseAll}
      onResetView={requestFit}
      onSelectNode={setSelectedNodeId}
      onSelectStep={onSelectStep}
      onToggleOccurrence={toggleOccurrence}
    />
  );
}

interface MindMapFrameProps {
  fitRevision: number;
  model: MacroMindMapModel;
  onCollapseAll: () => void;
  onResetView: () => void;
  onSelectNode: (nodeId: string | undefined) => void;
  onSelectStep: (stepId: string) => void;
  onToggleOccurrence: (occurrenceId: string) => void;
  selectedNodeId?: string;
  selectedStepId?: string;
  t: Translator;
}

function MindMapFrame({
  fitRevision,
  model,
  onCollapseAll,
  onResetView,
  onSelectNode,
  onSelectStep,
  onToggleOccurrence,
  selectedNodeId,
  selectedStepId,
  t
}: MindMapFrameProps): JSX.Element {
  const summary = t("mindMap.summary")
    .replace("{steps}", String(model.stepCount))
    .replace("{calls}", String(model.callCount));

  return (
    <Surface
      className="overflow-hidden"
      data-macro-mind-map="inline"
      padding="none"
      radius="md"
      variant="inset"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border/50 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-activity/12 text-activity">
          <Network size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-body font-semibold text-foreground">
            {t("mindMap.title")}
          </h2>
          <p className="truncate text-caption font-medium text-muted-foreground" title={summary}>{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={t("mindMap.collapseAll")}
            disabled={model.expandedOccurrenceCount === 0}
            size="icon"
            title={t("mindMap.collapseAll")}
            type="button"
            variant="ghost"
            onClick={onCollapseAll}
          >
            <FoldVertical size={15} />
          </Button>
          <Button
            aria-label={t("mindMap.resetView")}
            size="icon"
            title={t("mindMap.resetView")}
            type="button"
            variant="ghost"
            onClick={onResetView}
          >
            <Scan size={15} />
          </Button>
        </div>
      </header>

      <MindMapCanvas
        fitRevision={fitRevision}
        model={model}
        selectedNodeId={selectedNodeId}
        selectedStepId={selectedStepId}
        t={t}
        onSelectNode={onSelectNode}
        onSelectStep={onSelectStep}
        onToggleOccurrence={onToggleOccurrence}
      />
    </Surface>
  );
}

function MindMapCanvas({
  fitRevision,
  model,
  onSelectNode,
  onSelectStep,
  onToggleOccurrence,
  selectedNodeId,
  selectedStepId,
  t
}: {
  fitRevision: number;
  model: MacroMindMapModel;
  onSelectNode: (nodeId: string | undefined) => void;
  onSelectStep: (stepId: string) => void;
  onToggleOccurrence: (occurrenceId: string) => void;
  selectedNodeId?: string;
  selectedStepId?: string;
  t: Translator;
}): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [instance, setInstance] = useState<ReactFlowInstance<MacroMindMapCanvasNode, Edge> | null>(null);
  const {
    height: boundsHeight,
    width: boundsWidth,
    x: boundsX,
    y: boundsY
  } = model.bounds;
  const viewportPlan = useMemo(() => calculateMacroMindMapViewport(
    { height: boundsHeight, width: boundsWidth, x: boundsX, y: boundsY },
    containerWidth
  ), [
    boundsHeight,
    boundsWidth,
    boundsX,
    boundsY,
    containerWidth
  ]);
  const nodes = useMemo<MacroMindMapCanvasNode[]>(() => model.nodes.map((node) => ({
    ariaLabel: node.data.ariaLabel,
    connectable: false,
    data: {
      ...node.data,
      collapseLabel: t("mindMap.collapseMacro").replace("{name}", getNodeMacroName(node.data)),
      expandLabel: t("mindMap.expandMacro").replace("{name}", getNodeMacroName(node.data)),
      onToggleOccurrence
    } as MacroMindMapCanvasNodeData,
    deletable: false,
    draggable: false,
    focusable: true,
    height: node.height,
    id: node.id,
    position: node.position,
    selected: node.id === selectedNodeId || (
      node.data.kind === "macroStep" &&
      node.data.currentStepId !== undefined &&
      node.data.currentStepId === selectedStepId
    ),
    selectable: true,
    sourcePosition: Position.Bottom,
    style: { height: node.height, width: node.width },
    targetPosition: Position.Top,
    type: node.type,
    width: node.width
  })), [model.nodes, onToggleOccurrence, selectedNodeId, selectedStepId, t]);
  const edges = useMemo<Edge[]>(
    () => model.edges.map(toCanvasEdge),
    [model.edges]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateWidth = (width: number): void => {
      const roundedWidth = Math.round(width);
      if (roundedWidth > 0) {
        setContainerWidth((current) => current === roundedWidth ? current : roundedWidth);
      }
    };
    updateWidth(canvas.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!instance) return;
    void instance.setViewport(viewportPlan.viewport, { duration: 0 });
  }, [fitRevision, instance, model.structureKey, viewportPlan]);

  return (
    <div
      ref={canvasRef}
      aria-label={t("mindMap.canvas")}
      className="w-full"
      data-macro-mind-map-horizontal-overflow={viewportPlan.horizontalOverflow ? "true" : "false"}
      data-macro-mind-map-canvas
      data-macro-mind-map-zoom={viewportPlan.zoom}
      role="region"
      style={{ height: viewportPlan.height }}
    >
      <ReactFlow<MacroMindMapCanvasNode, Edge>
        ariaLabelConfig={{
          "controls.ariaLabel": t("mindMap.controls"),
          "controls.zoomIn.ariaLabel": t("mindMap.zoomIn"),
          "controls.zoomOut.ariaLabel": t("mindMap.zoomOut")
        }}
        defaultViewport={viewportPlan.viewport}
        edges={edges}
        edgesFocusable={false}
        elementsSelectable
        maxZoom={1.8}
        minZoom={0.18}
        nodeTypes={macroMindMapNodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodesFocusable
        panOnDrag
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        onInit={setInstance}
        onNodeClick={(_event, node) => {
          onSelectNode(node.id);
          if (node.data.kind === "macroStep" && node.data.currentStepId) {
            onSelectStep(node.data.currentStepId);
          }
        }}
        onPaneClick={() => onSelectNode(undefined)}
      >
        <Background
          color="hsl(var(--border))"
          gap={22}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls position="bottom-left" showFitView={false} showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function toCanvasEdge(edge: MacroMindMapEdge): Edge {
  const color = edge.kind === "warning"
    ? "hsl(var(--warning))"
    : edge.kind === "wait" || edge.kind === "trigger"
      ? "hsl(var(--activity))"
      : "hsl(var(--muted-foreground) / 0.55)";
  return {
    className: `macro-mind-map-edge macro-mind-map-edge-${edge.kind}`,
    id: edge.id,
    label: edge.label,
    labelBgBorderRadius: 4,
    labelBgPadding: [6, 3],
    labelBgStyle: { fill: "hsl(var(--background) / 0.9)" },
    labelStyle: { fill: "hsl(var(--foreground))", fontSize: 10, fontWeight: 600 },
    markerEnd: { color, height: 14, type: MarkerType.ArrowClosed, width: 14 },
    source: edge.source,
    style: {
      stroke: color,
      strokeDasharray: edge.kind === "trigger" || edge.kind === "settings" ? "6 5" : undefined,
      strokeWidth: edge.kind === "wait" || edge.kind === "trigger" ? 2 : 1.5
    },
    target: edge.target,
    type: "smoothstep"
  };
}

function getNodeMacroName(data: MacroMindMapNodeData): string {
  return data.kind === "macroStep" && data.call ? data.call.targetName : "";
}
