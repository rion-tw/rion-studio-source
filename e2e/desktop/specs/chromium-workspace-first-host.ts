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
    let current: Awaited<ReturnType<typeof inspect>> | undefined;
    // Native frame acknowledgement can precede the corresponding Core/chrome
    // projection. Observe the exact existing fence before sampling any pixels.
    await browser.waitUntil(async () => {
      current = await inspect(input.windowId);
      return true;
    }, { timeout: 20_000, timeoutMsg: `First host ${name} did not reach a coherent native projection` });
    if (!current) throw new Error("The first host projection was not observed");
    expect(current.workspaceTabs.find(t => t.tabId === input.tabId)!.slots).toEqual(baseline);
    // A held resize keeps rewriting the layout, so geometry read while it is
    // still moving describes a window the screenshot no longer shows: the
    // outermost samples then land on the desktop behind it and read as leakage.
    // Reading the layout is cheap and screen capture is not, so let the geometry
    // stop moving first rather than re-shooting until it happens to agree.
    let geometry = await layout();
    for (let settled = 0; settled < 40; settled += 1) {
      const next = await layout();
      const stable = JSON.stringify(next.contentBounds) ===
        JSON.stringify(geometry.contentBounds);
      geometry = next;
      if (stable) break;
      await browser.pause(50);
    }
    const boxes = Object.values(geometry.roles);
    const left = boxes.reduce((a,b) => a.x < b.x ? a : b);
    const right = boxes.filter(b => b.x > left.x).sort((a,b) => a.y-b.y);
    const gap = right[0]!.x-left.x-left.width;
    const samples = await captureWorkspacePixels({ inspection: current, name,
      reference: { x:left.x+left.width,y:left.y,width:gap,height:left.height },
      region: {x:left.x,y:left.y,width:right[0]!.x+right[0]!.width-left.x,height:left.height},
      points: Array.from({length:19}, (_,i) => ({x:left.x+left.width+gap/2,y:left.y+left.height*(i+1)/20})).concat(boxes.flatMap(b => [
        {x:b.x+12,y:b.y+12},{x:b.x+b.width-12,y:b.y+12},
        {x:b.x+12,y:b.y+b.height-12},{x:b.x+b.width-12,y:b.y+b.height-12}])) });
    expect(gap).toBe(expectedGap);
    expect(right[1]!.y-right[0]!.y-right[0]!.height).toBe(expectedGap);
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
      // Exercise the largest reversals first so native input failures surface
      // before the remaining combinations. Every gap/background still runs.
      for (const gap of [16,1] as const) for (const background of ["black","material"] as const) {
      await input.setAppearance(gap,background); expectedBackground = background; expectedGap = gap;
      // Core holding the new appearance does not mean the host has projected it,
      // and the host having projected it does not mean its document has painted
      // it — there is no ack for a rendered projection revision. Wait for the
      // projection, then probe one pixel of the gap so the full sample set is
      // never taken against the previous background.
      await browser.waitUntil(async () => {
        const projected = (await inspect(input.windowId)).native.workspaceBackground;
        return projected === undefined || projected === background;
      }, {timeout:20_000,timeoutMsg:`First host ${phase} did not project the ${background} workspace background`});
      await browser.waitUntil(async () => {
        const probeBoxes = Object.values((await layout()).roles);
        const probeLeft = probeBoxes.reduce((a,b) => a.x < b.x ? a : b);
        const probeRight = probeBoxes.filter(b => b.x > probeLeft.x).sort((a,b) => a.y-b.y);
        const probeGap = probeRight[0]!.x-probeLeft.x-probeLeft.width;
        const point = {x: probeLeft.x+probeLeft.width+probeGap/2, y: probeLeft.y+probeLeft.height/2};
        const probe = await captureWorkspacePixels({ inspection: await inspect(input.windowId),
          name: `first-host-${phase}-${gap}-${background}-probe`, observeOnly: true,
          reference: {x:Math.floor(point.x),y:Math.floor(point.y),width:1,height:1},
          region: {x:Math.floor(point.x),y:Math.floor(point.y),width:2,height:2},
          points: [point] });
        const brightest = Math.max(...probe.samples[0]!);
        return background === "black" ? brightest <= 8 : brightest > 8;
      }, {timeout:20_000,timeoutMsg:`First host ${phase} did not paint the ${background} workspace background`});
      const prefix = `first-host-${phase}-${gap}-${background}`;
      for (const edge of ["right","bottom","bottomRight","left","top"] as const) {
        const old = (await layout()).contentBounds;
        const move = { x: edge === "top" || edge === "bottom" ? 0 : edge === "left" ? 64 : -64,
          y: edge === "left" || edge === "right" ? 0 : edge === "top" ? 48 : -48 };
        await resizeWorkspaceWindow({inspection:await inspect(input.windowId),edge,moves:[move,{x:0,y:0}],
          requireRequestedFrame:true,
          whileHeld: async (step, frame, initialFrame) => {
            // The layout plateaus on an intermediate size before catching up, so
            // waiting for it to merely change, or merely hold still, samples a
            // window that has already moved on. The resize measures the real
            // frame at the start and now, so require the layout to have moved by
            // the same amount — a delta needs no assumption about how the window
            // rect relates to the client area.
            const movedWidth = frame.width - initialFrame.width;
            const movedHeight = frame.height - initialFrame.height;
            await browser.waitUntil(async () => {
              const now = (await layout()).contentBounds;
              return Math.abs(now.width - old.width - movedWidth) <= 1 &&
                Math.abs(now.height - old.height - movedHeight) <= 1;
            }, {timeout:20_000,timeoutMsg:`First host ${phase} ${edge} step ${step} layout did not track the ${movedWidth}x${movedHeight} frame move`});
            await capture(`${prefix}-${edge}-${step}-held`);
          }});
        await capture(`${prefix}-${edge}-ended`);
      }
      if (gap === 16 && background === "black") {
        const normal = (await layout()).contentBounds;
        for (const rapid of [false,true]) {
          await resizeWorkspaceWindow({inspection:await inspect(input.windowId),edge:"bottomRight",rapid,
            moves: rapid ? [{x:-96,y:-72},{x:0,y:0}] : [
              {x:640-normal.width,y:400-normal.height},{x:320,y:160},{x:0,y:0}],
            whileHeld:async (step, frame, initialFrame) => {
              await browser.waitUntil(async () => {
                const current = (await layout()).contentBounds;
                return Math.abs(current.width-normal.width-(frame.width-initialFrame.width)) <= 1 &&
                  Math.abs(current.height-normal.height-(frame.height-initialFrame.height)) <= 1;
              }, {timeout:20_000,timeoutMsg:`First host ${phase} range step ${step} did not match the native frame`});
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
