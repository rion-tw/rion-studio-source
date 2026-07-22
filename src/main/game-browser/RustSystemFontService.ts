import type { SystemFontFamily } from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

/** Thin IPC adapter; platform discovery, normalization, fallback, and caching live in Rust. */
export class RustSystemFontService {
  constructor(private readonly core: Pick<AppCoreClient, "invoke">) {}

  listFonts(): Promise<SystemFontFamily[]> {
    return this.core.invoke({ type: "systemFontsList" });
  }
}
