import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chromiumMacroBackgroundTabPhaseDependencies,
  chromiumMacroBackgroundTabPhaseNamespaces,
  isChromiumMacroBackgroundTabPhase,
  validateChromiumMacroBackgroundTabRuntimeEvidence,
  validateChromiumMacroBackgroundTabSqliteEvidence
} from "../scripts/desktopE2eChromiumMacroBackgroundTabEvidence.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

function inputObservation(input: Readonly<{
  intent: "cleanup" | "normal";
  ownerId: string;
  phase: "hold" | "release";
  roleId: string;
  sequence: number;
}>) {
  const requestId = `request-${input.sequence}`;
  return {
    receipt: {
      completedAtMs: input.sequence * 10 + 1,
      confirmedInputNeutrality: input.phase === "release",
      errorCode: null,
      errorMessage: null,
      inputEpoch: 1,
      requestId,
      roleId: input.roleId,
      status: "applied",
      surfaceGeneration: 7
    },
    request: {
      action: {
        code: "Digit2",
        key: "2",
        modifiers: [],
        ownerId: input.ownerId,
        phase: input.phase,
        suppressOverlayShortcut: true,
        type: "key"
      },
      deadlineMs: input.sequence * 10 + 5,
      inputEpoch: 1,
      intent: input.intent,
      origin: "macro",
      requestId,
      roleId: input.roleId,
      scheduledAtMs: input.sequence * 10
    },
    sequence: input.sequence
  };
}

function keyEvent(
  sequence: number,
  kind: "keydown" | "keyup",
  code: string,
  roleId: string
) {
  return { code, isTrusted: true, kind, roleId, sequence };
}

function hiddenPresentation(input: Readonly<{
  platform: "macos" | "windows";
  roleAId: string;
  roleBId: string;
  tabA: string;
  tabB: string;
  windowId: string;
}>) {
  const appKitIdentity = input.platform === "macos" ? {
    launchGeneration: "launch-1",
    logicalWindowId: input.windowId,
    nativeGeneration: 1
  } : null;
  const hostKind = input.platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  return {
    roleA: { currentRuntime: {
      appKitIdentity,
      focused: false,
      hostKind,
      parentNativeHostId: 10,
      roleId: input.roleAId,
      tabId: input.tabA,
      visible: false,
      windowId: input.windowId
    } },
    roleB: { currentRuntime: {
      appKitIdentity,
      focused: true,
      hostKind,
      parentNativeHostId: 10,
      roleId: input.roleBId,
      tabId: input.tabB,
      visible: true,
      windowId: input.windowId
    } },
    topology: {
      hostKind: input.platform === "macos" ? "appkit" : "windows",
      surfaces: [
        { tabId: input.tabA, visible: false },
        { tabId: input.tabB, visible: true }
      ],
      tabIds: [input.tabA, input.tabB]
    },
    window: { currentRuntime: {
      appKitIdentity,
      focused: true,
      hostKind,
      parentNativeHostId: 10,
      visible: true,
      windowId: input.windowId
    } }
  };
}

function runtimeEvidence(platform: "macos" | "windows") {
  const roleAId = "11111111-1111-4111-8111-111111111111";
  const roleBId = "22222222-2222-4222-8222-222222222222";
  const windowId = "33333333-3333-4333-8333-333333333333";
  const tabA = "44444444-4444-4444-8444-444444444444";
  const tabB = "55555555-5555-4555-8555-555555555555";
  const presentation = hiddenPresentation({
    platform, roleAId, roleBId, tabA, tabB, windowId
  });
  return {
    continuityHold: platform === "windows" ? inputObservation({
      intent: "normal", ownerId: "owner-1", phase: "hold", roleId: roleAId,
      sequence: 2
    }) : null,
    finalConsumerPressedCodes: [],
    finalMacroStatuses: [],
    finalRoleStatuses: [
      { automationState: "ready", roleId: roleAId, state: "running" },
      { automationState: "ready", roleId: roleBId, state: "running" }
    ],
    firstCleanup: inputObservation({
      intent: "cleanup", ownerId: "owner-1", phase: "release", roleId: roleAId,
      sequence: 3
    }),
    firstHiddenEvent: {
      hidden: true, kind: "hidden", roleId: "chromium-background-a", sequence: 20
    },
    firstHiddenKeydown: platform === "windows"
      ? keyEvent(21, "keydown", "Digit2", "chromium-background-a")
      : null,
    firstHiddenPresentation: presentation,
    firstHold: inputObservation({
      intent: "normal", ownerId: "owner-1", phase: "hold", roleId: roleAId,
      sequence: 1
    }),
    firstKeydown: keyEvent(10, "keydown", "Digit2", "chromium-background-a"),
    firstKeyup: keyEvent(23, "keyup", "Digit2", "chromium-background-a"),
    gameId: "66666666-6666-4666-8666-666666666666",
    gameWindowId: windowId,
    hiddenStartPresentation: presentation,
    macroId: "77777777-7777-4777-8777-777777777777",
    platform,
    probe: { platform },
    roleAId,
    roleBId,
    roleBDigit2Events: [],
    roleBKeyup: keyEvent(22, "keyup", "KeyZ", "chromium-background-b"),
    secondCleanup: inputObservation({
      intent: "cleanup", ownerId: "owner-2", phase: "release", roleId: roleAId,
      sequence: 5
    }),
    secondHiddenEvent: {
      hidden: true, kind: "hidden", roleId: "chromium-background-a", sequence: 30
    },
    secondHiddenPresentation: presentation,
    secondHiddenStartHold: inputObservation({
      intent: "normal", ownerId: "owner-2", phase: "hold", roleId: roleAId,
      sequence: 4
    }),
    secondKeydown: keyEvent(31, "keydown", "Digit2", "chromium-background-a"),
    secondKeyup: keyEvent(32, "keyup", "Digit2", "chromium-background-a"),
    tabA,
    tabB
  };
}

describe("Chromium Macro background-tab exact replacement source", () => {
  it("locks hidden trusted input to visible native tab actions and exact receipts", async () => {
    const [spec, attachment, adapter, continuity, physical] = await Promise.all([
      source("e2e/desktop/specs/chromium-macro-background-tab.e2e.ts"),
      source("src/electron/main/windowsChromiumInputSurfaceAttachmentCoordinator.ts"),
      source("src/electron/main/windowsChromiumTrustedInputAdapter.ts"),
      source("src/electron/main/windowsChromiumHeldKeyContinuityCoordinator.ts"),
      source("scripts/electronWindowsChromiumTrustedInputProbe.cjs")
    ]);
    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-MACRO-BACKGROUND-TAB-004",
      "CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004",
      "activateChromiumRoleVisible",
      "submitElectronRoleKeyPhases",
      "firstHiddenKeydown",
      "secondHiddenStartHold",
      'kind: "consumer-keydown"',
      "roleBDigit2Events",
      "consumerPressedCodes",
      "isTrusted"
    ]) expect(spec).toContain(marker);
    for (const forbidden of [
      'rendererCall("startMacro"',
      'rendererCall("stopMacro"',
      "electronDesktopE2eInput",
      "setTimeout(",
      "setInterval("
    ]) expect(spec).not.toContain(forbidden);
    const readOnlyObservation = spec.slice(
      spec.indexOf("async function observeHiddenPresentation"),
      spec.indexOf("async function activateAndObserveHidden")
    );
    expect(readOnlyObservation).not.toContain("activateChromiumRoleVisible");
    expect(readOnlyObservation).not.toMatch(/\.focus\(|\.show\(/u);
    expect(spec).toContain(
      "const hiddenStartPresentation = await observeHiddenPresentation({"
    );
    expect(spec).not.toContain(
      "const hiddenStartPresentation = await activateAndObserveHidden({"
    );
    expect(attachment).toContain('this.#probeRecord(record, expected, "background")');
    expect(attachment).toContain("must not be selected or");
    expect(adapter).toContain("currentInputDeliveryMode");
    expect(adapter).toContain("deliveryMode === \"background\"");
    expect(continuity).toContain("subscribePresentation");
    expect(continuity).not.toMatch(/setTimeout|setInterval/u);
    expect(physical).toContain("hiddenPresentationPreserved");
    expect(physical).toContain("controlProbe");
    expect(physical).toContain('deliveryMode: "background"');
    expect(physical).toContain("isTrusted");
  });

  it("owns a standalone paired phase and validates exact runtime evidence", async () => {
    expect(isChromiumMacroBackgroundTabPhase("chromium-macro-background-tab"))
      .toBe(true);
    expect(isChromiumMacroBackgroundTabPhase("p0-macro-background-tab")).toBe(false);
    expect(chromiumMacroBackgroundTabPhaseDependencies).toEqual([]);
    expect(chromiumMacroBackgroundTabPhaseNamespaces).toEqual([[
      "chromium-macro-background-tab",
      "chromium-macro-background-tab"
    ]]);
    const directory = await mkdtemp(resolve(tmpdir(), "rion-background-tab-"));
    try {
      for (const platform of ["macos", "windows"] as const) {
        const evidence = runtimeEvidence(platform);
        await writeFile(resolve(
          directory,
          "chromium-macro-background-tab-evidence.json"
        ), JSON.stringify(evidence));
        await expect(validateChromiumMacroBackgroundTabRuntimeEvidence({
          phase: "chromium-macro-background-tab",
          phaseDirectory: directory,
          platform
        })).resolves.toEqual(expect.objectContaining({
          gameWindowId: evidence.gameWindowId,
          macroId: evidence.macroId,
          roleIds: [evidence.roleAId, evidence.roleBId],
          tabIds: [evidence.tabA, evidence.tabB]
        }));
      }
      const forged = runtimeEvidence("windows");
      forged.hiddenStartPresentation.roleA.currentRuntime.visible = true;
      await writeFile(resolve(
        directory,
        "chromium-macro-background-tab-evidence.json"
      ), JSON.stringify(forged));
      await expect(validateChromiumMacroBackgroundTabRuntimeEvidence({
        phase: "chromium-macro-background-tab",
        phaseDirectory: directory,
        platform: "windows"
      })).rejects.toThrow(/hidden\/foreground presentation drifted/u);

      const invalidReceipt = runtimeEvidence("macos");
      invalidReceipt.firstHold.receipt.surfaceGeneration = 0;
      await writeFile(resolve(
        directory,
        "chromium-macro-background-tab-evidence.json"
      ), JSON.stringify(invalidReceipt));
      await expect(validateChromiumMacroBackgroundTabRuntimeEvidence({
        phase: "chromium-macro-background-tab",
        phaseDirectory: directory,
        platform: "macos"
      })).rejects.toThrow(/native trusted-input receipt drifted/u);

      const partialSurfaceRequest = runtimeEvidence("macos");
      Object.assign(partialSurfaceRequest.firstHold.request, { surfaceGeneration: 7 });
      await writeFile(resolve(
        directory,
        "chromium-macro-background-tab-evidence.json"
      ), JSON.stringify(partialSurfaceRequest));
      await expect(validateChromiumMacroBackgroundTabRuntimeEvidence({
        phase: "chromium-macro-background-tab",
        phaseDirectory: directory,
        platform: "macos"
      })).rejects.toThrow(/Core request shape drifted/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts only the exact persisted two-Role held-key authority", () => {
    const roleAId = "role-a";
    const roleBId = "role-b";
    const input = {
      entities: {
        games: [{ id: "game-1", name: "Chromium Background Tab Game", payload: {} }],
        gameWindows: [{
          id: "window-1",
          name: "Chromium Background Tab",
          payload: { tabs: [
            { id: "tab-a", sourceId: roleAId, tabType: "role" },
            { id: "tab-b", sourceId: roleBId, tabType: "role" }
          ] }
        }],
        macros: [{
          id: "macro-1",
          name: "Chromium Background Tab Macro",
          payload: {
            activationMode: "toggle",
            enabled: true,
            repeat: { type: "once" },
            roleIds: [roleAId],
            shortcutSourceScope: {
              roleIds: [roleAId, roleBId], type: "selected_roles"
            },
            steps: [{
              action: "hold_until_stop", code: "Digit2",
              id: "chromium-background-held-key", type: "key"
            }],
            trigger: {
              alt: false, code: "Digit4", ctrl: false, meta: false, shift: true
            }
          }
        }],
        roles: [
          { id: roleAId, name: "Chromium Background Tab Role A", payload: { gameId: "game-1" } },
          { id: roleBId, name: "Chromium Background Tab Role B", payload: { gameId: "game-1" } }
        ]
      },
      phase: "chromium-macro-background-tab",
      phaseDirectory: "/unused",
      settings: [{
        key: "runtimeRestoreSession",
        payload: { cleanExit: true, schemaVersion: 2 }
      }]
    };
    expect(validateChromiumMacroBackgroundTabSqliteEvidence(input)).toEqual({
      cleanExit: true,
      gameId: "game-1",
      macroId: "macro-1",
      roleIds: [roleAId, roleBId],
      tabIds: ["tab-a", "tab-b"],
      windowId: "window-1"
    });
    input.entities.macros[0]!.payload.shortcutSourceScope.roleIds = [roleAId];
    expect(() => validateChromiumMacroBackgroundTabSqliteEvidence(input))
      .toThrow(/shortcut-source scope drifted/u);
  });
});
