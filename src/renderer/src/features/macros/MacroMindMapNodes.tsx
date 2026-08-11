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
          aria-hidden="true"
          className="macro-mind-map-handle pointer-events-none"
          isConnectable={false}
          position={Position.Top}
          type="target"
        />
      ) : null}
      <Handle
        aria-hidden="true"
        className="macro-mind-map-handle pointer-events-none"
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
      "macro-mind-map-card macro-mind-map-root glass-panel-strong relative grid w-full content-start gap-3 rounded-lg border border-border/55 p-4 text-foreground",
      selected && "macro-mind-map-card-selected"
    )} data-macro-mind-map-node-kind="macroRoot">
      <span aria-hidden="true" className="macro-mind-map-node-rail" />
      <NodeHandles hasTarget={!root.isCurrent} />
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="text-micro font-bold uppercase tracking-[0.14em] text-muted-foreground">
          {root.scopeLabel}
        </span>
        <StatusPill label={root.statusLabel} tone={root.enabled ? "enabled" : "disabled"} />
      </div>
      <div className="flex min-w-0 items-start gap-3">
        <span className="macro-mind-map-root-icon grid size-10 shrink-0 place-items-center rounded-lg text-activity">
          <Workflow size={19} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-heading font-semibold leading-6" title={root.name}>{root.name}</p>
          <p className="mt-1 text-caption font-medium text-muted-foreground">{root.stepCountLabel}</p>
        </div>
      </div>
      {root.warnings.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5 border-t border-border/40 pt-2.5">
          {root.warnings.map((warning) => (
            <span
              key={warning}
              className="max-w-full break-words rounded-full border border-warning-foreground/20 bg-warning/45 px-2 py-0.5 text-micro font-semibold text-warning-foreground"
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
      "macro-mind-map-card macro-mind-map-settings glass-control relative grid w-full content-start rounded-lg border border-border/50 text-foreground",
      selected && "macro-mind-map-card-selected"
    )} data-macro-mind-map-node-kind="macroSettings">
      <span aria-hidden="true" className="macro-mind-map-node-rail" />
      <NodeHandles />
      <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-3 text-body font-semibold">
        <span className="grid size-7 place-items-center rounded-md bg-muted/45 text-muted-foreground">
          <Settings2 size={14} strokeWidth={1.8} />
        </span>
        <span>{settings.title}</span>
      </div>
      <dl className="divide-y divide-border/35 px-4 py-1.5">
        {settings.fields.map((field) => (
          <div key={field.label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 py-2 text-caption">
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
      "macro-mind-map-card macro-mind-map-step glass-control relative grid w-full content-start gap-3 rounded-lg border border-border/50 p-4 text-foreground",
      selected && "macro-mind-map-card-selected"
    )}
      data-macro-mind-map-current-step={step.currentStepId}
      data-macro-mind-map-node-kind="macroStep"
      data-macro-mind-map-step-type={step.stepType}
    >
      <span aria-hidden="true" className="macro-mind-map-node-rail" />
      <NodeHandles />
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="macro-mind-map-type-icon grid size-8 shrink-0 place-items-center rounded-md">
            <StepIcon size={15} strokeWidth={1.9} />
          </span>
          <span className="truncate text-micro font-bold uppercase tracking-[0.13em] text-muted-foreground">
            {step.stepTypeLabel}
          </span>
        </div>
        <span className="macro-mind-map-step-index shrink-0 rounded-full border border-border/45 px-2 py-1 text-micro font-bold leading-none text-muted-foreground">
          {String(step.index + 1).padStart(2, "0")}
        </span>
      </div>
      <p className="break-words text-body font-semibold leading-5" title={step.detail}>{step.detail}</p>

      {step.call ? (
        <div className="macro-mind-map-call-summary grid min-w-0 gap-2.5 rounded-md border border-border/40 bg-background/20 p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="rounded-full border border-border/45 bg-background/25 px-2 py-1 text-micro font-bold leading-none text-foreground">
              {step.call.modeLabel}
            </span>
            <StatusPill
              label={step.call.statusLabel}
              tone={step.call.targetEnabled === false
                ? "disabled"
                : step.call.warnings.length > 0 ? "attention" : "enabled"}
            />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="break-words text-caption font-semibold text-foreground" title={step.call.targetName}>
                {step.call.targetName}
              </p>
              {step.call.targetSummary ? (
                <p className="mt-0.5 text-micro font-medium text-muted-foreground">{step.call.targetSummary}</p>
              ) : null}
            </div>
            {step.call.warnings.length > 0 ? (
              <AlertTriangle className="shrink-0 text-warning-foreground" size={14} />
            ) : null}
            {step.call.canExpand ? (
              <Button
                aria-expanded={step.call.isExpanded}
                aria-label={step.call.isExpanded ? data.collapseLabel : data.expandLabel}
                className="nodrag nopan shrink-0 rounded-full"
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
          {step.call.warnings.length > 0 ? (
            <p className="break-words border-t border-warning-foreground/15 pt-2 text-micro font-semibold text-warning-foreground" title={step.call.warnings.join(" · ")}>
              {step.call.warnings.join(" · ")}
            </p>
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
      "macro-mind-map-card macro-mind-map-warning relative grid w-full content-center gap-2 rounded-lg border bg-background/22 p-4",
      warning.tone === "warning"
        ? "border-warning-foreground/25 text-warning-foreground"
        : "border-border/55 text-muted-foreground",
      selected && "macro-mind-map-card-selected"
    )} data-macro-mind-map-node-kind="macroWarning">
      <span aria-hidden="true" className="macro-mind-map-node-rail" />
      <NodeHandles />
      <div className="flex items-center gap-2.5 text-caption font-semibold">
        <span className="grid size-7 place-items-center rounded-md bg-warning/45">
          <AlertTriangle size={14} strokeWidth={1.9} />
        </span>
        <span>{warning.title}</span>
      </div>
      <p className="break-words text-micro font-medium leading-4" title={warning.detail}>{warning.detail}</p>
    </div>
  );
});

function StatusPill({ label, tone }: { label: string; tone: "attention" | "disabled" | "enabled" }): JSX.Element {
  return (
    <span
      className="macro-mind-map-status-pill inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-micro font-bold leading-none"
      data-tone={tone}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
