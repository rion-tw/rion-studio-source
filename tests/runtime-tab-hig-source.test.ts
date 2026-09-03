import { describe, expect, it } from "vitest";

import { readSourceTree as readFile } from "./helpers/readSourceTree";

describe("runtime tab HIG status presentation", () => {
  it("uses semantic AppKit accessories and a non-focusing status backdrop", async () => {
    const [tabItem, supportViews, failurePresentation] = await Promise.all([
      readFile(
        new URL(
          "../crates/rion-appkit/native/macos/RionRuntimeTabsController/03_shortcut_model.mm",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../crates/rion-appkit/native/macos/RionRuntimeTabsController/03_support_views.mm",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../crates/rion-appkit/native/macos/RionRuntimeTabsController/06_fullscreen.mm",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(tabItem).toContain("NSProgressIndicatorStyleSpinning");
    expect(tabItem).toContain('@"circle.dashed"');
    expect(tabItem).toContain('@"exclamationmark.triangle.fill"');
    expect(tabItem).toContain('@"exclamationmark.circle.fill"');
    expect(tabItem).toContain("NSColor.secondaryLabelColor");
    expect(tabItem).toContain("NSColor.systemOrangeColor");
    expect(tabItem).toContain("NSColor.systemRedColor");
    expect(tabItem).toContain("NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion");
    expect(tabItem).toContain("BOOL hasEndSlot = !_hideTabCloseButton || !_phaseReady;");
    expect(tabItem).toContain("[_moreButton addTrackingArea:_closeSlotTrackingArea];");
    expect(tabItem).toContain(
      "BOOL revealClose = !_hideTabCloseButton && _closeSlotHovered;"
    );
    expect(tabItem).toContain("self->_phaseAccessory.animator.alphaValue = phaseAlpha;");
    expect(supportViews).toContain("NSColor.windowBackgroundColor.CGColor");
    expect(supportViews).toContain("- (BOOL)wantsUpdateLayer");
    expect(supportViews).toContain("NSViewWidthSizable | NSViewHeightSizable");
    expect(failurePresentation).toContain("RionRuntimeStatusBackdropView");
    expect(failurePresentation).toContain("_statusLoadingProgress.style = NSProgressIndicatorStyleSpinning");
    expect(failurePresentation).toContain("_statusLoadingProgress.accessibilityElement = NO");
    expect(failurePresentation).toContain("tab.loadingAccessibilityLabel");
    expect(failurePresentation).toContain("[_statusLoadingProgress stopAnimation:nil]");
    expect(failurePresentation).toContain("_statusBackdrop.hidden = YES");
    expect(failurePresentation).not.toContain("loadingLabelWithString");
    expect(failurePresentation).toContain("target:self");
    expect(failurePresentation).not.toContain("makeFirstResponder:_failureRetryButton");
  });

  it("keeps the HTML accessory semantic across motion and contrast preferences", async () => {
    const [tabStyles, statusDocument, statusStyles] = await Promise.all([
      readFile(new URL("../src/renderer/runtime-tabs.css", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/runtime-tab-status.html", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/runtime-tab-status.css", import.meta.url), "utf8")
    ]);

    expect(tabStyles).toMatch(/\.phase-accessory \{[\s\S]*?width: 12px;[\s\S]*?height: 12px;/);
    expect(tabStyles).toMatch(/\.tab-end-accessory \{[\s\S]*?display: grid;[\s\S]*?width: 20px;/);
    expect(tabStyles).toContain(
      ".tab.tab-closable .tab-end-accessory:hover .phase-accessory"
    );
    expect(tabStyles).toContain(
      ".tab.tab-closable .tab-end-accessory:hover .close"
    );
    expect(tabStyles).not.toContain(".tab.tab-closable:hover");
    expect(tabStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tabStyles).toMatch(/\.phase-spinner \{[\s\S]*?animation: none;/);
    expect(tabStyles).toContain("@media (prefers-contrast: more)");
    expect(tabStyles).toContain("@media (forced-colors: active)");
    expect(statusDocument).toContain('role="status"');
    expect(statusDocument).toContain('aria-live="polite"');
    expect(statusDocument).toContain('id="loading-status"');
    expect(statusStyles).toContain(".loading-spinner");
    expect(statusStyles).toMatch(/prefers-reduced-motion[\s\S]*?\.loading-spinner \{[\s\S]*?animation: none;/);
    expect(statusStyles).toContain("background: hsl(var(--background));");
    expect(statusStyles).toContain("button:focus-visible");
    expect(statusStyles).toContain("@media (forced-colors: active)");
  });
});
