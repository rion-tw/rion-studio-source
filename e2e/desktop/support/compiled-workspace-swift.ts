import { runCompiledMacosSwift } from "./compiled-macos-swift";

/** Compile each Workspace evidence/input helper once per isolated E2E phase. */
export function runWorkspaceSwift(name: "workspace-window-resize" | "workspace-pixels", request: string): Promise<string> {
  return runCompiledMacosSwift(name, [request], 30_000);
}
