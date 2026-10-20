import { describe, expect, it } from "vitest";
import { assertScreenFitControlGeometry } from "../scripts/diagnoseAppKitPlainWindowResize.mjs";

function receipt({ width = 1024, height = 677, mainScreenWasNil = false } = {}) {
  const screen = { id: 7, frame: { x: 0, y: 0, width: 1024, height: 768 },
    visibleFrame: { x: 0, y: 60, width, height }, scale: 1 };
  const evidence = { mainScreenWasNil, mainScreenId: mainScreenWasNil ? null : 7, screens: [screen] };
  const w = Math.min(960, width), h = Math.min(677, height);
  const frame = { x: Math.min(56, width - w), y: 60 + height - h, width: w, height: h };
  return { screenId: 7, screenEvidence: globalThis.structuredClone(evidence), screenFrame: screen.frame,
    visibleFrame: screen.visibleFrame, backingScaleFactor: 1,
    frame, quartzFrame: { ...frame, y: 768 - frame.y - h }, minimumSize: { width: 640, height: 512 },
    requestedGeometry: { upperBoundSize: { width: 960, height: 677 },
      minimumSize: { width: 640, height: 512 }, shrinkDelta: { width: 48, height: 32 } },
    geometrySelection: { selectionSource: mainScreenWasNil ? "screens.firstObject" : "mainScreen",
      screenId: 7, screenEvidence: evidence,
      requestedFrame: { x: 56, y: 60 + height - 677, width: 960, height: 677 }, selectedFrame: frame } };
}

describe("screen-fit Cocoa control native receipt admission", () => {
  it.each([
    {}, { mainScreenWasNil: true }, { width: 900, height: 640 },
    { width: 688, height: 544, mainScreenWasNil: true },
  ])("accepts native screen-fit readback with original shrink margin: %j", options => {
    expect(() => assertScreenFitControlGeometry(receipt(options))).not.toThrow();
  });

  it.each([{ width: 687 }, { height: 543 }])("refuses insufficient %j before input", options => {
    expect(() => assertScreenFitControlGeometry(receipt(options))).toThrow("resize margin");
  });

  it.each([
    value => { value.geometrySelection.screenEvidence.screens = []; },
    value => { value.geometrySelection.screenEvidence.mainScreenId = 99; },
    value => { value.geometrySelection.selectionSource = "screens.firstObject"; },
    value => { value.frame = { ...value.frame, height: value.frame.height - 1 }; },
    value => { value.quartzFrame = { ...value.quartzFrame, y: value.quartzFrame.y + 1 }; },
    value => { value.geometrySelection.selectedFrame = { ...value.frame, width: 961 }; },
    value => { value.screenEvidence.screens[0].visibleFrame.height -= 1; },
    value => { value.minimumSize.height = 513; },
    value => { value.requestedGeometry.shrinkDelta.height = 31; },
    value => { value.backingScaleFactor = Number.NaN; },
    value => { value.screenId = 99; },
  ])("refuses unknown, changed or contradictory native evidence", mutate => {
    const value = receipt();
    mutate(value);
    expect(() => assertScreenFitControlGeometry(value)).toThrow();
  });
});
