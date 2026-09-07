import type { RendererLogEvent } from "../../shared/types";

export function rendererLogCommand(event: RendererLogEvent) {
  return {
    type: "logsCapture" as const,
    entries: [{
      level: "error" as const,
      source: "renderer" as const,
      event: event.event,
      message: event.message,
      ...(event.stack
        ? {
            error: {
              message: event.message,
              name: event.event,
              stack: event.stack
            }
          }
        : {})
    }]
  };
}
