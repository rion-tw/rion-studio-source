import { FoldVertical, Network, Scan, ZoomIn, ZoomOut } from "lucide-react";
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
  MarkerType,
  Position,
  ReactFlow,
  type BuiltInEdge,
  type NodeChange,
  type ReactFlowInstance
} from "@xyflow/react";

import type { MacroFormState } from "../../app/types";
import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
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
import { calculateMacroMindMapFocus } from "./macroMindMapFocus";
import { calculateMacroMindMapViewport } from "./macroMindMapViewport";

interface MacroMindMapPanelProps {
  form: MacroFormState;
  macros: Macro[];
  onClearStepSelection: () => void;
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

interface NodeHeightMeasurement {
  height: number;
  id: string;
}

export function MacroMindMapPanel({
  form,
  macros,
  onClearStepSelection,
  onSelectStep,
  roles,
  selectedStepId,
  t
}: MacroMindMapPanelProps): JSX.Element {
  const [expandedOccurrenceIds, setExpandedOccurrenceIds] = useState<Set<string>>(() => new Set());
  const [fitRevision, setFitRevision] = useState(0);
  const [hoveredNodeId, setHoveredNodeId] = useState<string>();
  const [nodeHeights, setNodeHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const model = useMemo(() => buildMacroMindMap({
    expandedOccurrenceIds,
    form,
    macros,
    nodeHeights,
    roles,
    t
  }), [expandedOccurrenceIds, form, macros, nodeHeights, roles, t]);
  const selectedFocusNodeId = selectedNodeId ?? model.nodes.find((node) => (
    node.data.kind === "macroStep" && node.data.currentStepId === selectedStepId
  ))?.id;
  const activeNodeId = hoveredNodeId ?? selectedFocusNodeId;

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

  const recordNodeHeights = useCallback((measurements: readonly NodeHeightMeasurement[]): void => {
    setNodeHeights((current) => {
      const next = new Map(current);
      let changed = false;
      for (const measurement of measurements) {
        const height = Math.ceil(measurement.height);
        if (height > 0 && next.get(measurement.id) !== height) {
          next.set(measurement.id, height);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  return (
    <MindMapFrame
      fitRevision={fitRevision}
      activeNodeId={activeNodeId}
      model={model}
      selectedNodeId={selectedNodeId}
      selectedStepId={selectedStepId}
      t={t}
      onCollapseAll={collapseAll}
      onHoverNode={setHoveredNodeId}
      onNodeHeightsChange={recordNodeHeights}
      onPaneClick={() => {
        setHoveredNodeId(undefined);
        setSelectedNodeId(undefined);
        onClearStepSelection();
      }}
      onResetView={requestFit}
      onSelectNode={setSelectedNodeId}
      onSelectStep={onSelectStep}
      onToggleOccurrence={toggleOccurrence}
    />
  );
}

interface MindMapFrameProps {
  activeNodeId?: string;
  fitRevision: number;
  model: MacroMindMapModel;
  onCollapseAll: () => void;
  onHoverNode: (nodeId: string | undefined) => void;
  onNodeHeightsChange: (measurements: readonly NodeHeightMeasurement[]) => void;
  onPaneClick: () => void;
  onResetView: () => void;
  onSelectNode: (nodeId: string | undefined) => void;
  onSelectStep: (stepId: string) => void;
  onToggleOccurrence: (occurrenceId: string) => void;
  selectedNodeId?: string;
  selectedStepId?: string;
  t: Translator;
}

function MindMapFrame({
  activeNodeId,
  fitRevision,
  model,
  onCollapseAll,
  onHoverNode,
  onNodeHeightsChange,
  onPaneClick,
  onResetView,
  onSelectNode,
  onSelectStep,
  onToggleOccurrence,
  selectedNodeId,
  selectedStepId,
  t
}: MindMapFrameProps): JSX.Element {
  const [instance, setInstance] = useState<ReactFlowInstance<MacroMindMapCanvasNode, BuiltInEdge> | null>(null);
  const summary = t("mindMap.summary")
    .replace("{steps}", String(model.stepCount))
    .replace("{calls}", String(model.callCount));

  return (
    <Surface
      className="relative"
      data-macro-mind-map="inline"
      padding="none"
      radius="md"
      variant="inset"
    >
      <header className="macro-mind-map-toolbar sticky top-0 z-[var(--layer-decoration)] flex flex-wrap items-center gap-3 rounded-t-md border-b border-border/50 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-activity/12 text-activity">
          <Network size={18} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-body font-semibold text-foreground">{t("mindMap.title")}</h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-activity/20 bg-activity/10 px-2 py-1 text-micro font-bold leading-none text-activity">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-activity" />
              {t("mindMap.livePreview")}
            </span>
          </div>
          <p className="sr-only">{summary}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro font-semibold text-muted-foreground">
            <span className="rounded-full border border-border/40 bg-background/20 px-2 py-0.5">
              {t("mindMap.stepCount").replace("{count}", String(model.stepCount))}
            </span>
            <span className="rounded-full border border-border/40 bg-background/20 px-2 py-0.5">
              {t("mindMap.callCount").replace("{count}", String(model.callCount))}
            </span>
          </div>
        </div>
        <div className="glass-control flex shrink-0 items-center gap-0.5 rounded-md border border-border/45 p-0.5 shadow-sm">
          <Button
            aria-label={t("mindMap.zoomOut")}
            disabled={!instance}
            size="icon"
            title={t("mindMap.zoomOut")}
            type="button"
            variant="ghost"
            onClick={() => { void instance?.zoomOut({ duration: 0 }); }}
          >
            <ZoomOut size={15} />
          </Button>
          <Button
            aria-label={t("mindMap.zoomIn")}
            disabled={!instance}
            size="icon"
            title={t("mindMap.zoomIn")}
            type="button"
            variant="ghost"
            onClick={() => { void instance?.zoomIn({ duration: 0 }); }}
          >
            <ZoomIn size={15} />
          </Button>
          <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border/50" />
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
        activeNodeId={activeNodeId}
        fitRevision={fitRevision}
        instance={instance}
        model={model}
        selectedNodeId={selectedNodeId}
        selectedStepId={selectedStepId}
        t={t}
        onHoverNode={onHoverNode}
        onInit={setInstance}
        onNodeHeightsChange={onNodeHeightsChange}
        onPaneClick={onPaneClick}
        onSelectNode={onSelectNode}
        onSelectStep={onSelectStep}
        onToggleOccurrence={onToggleOccurrence}
      />
    </Surface>
  );
}

function MindMapCanvas({
  activeNodeId,
  fitRevision,
  instance,
  model,
  onHoverNode,
  onInit,
  onNodeHeightsChange,
  onPaneClick,
  onSelectNode,
  onSelectStep,
  onToggleOccurrence,
  selectedNodeId,
  selectedStepId,
  t
}: {
  activeNodeId?: string;
  fitRevision: number;
  instance: ReactFlowInstance<MacroMindMapCanvasNode, BuiltInEdge> | null;
  model: MacroMindMapModel;
  onHoverNode: (nodeId: string | undefined) => void;
  onInit: (instance: ReactFlowInstance<MacroMindMapCanvasNode, BuiltInEdge>) => void;
  onNodeHeightsChange: (measurements: readonly NodeHeightMeasurement[]) => void;
  onPaneClick: () => void;
  onSelectNode: (nodeId: string | undefined) => void;
  onSelectStep: (stepId: string) => void;
  onToggleOccurrence: (occurrenceId: string) => void;
  selectedNodeId?: string;
  selectedStepId?: string;
  t: Translator;
}): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
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
  const focus = useMemo(
    () => calculateMacroMindMapFocus(model, activeNodeId),
    [activeNodeId, model]
  );
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
    id: node.id,
    className: cn(
      "macro-mind-map-node",
      focus && focus.nodeIds.has(node.id) && "macro-mind-map-node-focused",
      focus && !focus.nodeIds.has(node.id) && "macro-mind-map-node-dimmed",
      node.id === activeNodeId && "macro-mind-map-node-active"
    ),
    position: node.position,
    selected: node.id === selectedNodeId || (
      node.data.kind === "macroStep" &&
      node.data.currentStepId !== undefined &&
      node.data.currentStepId === selectedStepId
    ),
    selectable: true,
    sourcePosition: Position.Bottom,
    style: { width: node.width },
    targetPosition: Position.Top,
    type: node.type,
    width: node.width
  })), [activeNodeId, focus, model.nodes, onToggleOccurrence, selectedNodeId, selectedStepId, t]);
  const edges = useMemo<BuiltInEdge[]>(
    () => model.edges.map((edge) => toCanvasEdge(edge, focus)),
    [focus, model.edges]
  );
  const handleNodesChange = useCallback((changes: NodeChange<MacroMindMapCanvasNode>[]): void => {
    const measurements = changes.flatMap((change) => (
      change.type === "dimensions" && change.dimensions?.height
        ? [{ height: change.dimensions.height, id: change.id }]
        : []
    ));
    if (measurements.length > 0) onNodeHeightsChange(measurements);
  }, [onNodeHeightsChange]);

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
      <ReactFlow<MacroMindMapCanvasNode, BuiltInEdge>
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
        onInit={onInit}
        onNodesChange={handleNodesChange}
        onNodeClick={(_event, node) => {
          onSelectNode(node.id);
          if (node.data.kind === "macroStep" && node.data.currentStepId) {
            onSelectStep(node.data.currentStepId);
          }
        }}
        onNodeMouseEnter={(_event, node) => onHoverNode(node.id)}
        onNodeMouseLeave={() => onHoverNode(undefined)}
        onPaneClick={() => {
          onSelectNode(undefined);
          onPaneClick();
        }}
      >
        <Background
          color="hsl(var(--border) / 0.48)"
          gap={24}
          size={1}
          variant={BackgroundVariant.Dots}
        />
      </ReactFlow>
    </div>
  );
}

function toCanvasEdge(
  edge: MacroMindMapEdge,
  focus: ReturnType<typeof calculateMacroMindMapFocus>
): BuiltInEdge {
  const isFocused = focus?.edgeIds.has(edge.id) ?? false;
  const isDimmed = Boolean(focus) && !isFocused;
  const color = isFocused
    ? "hsl(var(--activity))"
    : edge.kind === "warning"
    ? "hsl(var(--warning-foreground))"
    : edge.kind === "wait" || edge.kind === "trigger"
      ? "hsl(var(--activity))"
      : "hsl(var(--muted-foreground) / 0.55)";
  return {
    className: cn(
      "macro-mind-map-edge",
      `macro-mind-map-edge-${edge.kind}`,
      isFocused && "macro-mind-map-edge-focused",
      isDimmed && "macro-mind-map-edge-dimmed"
    ),
    id: edge.id,
    label: edge.label,
    labelBgBorderRadius: 10,
    labelBgPadding: [8, 4],
    labelBgStyle: { fill: "hsl(var(--glass-popover))" },
    labelStyle: { fill: "hsl(var(--foreground))", fontSize: 10, fontWeight: 650 },
    markerEnd: { color, height: 12, type: MarkerType.ArrowClosed, width: 12 },
    pathOptions: { borderRadius: 18, offset: 20 },
    source: edge.source,
    style: {
      stroke: color,
      strokeDasharray: edge.kind === "trigger" || edge.kind === "settings" ? "6 5" : undefined,
      strokeWidth: isFocused ? 2.4 : edge.kind === "wait" || edge.kind === "trigger" ? 1.8 : 1.35
    },
    target: edge.target,
    type: "smoothstep"
  };
}

function getNodeMacroName(data: MacroMindMapNodeData): string {
  return data.kind === "macroStep" && data.call ? data.call.targetName : "";
}
