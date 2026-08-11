import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock3,
  GitBranch,
  Keyboard,
  MousePointer2,
  Settings2,
  Workflow
} from "lucide-react";
import { memo, type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type {
  MacroMindMapNodeData,
  MacroMindMapNodeKind,
  MacroRootNodeData,
  MacroSettingsNodeData,
  MacroStepNodeData,
  MacroWarningNodeData
} from "./macroMindMapModel";

export type MacroMindMapCanvasNodeData = MacroMindMapNodeData & {
  collapseLabel: string;
  expandLabel: string;
  onToggleOccurrence: (occurrenceId: string) => void;
} & Record<string, unknown>;

export type MacroMindMapCanvasNode = Node<
  MacroMindMapCanvasNodeData,
  MacroMindMapNodeKind
>;

type MindMapNodeProps = NodeProps<MacroMindMapCanvasNode>;

function NodeHandles({ hasTarget = true }: { hasTarget?: boolean }): JSX.Element {
  return (
    <>
      {hasTarget ? (
        <Handle
          className="pointer-events-none opacity-0"
          isConnectable={false}
          position={Position.Top}
          type="target"
        />
      ) : null}
      <Handle
        className="pointer-events-none opacity-0"
        isConnectable={false}
        position={Position.Bottom}
        type="source"
      />
    </>
  );
}

export const MacroRootNode = memo(function MacroRootNode({ data, selected }: MindMapNodeProps): JSX.Element {
  const root = data as MacroRootNodeData & MacroMindMapCanvasNodeData;
  return (
    <div className={cn(
      "glass-panel-strong grid w-full content-start gap-2 rounded-lg border border-border/55 p-3 text-foreground shadow-sm",
      selected && "border-activity/70 ring-2 ring-activity/30"
    )} data-macro-mind-map-node-kind="macroRoot">
      <NodeHandles hasTarget={!root.isCurrent} />
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-activity/12 text-activity">
          <Workflow size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", root.enabled ? "bg-success-foreground" : "bg-muted-foreground/45")}
            />
            <p className="break-words text-body font-semibold" title={root.name}>{root.name}</p>
          </div>
          <p className="mt-1 text-caption font-medium text-muted-foreground">
            {root.scopeLabel} · {root.stepCountLabel}
          </p>
        </div>
      </div>
      {root.warnings.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {root.warnings.map((warning) => (
            <span
              key={warning}
              className="max-w-full break-words rounded-full bg-warning/55 px-2 py-0.5 text-micro font-semibold text-warning-foreground"
              title={warning}
            >
              {warning}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export const MacroSettingsNode = memo(function MacroSettingsNode({ data, selected }: MindMapNodeProps): JSX.Element {
  const settings = data as MacroSettingsNodeData & MacroMindMapCanvasNodeData;
  return (
    <div className={cn(
      "glass-control grid w-full content-start gap-2.5 rounded-md border border-border/50 p-3 text-foreground",
      selected && "border-activity/65 ring-2 ring-activity/25"
    )} data-macro-mind-map-node-kind="macroSettings">
      <NodeHandles />
      <div className="flex items-center gap-2 text-body font-semibold">
        <Settings2 className="text-muted-foreground" size={15} />
        <span>{settings.title}</span>
      </div>
      <dl className="grid gap-1.5">
        {settings.fields.map((field) => (
          <div key={field.label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 text-caption">
            <dt className="break-words font-medium text-muted-foreground" title={field.label}>{field.label}</dt>
            <dd className="break-words text-right font-semibold text-foreground" title={field.value}>{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
});

const stepIconByType = {
  click: MousePointer2,
  delay: Clock3,
  key: Keyboard,
  macro: GitBranch
} as const;

export const MacroStepNode = memo(function MacroStepNode({ data, selected }: MindMapNodeProps): JSX.Element {
  const step = data as MacroStepNodeData & MacroMindMapCanvasNodeData;
  const StepIcon = stepIconByType[step.stepType];
  return (
    <div className={cn(
      "glass-control grid w-full content-start gap-2 rounded-md border border-border/50 p-3 text-foreground",
      step.stepType === "macro" && "border-activity/35",
      selected && "border-activity/70 ring-2 ring-activity/30"
    )}
      data-macro-mind-map-current-step={step.currentStepId}
      data-macro-mind-map-node-kind="macroStep"
    >
      <NodeHandles />
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-activity/10 text-activity">
          <StepIcon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-micro font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {String(step.index + 1).padStart(2, "0")}
          </p>
          <p className="break-words text-caption font-semibold leading-5" title={step.detail}>
            {step.detail}
          </p>
        </div>
      </div>

      {step.call ? (
        <div className="flex min-w-0 items-center gap-2 border-t border-border/45 pt-2">
          <div className="min-w-0 flex-1">
            <p className="break-words text-micro font-semibold text-muted-foreground" title={step.call.targetName}>
              {step.call.targetName}
              {step.call.targetSummary ? ` · ${step.call.targetSummary}` : ""}
            </p>
            {step.call.warnings.length > 0 ? (
              <p className="break-words text-micro font-semibold text-warning-foreground" title={step.call.warnings.join(" · ")}>
                {step.call.warnings.join(" · ")}
              </p>
            ) : null}
          </div>
          {step.call.canExpand ? (
            <Button
              aria-expanded={step.call.isExpanded}
              aria-label={step.call.isExpanded ? data.collapseLabel : data.expandLabel}
              className="nodrag nopan"
              size="icon"
              title={step.call.isExpanded ? data.collapseLabel : data.expandLabel}
              type="button"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                data.onToggleOccurrence(step.call?.occurrenceId ?? "");
              }}
            >
              {step.call.isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export const MacroWarningNode = memo(function MacroWarningNode({ data, selected }: MindMapNodeProps): JSX.Element {
  const warning = data as MacroWarningNodeData & MacroMindMapCanvasNodeData;
  return (
    <div className={cn(
      "grid w-full content-center gap-1.5 rounded-md border p-3",
      warning.tone === "warning"
        ? "border-warning/35 bg-warning/55 text-warning-foreground"
        : "border-border/55 bg-muted/25 text-muted-foreground",
      selected && "ring-2 ring-activity/30"
    )} data-macro-mind-map-node-kind="macroWarning">
      <NodeHandles />
      <div className="flex items-center gap-2 text-caption font-semibold">
        <AlertTriangle size={14} />
        <span>{warning.title}</span>
      </div>
      <p className="break-words text-micro font-medium leading-4" title={warning.detail}>{warning.detail}</p>
    </div>
  );
});
