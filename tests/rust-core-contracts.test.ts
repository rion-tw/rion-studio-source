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
    expect(action).toContain('{ "type": "key"');
    expect(action).toContain('{ "type": "click"');
    expect(action).not.toContain('{ "type": "evaluate"');
    expect(action).not.toContain('{ "type": "cookies"');
    expect(action).not.toContain('{ "type": "session"');
    expect(action).not.toContain('{ "type": "debugger"');
    expect(request).toContain("action: BrowserAction");
    expect(request).not.toContain("payload_json");
    expect(index).toContain('export type { BrowserAction } from "./BrowserAction";');
  });

  it("restricts generic core effects to app and role web-content targets", async () => {
    const [target, kind] = await Promise.all([
      readFile("src/shared/generated/CoreEffectTarget.ts", "utf8"),
      readFile("src/shared/generated/CoreEffectTargetKind.ts", "utf8")
    ]);

    expect(target).toContain("kind: CoreEffectTargetKind");
    expect(kind).toContain('"app" | "webContents"');
    for (const retired of ["window", "view", "session"]) {
      expect(kind).not.toContain(`"${retired}"`);
    }
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

describe("direct Rust core build verification", () => {
  it("builds the core only through Cargo and the Tauri shell", async () => {
    const [manifest, shellManifest, packageJsonSource, workflow] = await Promise.all([
      readFile("Cargo.toml", "utf8"),
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonSource) as { scripts: Record<string, string> };

    expect(manifest).not.toContain("crates/rion-node");
    expect(manifest).not.toContain("napi-build");
    expect(shellManifest).toContain('rion-core = { path = "../crates/rion-core" }');
    expect(packageJson.scripts.build).toContain("cargo build -p rion-tauri");
    expect(workflow).toContain("pnpm run build");
    expect(workflow).not.toContain("retired native addon");
  });

  it("does not generate the retired addon latency contract", async () => {
    const [model, telemetry, generated] = await Promise.all([
      readFile("crates/rion-core/src/model/mod.rs", "utf8"),
      readFile("crates/rion-core/src/telemetry.rs", "utf8"),
      readFile("src/shared/generated/PerformanceTelemetryRecord.ts", "utf8")
    ]);
    for (const source of [model, telemetry, generated]) {
      expect(source).not.toContain("NapiLatency");
      expect(source).not.toContain("record_napi");
    }
  });
});
