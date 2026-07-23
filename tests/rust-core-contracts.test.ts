import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("generated Rust core contracts", () => {
  it("exports a typed browser-action union instead of unvalidated payload JSON", async () => {
    const [action, request, index] = await Promise.all([
      readFile("src/shared/generated/BrowserAction.ts", "utf8"),
      readFile("src/shared/generated/BrowserActionRequest.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    expect(action).toContain('{ "type": "focus" }');
    expect(action).toContain('{ "type": "debugger"');
    expect(action).toContain("paramsJson: string");
    expect(request).toContain("action: BrowserAction");
    expect(request).not.toContain("payload_json");
    expect(index).toContain('export type { BrowserAction } from "./BrowserAction";');
  });

  it("carries bounded browser action batches through the generated core event union", async () => {
    const contract = await readFile("src/shared/generated/CoreEvent.ts", "utf8");

    expect(contract).toContain('{ "type": "browserActions"');
    expect(contract).toContain("actions: Array<BrowserActionRequest>");
  });

  it("generates the generic operation effect and command-result protocol", async () => {
    const [event, request, action, result, resultMap] = await Promise.all([
      readFile("src/shared/generated/CoreEvent.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectRequest.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectResult.ts", "utf8"),
      readFile("src/shared/generated/CoreCommandResultMap.ts", "utf8")
    ]);

    expect(event).toContain('{ "type": "coreEffects"');
    expect(request).toContain("effectId: string");
    expect(request).toContain("operationId: string");
    expect(request).toContain("deadlineMs: number");
    expect(action).toContain('{ "type": "createWindow"');
    expect(action).toContain('{ "type": "debuggerCommand"');
    expect(result).toContain("error: CoreErrorPayload | null");
    expect(resultMap).toContain("export type CoreCommandResultMap");
    for (const contract of [event, request, action, result, resultMap]) {
      expect(contract).not.toContain("unknown");
    }
  });
});

describe("Rust addon build verification", () => {
  it("builds a locked release cdylib into the platform-specific native resource", async () => {
    const script = await readFile("scripts/buildRustCore.mjs", "utf8");

    expect(script).toContain('"--locked", "--release", "-p", "rion-node"');
    expect(script).toContain('`${process.platform}-${process.arch}`');
    expect(script).toContain('"rion-core.node"');
  });

  it("loads the packaged addon with Electron and verifies process and CDP integration", async () => {
    const [packaged, core] = await Promise.all([
      readFile("scripts/verifyPackagedRustCore.mjs", "utf8"),
      readFile("scripts/verifyRustCore.mjs", "utf8")
    ]);

    expect(packaged).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(core).toContain("externalProcessLaunch");
    expect(core).toContain("externalProcessExited");
    expect(core).toContain("connectExternalChromeCdp");
    expect(core).toContain("Runtime.executionContextCreated");
    expect(core).toContain("prepareEmbeddedKeyTransition");
    expect(core).toContain("hasEmbeddedHeldKeys");
    expect(core).toContain("dispatchCoreEffectResults");
  });
});
