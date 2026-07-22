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
  });
});
