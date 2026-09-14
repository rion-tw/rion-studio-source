import { describe, expect, it } from "vitest";
import { isClosedCoreEffectRequest } from "../src/electron/core/coreEffectActionValidation";

function effect() {
  const bounds = { x:0,y:8,width:480,height:600 };
  return { effectId:"layout-1",operationId:"layout-1",target:{kind:"app",handleId:"window-1"},completionPolicy:"eventBound",
    action:{type:"embeddedApplyAppKitProjection",projection:{eventId:"native-1",windows:[{
      identity:{logicalWindowId:"window-1",launchGeneration:"launch-1",nativeGeneration:1},
      adapterSequence:1,windowGeneration:1,topologyRevision:1,contentBounds:bounds,
      activeTabId:"tab-1",logicalTabIds:["tab-1"],hiddenTabIds:[],
      tabs:[{tabId:"tab-1",name:"Loading workspace",phase:"loading",tabType:"workspace",audioMuted:false}],roles:[],
      webSurfaces:[{surfaceId:"web-1",slotId:"slot-1",tabId:"tab-1",attemptGeneration:"attempt-1",surfaceGeneration:2,bounds,visible:true}],
      workspaceDividers:[{tabId:"tab-1",attemptGeneration:"attempt-1",dividerIndex:0,axis:"vertical",bounds,visible:true,
        resizeIndicators:[{surfaceId:"web-1",label:"50% × 100%",bounds}]}],
      workspaceAppearance:{background:"black",gap:16},windowVisible:true
    }]}}
  };
}

describe("v38 AppKit presentation event boundary", () => {
  it("accepts exact mounted/loading surfaces, background, and Core ratio labels", () => {
    expect(isClosedCoreEffectRequest(effect())).toBe(true);
  });
  it.each([undefined,0,-1,1.5])("rejects invalid native generation %s before dispatch", generation => {
    const request=effect();
    Object.assign(request.action.projection.windows[0]!.webSurfaces[0]!, {surfaceGeneration:generation});
    expect(isClosedCoreEffectRequest(request)).toBe(false);
  });
  it("rejects an incomplete background and malformed hint bounds", () => {
    const request=effect();
    Object.assign(request.action.projection.windows[0]!, {workspaceAppearance:undefined});
    expect(isClosedCoreEffectRequest(request)).toBe(false);
    const malformed=effect();
    malformed.action.projection.windows[0]!.workspaceDividers[0]!.resizeIndicators[0]!.bounds.width=NaN;
    expect(isClosedCoreEffectRequest(malformed)).toBe(false);
  });
});
