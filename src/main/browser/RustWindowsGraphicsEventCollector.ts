import type { WindowsGraphicsEventCollectionRecord } from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";

/** Thin diagnostics adapter; Windows event-log access and parsing live in Rust. */
export class RustWindowsGraphicsEventCollector {
  constructor(private readonly core: Pick<AppCoreClient, "invoke">) {}

  collect(since: Date): Promise<WindowsGraphicsEventCollectionRecord> {
    return this.core.invoke({
      type: "windowsGraphicsEventsCollect",
      since: since.toISOString()
    });
  }
}
