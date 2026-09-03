import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("native tab scroll viewport", () => {
  it("clips at the outer controls while preserving arrow fusion zones", async () => {
    const [
      geometry,
      surfaceViews,
      supportViews,
      viewModel,
      layout,
      scrolling,
      dragDrop,
    ] = await Promise.all([
        readFile(
          new URL(
            "../crates/rion-appkit/native/macos/RionRuntimeTabsController/01_geometry.mm",
            import.meta.url
          ),
          "utf8"
        ),
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
            "../crates/rion-appkit/native/macos/RionRuntimeTabsController/04_view_model.mm",
            import.meta.url
          ),
          "utf8"
        ),
        readFile(
          new URL(
            "../crates/rion-appkit/native/macos/RionRuntimeTabsController/05_layout.mm",
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
        ),
        readFile(
          new URL(
            "../crates/rion-appkit/native/macos/RionRuntimeTabsController/07_drag_drop.mm",
            import.meta.url
          ),
          "utf8"
        )
      ]);
    const scrollViewStart = supportViews.indexOf(
      "@implementation RionRuntimeHorizontalScrollView"
    );
    const scrollView = supportViews.slice(
      scrollViewStart,
      supportViews.indexOf("@end", scrollViewStart)
    );

    expect(scrollView).toContain("- (instancetype)initWithFrame:(NSRect)frameRect");
    expect(scrollView).toContain("self.contentView.clipsToBounds = YES;");
    expect(viewModel).toContain("_clusterContainer.clipsToBounds = YES;");
    expect(viewModel).toContain("[_clusterContent addSubview:_tabScrollView]");
    expect(viewModel).toContain("[_clusterContent addSubview:_scrollLeftSurface");
    expect(viewModel).toContain("[_clusterContent addSubview:_scrollRightSurface");
    expect(viewModel).toContain("positioned:NSWindowAbove");
    expect(viewModel).toContain("relativeTo:_tabScrollView");
    expect(viewModel).toContain("[root addSubview:_windowNameField");
    expect(viewModel).toContain("[root addSubview:_addSurface");
    expect(layout).toContain("- (NSView *)tabSurfaceOverlayHost");
    expect(layout).toContain("return _clusterContent;");
    expect(geometry).toContain("kRionTabCompactMinimumWidth = 112.0;");
    expect(geometry).toContain("RionRuntimeResolveTabWidths(");
    expect(geometry).toContain("std::sort(sortedWidths.begin(), sortedWidths.end())");
    expect(layout).toContain("RionRuntimeTabWidthLayout widthLayout");
    expect(layout).toContain("_window.backingScaleFactor");
    expect(layout).toContain("NSWindowDidChangeBackingPropertiesNotification");
    expect(layout).toContain("item.layoutWidth = width;");
    expect(layout).toContain("BOOL overflowing = widthLayout.overflowing;");
    expect(layout).toContain("overflowing ? kRionTabScrollFusionInset : 0");
    expect(layout).toContain("tabsWidth + 2.0 * fusionInset");
    expect(geometry).toContain("static void RionRuntimeLayoutTabClusterViews(");
    expect(geometry).toContain("viewport.frame = viewportFrame;");
    expect(geometry).toContain("effectContainer.frame = viewport.bounds;");
    expect(geometry).toContain(
      "if (content != effectContainer) content.frame = effectContainer.bounds;"
    );
    expect(layout).toContain("RionRuntimeLayoutTabClusterViews(");
    expect(layout).toContain(
      "_clusterContainer, _clusterEffectContainer, _clusterContent,"
    );
    expect(layout).toContain("_tabScrollView.frame = _clusterContent.bounds;");
    expect(layout).toContain("CGFloat x = fusionInset;");
    expect(layout).toContain("[self updateTabEdgeFadeMasks]");
    expect(scrolling).toContain("- (void)updateTabEdgeFadeMasks");
    expect(scrolling).toContain("RionRuntimeTabEdgeFadeAlpha(");
    expect(scrolling).toContain("CAGradientLayer *mask");
    expect(scrolling).toContain("[surface setEdgeFadeMask:mask effectVisibleRect:effectVisibleRect]");
    expect(scrolling).toContain("viewportWidth - edgeInset");
    expect(surfaceViews).toContain("- (void)setEdgeFadeMask:(nullable CAGradientLayer *)mask");
    expect(surfaceViews).toContain("glass.contentView = _contentHostView;");
    expect(surfaceViews).toContain("_contentHostView.clipsToBounds = YES;");
    expect(surfaceViews).toContain("_contentView.layer.mask = mask;");
    expect(surfaceViews).toContain("CGPathCreateWithRoundedRect(");
    expect(surfaceViews).toContain("self.layer.mask = _edgeShapeMask;");
    expect(surfaceViews).toContain("_effectView.frame = visibleRect;");
    expect(surfaceViews).toContain("_contentHostView.frame = _effectView.bounds;");
    expect(surfaceViews).toContain("_contentView.frame = NSMakeRect(-NSMinX(visibleRect)");
    expect(layout).not.toContain("item.frame = surface.bounds;");
    expect(layout).toContain("NSView *overlayHost = [self tabSurfaceOverlayHost]");
    expect(dragDrop).toContain("NSView *overlayHost = [self tabSurfaceOverlayHost]");
    expect(dragDrop).toContain("RionRuntimeTabItemLayoutWidth(");
    expect(dragDrop).toContain("resolvedDragWidthForTabIdentifier:");
    expect(dragDrop).toContain("return _externalDragGhostLayoutWidth;");
    expect(dragDrop).toContain("MAX(kRionTabCompactMinimumWidth, width)");
    expect(dragDrop).toContain("_scrollLeftSurface.hidden ? 0 : kRionTabScrollFusionInset");
    expect(dragDrop).toContain("convertRect:_tabScrollView.frame");
  });
});
