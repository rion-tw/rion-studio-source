import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { v1Case } from "./helpers/v1Parity";

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
    expect(action).toContain('{ "type": "embeddedCreateTab"');
    expect(action).toContain('{ "type": "browserAction"');
    expect(action).not.toContain('{ "type": "createWindow"');
    expect(action).not.toContain('{ "type": "debuggerCommand"');
    expect(action).not.toContain('{ "type": "cookieSet"');
    expect(result).toContain("error: CoreErrorPayload | null");
    expect(resultMap).toContain("export type CoreCommandResultMap");
    const metrics = await readFile("src/shared/generated/CoreEffectMetricsRecord.ts", "utf8");
    expect(metrics).toContain("peakPendingEffectCount: number");
    expect(metrics).toContain("effectAckLatency: LatencySummaryRecord");
    expect(metrics).toContain("launchOperationCount: number");
    expect(metrics).toContain("launchEffectCount: number");
    for (const contract of [event, request, action, result, resultMap]) {
      expect(contract).not.toContain("unknown");
    }
  });

  it("omits the removed workspace resource policy from every generated boundary", async () => {
    const contracts = await Promise.all([
      readFile("src/shared/generated/WorkspaceCreateInputRecord.ts", "utf8"),
      readFile("src/shared/generated/WorkspaceUpdateInputRecord.ts", "utf8"),
      readFile("src/shared/generated/StateLaunchWorkspaceRecord.ts", "utf8"),
      readFile("src/shared/generated/PortableLaunchWorkspaceRecord.ts", "utf8"),
      readFile("src/shared/generated/CoreCommand.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectAction.ts", "utf8"),
      readFile("src/shared/generated/BrowserRoleStatusRecord.ts", "utf8"),
      readFile("src/shared/generated/MacroOverlayViewModelRecord.ts", "utf8"),
      readFile("src/shared/generated/index.ts", "utf8")
    ]);

    for (const contract of contracts) {
      expect(contract).not.toContain("resourcePolicy");
      expect(contract).not.toContain("policyMode");
      expect(contract).not.toContain("StateWorkspaceResourcePolicyRecord");
      expect(contract).not.toContain("ResourceRuntime");
      expect(contract).not.toContain("resourceState");
      expect(contract).not.toContain("cpuThrottleRate");
      expect(contract).not.toContain("resourcePressureLevel");
      expect(contract).not.toContain("resourceReason");
    }
  });
});

describe("Rust addon build verification", () => {
  it("builds locked dev and release cdylibs into the platform-specific native resource", async () => {
    const [script, workflow, packageJsonSource] = await Promise.all([
      readFile("scripts/buildRustCore.mjs", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("package.json", "utf8")
    ]);

    expect(script).toContain('cliArguments[0] !== "--release"');
    expect(script).toContain('const cargoProfileDirectory = release ? "release" : "debug"');
    expect(script).toContain('...(release ? ["--release"] : [])');
    expect(script).toContain('`${process.platform}-${process.arch}`');
    expect(script).toContain('"rion-core.node"');
    expect(script).toContain('process.platform === "darwin"');
    expect(script).toContain('"/usr/bin/codesign"');
    expect(script).toContain('["--force", "--sign", "-", destination]');
    v1Case("platform-effect-lifecycle-5f80733882ba", () => {
      const packageJson = JSON.parse(packageJsonSource) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts["build:rust"]).toBe("node scripts/buildRustCore.mjs");
      expect(packageJson.scripts["build:rust:release"]).toBe(
        "node scripts/buildRustCore.mjs --release"
      );
      expect(packageJson.scripts.dev).toContain("pnpm run build:rust &&");
      expect(packageJson.scripts["dev:release"]).toContain("pnpm run build:rust:release &&");
      expect(packageJson.scripts["verify:rust"]).toContain("scripts/verifyRustCore.mjs");
      expect(workflow).toContain("os: windows-latest");
      expect(workflow).toContain("pnpm run build:rust:release && pnpm run verify:rust");
      expect(workflow).not.toContain("pnpm run build:rust && pnpm run verify:rust");
      expect(script).toContain('`${process.platform}-${process.arch}`');
    });
  });

  it("loads the packaged addon with Electron through the generic command/effect surface", async () => {
    const [packaged, core] = await Promise.all([
      readFile("scripts/verifyPackagedRustCore.mjs", "utf8"),
      readFile("scripts/verifyRustCore.mjs", "utf8")
    ]);

    expect(packaged).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(core).not.toContain("matchCdnUrl");
    expect(core).not.toContain("externalProcessLaunch");
    expect(core).not.toContain("externalProcessExited");
    expect(core).toContain('type: "embeddedKeyPrepare"');
    expect(core).toContain('type: "embeddedKeysHeld"');
    expect(core).not.toContain("core.connectExternalChromeCdp(");
    expect(core).not.toContain("core.prepareEmbeddedKeyTransition(");
    expect(core).toContain("dispatchCoreEffectResults");
  });

});
