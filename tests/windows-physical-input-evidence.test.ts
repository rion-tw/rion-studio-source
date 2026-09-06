import { describe, expect, it } from "vitest";
import { validateWindowsPhysicalInputEvidence } from
  "../scripts/desktopE2eChromiumMacroCutoverEvidence.mjs";

function fixture() {
  const parentIdentity = "a".repeat(64);
  const probe = (webContentsId: number, visible: boolean) => {
    const identity = { roleId: `probe-${webContentsId}`, surfaceGeneration: 1,
      nativeGeneration: 1, bindingRevision: "1", parentIdentity, webContentsId };
    return { ...identity, ownerKind: "view", status: "verified", observation: {
      identity, parentIdentity, focusIdentity: "b".repeat(64), parentForeground: true,
      parentVisible: true, parentMinimized: false, focusedWebContentsId: visible ? webContentsId : 3,
      viewAttached: true, viewVisible: visible, contentsDestroyed: false, contentsFocused: visible,
      bounds: { width: 600, height: 400 }, zoomFactor: visible ? 1 : 1.25
    } };
  };
  const dom = () => ({ received: true, value: [{ isTrusted: true, matches: true }] });
  return { candidateEvidence: "foreground-and-hidden-product-path", platform: "win32",
    ownerKind: "view", exactSiblingViews: true, hiddenPresentationPreserved: true,
    displayScaleFactor: 1, focusReceipt: { status: "applied" }, hiddenFocusReceipt: { status: "applied" },
    viewportAcknowledgement: { status: "applied", width: 480, height: 320 },
    foregroundProbe: probe(2, true), controlProbe: probe(3, true), hiddenProbe: probe(2, false),
    finalProbe: probe(2, false), keyDom: dom(), mouseDom: dom(), hiddenKeyDom: dom(), hiddenMouseDom: dom()
  };
}

function replacePath(value: unknown, path: string, replacement: unknown) {
  const keys = path.split(".");
  let current = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
  current[keys.at(-1)!] = replacement;
}

describe("shared Windows physical View evidence boundary", () => {
  it("accepts exact sibling View ownership and trusted foreground/hidden input", () => {
    expect(() => validateWindowsPhysicalInputEvidence(fixture())).not.toThrow();
  });
  it.each([
    ["platform", "macos"], ["ownerKind", "childHwnd"], ["exactSiblingViews", false],
    ["hiddenPresentationPreserved", false], ["focusReceipt.status", "failed"],
    ["hiddenFocusReceipt.status", "indeterminate"], ["displayScaleFactor", 0],
    ["viewportAcknowledgement.width", 600], ["viewportAcknowledgement.status", "failed"],
    ["foregroundProbe.parentIdentity", "wrong"], ["foregroundProbe.surfaceGeneration", 0],
    ["foregroundProbe.observation.identity.webContentsId", 99],
    ["controlProbe.observation.focusedWebContentsId", 2],
    ["hiddenProbe.observation.viewVisible", true], ["hiddenProbe.observation.contentsFocused", true],
    ["hiddenProbe.observation.parentForeground", false], ["hiddenProbe.observation.viewAttached", false],
    ["hiddenProbe.observation.contentsDestroyed", true], ["hiddenProbe.observation.parentMinimized", true],
    ["finalProbe.webContentsId", 3], ["finalProbe.observation.focusIdentity", "c".repeat(64)],
    ["finalProbe.observation.zoomFactor", 1], ["keyDom.received", false],
    ["mouseDom.value", []], ["hiddenKeyDom.value.0.isTrusted", false],
    ["hiddenMouseDom.value.0.matches", false], ["hiddenMouseDom", null]
  ])("rejects incomplete or contradicted evidence at %s", (path, replacement) => {
    const evidence = fixture();
    replacePath(evidence, path as string, replacement);
    expect(() => validateWindowsPhysicalInputEvidence(evidence)).toThrow();
  });
  it.each([null, {}, { ownerKind: "childHwnd", abiVersion: 3 }])("rejects missing or retired receipts", (value) => {
    expect(() => validateWindowsPhysicalInputEvidence(value)).toThrow();
  });
});
