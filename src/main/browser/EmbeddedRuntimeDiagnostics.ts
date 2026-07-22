import type { WebContents } from "electron";

import {
  isEmbeddedRuntimeDiagnosticPayload,
  type EmbeddedRuntimeDiagnosticPayload
} from "../../shared/embeddedRuntimeDiagnostics";
import type { LogService } from "../logging/LogService";

export interface EmbeddedRuntimeDiagnosticContext {
  hostId: string;
  kind: "game" | "popup";
  roleId: string;
  workspaceId?: string;
}

interface TrackedContents {
  context: EmbeddedRuntimeDiagnosticContext;
  contents: WebContents;
  lastOsProcessId?: number;
}

type DiagnosticLogger = Pick<LogService, "error" | "info" | "warn">;

export class EmbeddedRuntimeDiagnostics {
  private readonly records = new Map<number, TrackedContents>();

  constructor(private readonly logService: DiagnosticLogger) {}

  attach(context: EmbeddedRuntimeDiagnosticContext, contents: WebContents): void {
    if (contents.isDestroyed() || this.records.has(contents.id)) {
      return;
    }

    const record: TrackedContents = {
      context: { ...context },
      contents,
      lastOsProcessId: this.readProcessId(contents)
    };
    this.records.set(contents.id, record);

    contents.on("did-finish-load", () => {
      record.lastOsProcessId = this.readProcessId(contents) ?? record.lastOsProcessId;
    });
    contents.on("preload-error", (_event, preloadPath, error) => {
      this.logService.error(
        "preload",
        "embedded_preload_error",
        "Failed to load an embedded browser preload script.",
        error,
        { ...this.createLogContext(record), preloadPath }
      );
    });
    contents.on("unresponsive", () => {
      this.logService.warn(
        "browser",
        "embedded_renderer_unresponsive",
        "An embedded game renderer became unresponsive.",
        this.createLogContext(record)
      );
    });
    contents.on("responsive", () => {
      this.logService.info(
        "browser",
        "embedded_renderer_responsive",
        "An embedded game renderer became responsive again.",
        this.createLogContext(record)
      );
    });
    contents.once("destroyed", () => {
      this.records.delete(contents.id);
    });
  }

  handlePageEvent(contents: WebContents, value: unknown): void {
    const record = this.records.get(contents.id);
    if (!record) {
      return;
    }
    if (!isEmbeddedRuntimeDiagnosticPayload(value)) {
      this.logService.warn(
        "browser",
        "embedded_diagnostic_payload_rejected",
        "Rejected an invalid embedded runtime diagnostic payload.",
        this.createLogContext(record)
      );
      return;
    }

    record.lastOsProcessId = this.readProcessId(contents) ?? record.lastOsProcessId;

    if (value.type === "heartbeat") {
      return;
    }
    if (value.type === "webgl") {
      const level = value.event === "context_lost" ? "warn" : "info";
      this.logService[level](
        "browser",
        `embedded_webgl_${value.event}`,
        value.event === "context_lost"
          ? "An embedded game WebGL context was lost."
          : "An embedded game WebGL context was restored.",
        this.createLogContext(record, value)
      );
      return;
    }

    this.logService.info(
      "browser",
      "embedded_page_lifecycle",
      "Embedded game page lifecycle changed.",
      this.createLogContext(record, value)
    );
  }

  handleSuspend(): void {
    // Electron owns suspend/resume; no diagnostic polling remains to pause.
  }

  handleResume(): void {
    // Lifecycle and WebContents responsive/unresponsive events are event-driven.
  }

  getRenderProcessGoneContext(contents: WebContents): Record<string, unknown> | undefined {
    const record = this.records.get(contents.id);
    if (!record) {
      return undefined;
    }
    const processId = record.lastOsProcessId ?? this.readProcessId(contents);
    const affectedRoleIds = processId
      ? [...new Set([...this.records.values()]
          .filter((candidate) => candidate.lastOsProcessId === processId)
          .map((candidate) => candidate.context.roleId))]
      : [record.context.roleId];
    return {
      ...this.createLogContext(record),
      affectedRoleIds
    };
  }

  stop(): void {
    this.records.clear();
  }

  private createLogContext(
    record: TrackedContents,
    payload?: EmbeddedRuntimeDiagnosticPayload
  ): Record<string, unknown> {
    return {
      roleId: record.context.roleId,
      hostId: record.context.hostId,
      ...(record.context.workspaceId ? { workspaceId: record.context.workspaceId } : {}),
      runtimeMode: "embedded",
      kind: record.context.kind,
      webContentsId: record.contents.id,
      osProcessId: record.lastOsProcessId,
      backgroundThrottling: record.contents.isDestroyed()
        ? undefined
        : record.contents.getBackgroundThrottling(),
      ...(payload ? {
          pageEvent: "event" in payload ? payload.event : payload.type,
          sequence: payload.sequence,
          monotonicMs: payload.monotonicMs,
          hasFocus: payload.hasFocus,
          hidden: payload.hidden,
          visibilityState: payload.visibilityState,
          wasDiscarded: payload.wasDiscarded,
          ...(payload.type === "lifecycle" && payload.webglRenderer
            ? { webglRenderer: payload.webglRenderer }
            : {}),
          ...(payload.type === "lifecycle" && payload.webglVendor
            ? { webglVendor: payload.webglVendor }
            : {})
        } : {})
    };
  }

  private readProcessId(contents: WebContents): number | undefined {
    if (contents.isDestroyed()) {
      return undefined;
    }
    const processId = contents.getOSProcessId();
    return processId > 0 ? processId : undefined;
  }
}
