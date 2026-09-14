import { createTab, harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, mixedTab } from "./support/electronChromiumRuntimeEffectFixtures";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { describe, expect, it, vi } from "vitest";
import { MacosAppKitRuntimeHostPresentationGate } from "../src/electron/main/macosAppKitRuntimeHostPresentationGate";
import { createMacosAppKitWorkspaceDividerProjectionState, initializeMacosAppKitWorkspaceBackground } from "../src/electron/main/macosAppKitWorkspaceDividerProjection";

describe("macOS initial host admission", () => {
  it("coalesces placement independently of focus and releases in observed order exactly once", () => {
    const gate = new MacosAppKitRuntimeHostPresentationGate();
    gate.deferWindowState({type:"windowPlacementChanged",presentation:"normal"});
    gate.deferLayout();
    gate.deferWindowState({type:"windowFocused",sourceWindowId:"window-1"});
    gate.deferWindowState({type:"windowPlacementChanged",presentation:"fullscreen"});
    gate.deferLayout();
    expect(gate.admit()).toEqual([
      {kind:"windowState",sequence:3,action:{type:"windowFocused",sourceWindowId:"window-1"}},
      {kind:"windowState",sequence:4,action:{type:"windowPlacementChanged",presentation:"fullscreen"}},
      {kind:"layout",sequence:5}
    ]);
    expect(gate.admit()).toEqual([]);
    expect(gate.deferLayout()).toBe(false);
    expect(gate.deferWindowState({type:"windowPlacementChanged"})).toBe(false);
  });
  for (const background of ["black","material"] as const) it(`seeds ${background} through the real native revision ledger`, () => {
    const state = createMacosAppKitWorkspaceDividerProjectionState();
    const contentBounds = {x:0,y:8,width:960,height:600};
    const apply = vi.fn((projectionRevision: string) => ({projectionRevision,contentBounds,dividerCount:0}));
    initializeMacosAppKitWorkspaceBackground({state,contentBounds,background,apply});
    expect(apply).toHaveBeenCalledWith("1",contentBounds,[],background);
    expect(state).toMatchObject({background,nativeRevision:1,version:1,contentBounds,dividers:[]});
    expect(() => initializeMacosAppKitWorkspaceBackground({state,contentBounds,background,apply}))
      .toThrow(expect.objectContaining({code:"ELECTRON_MACOS_APPKIT_BACKGROUND_ALREADY_INITIALIZED"}));
    expect(apply).toHaveBeenCalledOnce();
  });
  it("does not acknowledge an initial native background with mismatched bounds", () => {
    const state = createMacosAppKitWorkspaceDividerProjectionState();
    const contentBounds = {x:0,y:8,width:960,height:600};
    expect(() => initializeMacosAppKitWorkspaceBackground({state,contentBounds,background:"black",
      apply: () => ({projectionRevision:"1",dividerCount:0,contentBounds:{...contentBounds,width:640}})}))
      .toThrow(expect.objectContaining({code:"ELECTRON_MACOS_APPKIT_DIVIDER_RECEIPT_INVALID"}));
    expect(state.nativeRevision).toBe(0);
    expect(state.contentBounds).toBeNull();
  });
});

// Both followers must refresh the specification before a delayed first Role resolves geometry.
for (const platform of ["macos","windows"] as const) it(`uses accepted workspace slots during first ${platform} content creation`, async () => {
  const subject = harness(undefined, platform);
  const specification = mixedTab();
  await createTab(subject,specification);
  const initialWindow = subject.executor.snapshot().windows[0]!;
  await subject.executor.execute(effect("embedded-runtime", {
    type:"embeddedFollowRoleOwnership", lifecycleEpoch:1,
    roles:[{roleId:"role-1",runtime:"embedded",state:"launching",owner:{tabId:specification.tabId,slotId:"slot-1",generation:1}}], revealWindowIds:[], focusWindowIds:[],
    windows:[{windowId:specification.target.windowId,windowGeneration:initialWindow.windowGeneration,topologyRevision:initialWindow.topologyRevision+1,
      tabIds:[specification.tabId],activeTabId:specification.tabId,hiddenTabIds:[],
      tabPhases:[{tabId:specification.tabId,phase:"loading"}],workspaceTabs:[{
        tabId:specification.tabId, workspaceAppearance:{gap:16,background:"black"},
        workspaceSlots:specification.slots.map((slot,index) => ({id:slot.slotId,
          ...(slot.web ? {web:{}} : {roleId:slot.role.id}),
          rect:{x:index === 0 ? 0 : 0.6,y:0,width:index === 0 ? 0.6 : 0.4,height:1}}))
      }]}]
  }));
  const role = specification.roles.find(view => !view.web)!;
  const run = await subject.executor.execute(effect(specification.tabId,{type:"embeddedLoadRoles",
    roles:[{roleId:role.role.id,resolvedEngine:"chromium",url:role.role.launchUrl,zoomFactor:role.zoomFactor}]}));
  if (isCoreEffectEventContinuation(run)) await run.completion;
  const latest = subject.resolveRoleBounds.mock.calls.at(-1)![0];
  expect(latest.workspaceAppearance).toEqual({gap:16,background:"black"});
  expect(latest.slots.map(slot => slot.rect.width)).toEqual([0.6,0.4]);
});
