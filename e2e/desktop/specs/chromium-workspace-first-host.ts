import { captureWorkspaceTransitionFrames } from "../support/workspace-transition-frames";
import { browser, expect } from "@wdio/globals";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtureRequest } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import { captureWorkspacePixels } from "../support/workspace-pixels";
import { resizeWorkspaceWindow } from "../support/workspace-window-resize";
import { electronDesktopE2eFullscreenToolbarRuntime as inspect, electronDesktopE2eProbe } from "../support/electron-driver";
import { clickVisibleRuntimeWindowControl } from "../support/native-runtime-tabs";
import { focusVisibleMacosAppKitRuntime, pressVisibleMacosApplicationShortcut, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";

type Bounds = { x: number; y: number; width: number; height: number };
type Input = { windowId: string; tabId: string; mainWindowHandle: string; platform: "macos" | "windows"; setAppearance: (gap:1|16, background:"black"|"material") => Promise<void> };
export async function armFirstWorkspaceHost(windowId: string): Promise<void> {
  for (const phase of ["before", "mounted"]) await fixtureRequest("/api/gate", { roleId: `first-host-${windowId}-${phase}` });
}

/** First visible host, zero loaded content. Barriers establish preconditions only. */
export async function exerciseFirstWorkspaceHost(input: Input): Promise<void> {
  const layout = async () => JSON.parse(await readFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!,
    `first-host-${input.windowId}-layout.json`), "utf8")) as { roles: Record<string, Bounds>; contentBounds: Bounds };
  const baseline = (await inspect(input.windowId)).workspaceTabs.find(t => t.tabId === input.tabId)!.slots;
  const { processId } = await electronDesktopE2eProbe();
  let expectedGap = 1;
  let expectedBackground: "material" | "black" = "material";
  const capture = async (name: string) => {
    const current = await inspect(input.windowId);
    expect(current.workspaceTabs.find(t => t.tabId === input.tabId)!.slots).toEqual(baseline);
    const boxes = Object.values((await layout()).roles);
    const left = boxes.reduce((a,b) => a.x < b.x ? a : b);
    const right = boxes.filter(b => b.x > left.x).sort((a,b) => a.y-b.y);
    const gap = right[0]!.x-left.x-left.width;
    expect(gap).toBe(expectedGap);
    expect(right[1]!.y-right[0]!.y-right[0]!.height).toBe(expectedGap);
    const samples = await captureWorkspacePixels({ inspection: current, name,
      reference: { x:left.x+left.width,y:left.y,width:gap,height:left.height },
      region: {x:left.x,y:left.y,width:right[0]!.x+right[0]!.width-left.x,height:left.height},
      points: Array.from({length:19}, (_,i) => ({x:left.x+left.width+gap/2,y:left.y+left.height*(i+1)/20})).concat(boxes.flatMap(b => [
        {x:b.x+12,y:b.y+12},{x:b.x+b.width-12,y:b.y+12},
        {x:b.x+12,y:b.y+b.height-12},{x:b.x+b.width-12,y:b.y+b.height-12}])) });
    expect(samples.labels).toEqual([]);
    // Sharp saturated checkerboard means clear desktop leakage, not native material.
    for (const [r,g,b] of samples.samples.slice(0,19)) {
      expect((g!>220 && r!<40 && b!<40) || (r!>220 && b!>220 && g!<40)).toBe(false);
      if (expectedBackground === "black") expect(Math.max(r!,g!,b!)).toBeLessThanOrEqual(8);
    }
    for (const sample of samples.samples.slice(19)) expect(Math.max(...sample)).toBeGreaterThan(16);
    expect((await rendererCall("listRoleStatuses")).some(s => baseline.some(slot => slot.roleId === s.roleId) && s.state === "running")).toBe(false);
  };
  const toggleFullscreen = async () => {
    if (input.platform === "macos") await pressVisibleMacosApplicationShortcut({command:"toggleFullscreen", processId,
      runtimeWindowId:input.windowId,targetMode:"focused-runtime"});
    else await pressVisibleWindowsApplicationShortcut({command:"toggleFullscreen",processId,
      nativeWindowHandle:(await inspect(input.windowId)).nativeWindowHandle,targetMode:"focused-runtime"});
  };
  try {
    for (const phase of ["before", "mounted"]) {
      const waiting = await fetch(`${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/api/gates/first-host-${input.windowId}-${phase}/waiting`, {signal:AbortSignal.timeout(30_000)});
      expect(waiting.ok).toBe(true);
      await capture(`first-host-${phase}-shown`);
      for (const gap of [1,16] as const) for (const background of ["material","black"] as const) {
      await input.setAppearance(gap,background); expectedBackground = background; expectedGap = gap;
      const prefix = `first-host-${phase}-${gap}-${background}`;
      for (const edge of ["right","bottom","bottomRight","left","top"] as const) {
        const old = (await layout()).contentBounds;
        const move = { x: edge === "top" || edge === "bottom" ? 0 : edge === "left" ? 64 : -64,
          y: edge === "left" || edge === "right" ? 0 : edge === "top" ? 48 : -48 };
        await resizeWorkspaceWindow({inspection:await inspect(input.windowId),edge,moves:[move,{x:0,y:0}],
          whileHeld: async step => {
            await browser.waitUntil(async () => {
              const now = (await layout()).contentBounds;
              return step === 0 ? now.width !== old.width || now.height !== old.height : now.width === old.width && now.height === old.height;
            }, {timeout:20_000,timeoutMsg:`First host ${phase} ${edge} geometry waited for loading`});
            await capture(`${prefix}-${edge}-${step}-held`);
          }});
        await capture(`${prefix}-${edge}-ended`);
      }
      if (gap === 16 && background === "black") {
        const normal = (await layout()).contentBounds;
        for (const rapid of [false,true]) {
          let previous = JSON.stringify((await layout()).contentBounds);
          await resizeWorkspaceWindow({inspection:await inspect(input.windowId),edge:"bottomRight",rapid,
            moves: rapid ? [{x:-96,y:-72},{x:0,y:0}] : [
              {x:640-normal.width,y:400-normal.height},{x:320,y:160},{x:0,y:0}],
            whileHeld:async step => {
              await browser.waitUntil(async () => JSON.stringify((await layout()).contentBounds) !== previous, {timeout:20_000});
              previous = JSON.stringify((await layout()).contentBounds);
              await capture(`${prefix}-${rapid?"rapid":"range"}-${step}-held`);
            }});
          await capture(`${prefix}-${rapid?"rapid":"range"}-ended`);
        }
      }
      }
      for (const transitionBackground of ["black","material"] as const) {
      await input.setAppearance(16,transitionBackground); expectedBackground = transitionBackground; expectedGap = 16;
      for (const presentation of ["maximized","normal","fullscreen","normal"] as const) {
        if (input.platform === "macos") await focusVisibleMacosAppKitRuntime({processId,windowId:input.windowId});
        const fullscreen = presentation === "fullscreen" || (await inspect(input.windowId)).presentation === "fullscreen";
        await captureWorkspaceTransitionFrames(input.platform, `first-host-${phase}-${transitionBackground}-${fullscreen?"fullscreen":"maximize"}-${presentation}`, async () => {
        if (fullscreen) await toggleFullscreen();
        else await clickVisibleRuntimeWindowControl({...input,command:"maximize"});
        await browser.waitUntil(async () => (await inspect(input.windowId)).presentation === presentation,
          {timeout:30_000,timeoutMsg:`First host ${phase} did not reach ${presentation}`});
        await capture(`first-host-${phase}-${transitionBackground}-${fullscreen?"fullscreen":"maximize"}-${presentation}`);
        });
      }
      }
      if (phase === "mounted") {
        await captureWorkspaceTransitionFrames(input.platform, "first-host-completes-fullscreen", async () => {
          await toggleFullscreen();
          await browser.waitUntil(async () => (await inspect(input.windowId)).presentation === "fullscreen", {timeout:30_000});
          const latest = (await layout()).roles;
          await fixtureRequest("/api/release", {roleId:`first-host-${input.windowId}-${phase}`});
          await browser.waitUntil(async () => {
            const statuses = await rendererCall("listRoleStatuses");
            return baseline.filter(slot => slot.roleId).every(slot => statuses.some(status => status.roleId === slot.roleId && status.state === "running"));
          }, {timeout:30_000,timeoutMsg:"Initial content did not finish after release"});
          const ready = await inspect(input.windowId);
          expect(ready.presentation).toBe("fullscreen");
          for (const surface of ready.surfaces) expect(surface.bounds).toEqual(latest[surface.id]);
        });
        await toggleFullscreen();
        await browser.waitUntil(async () => (await inspect(input.windowId)).presentation === "normal", {timeout:30_000});
      }
      await input.setAppearance(1,"material"); expectedBackground = "material"; expectedGap = 1;
      await fixtureRequest("/api/release", {roleId:`first-host-${input.windowId}-${phase}`});
    }
  } finally {
    for (const phase of ["before","mounted"]) await fixtureRequest("/api/release", {roleId:`first-host-${input.windowId}-${phase}`});
  }
}
