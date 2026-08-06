import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("native tab scroll viewport", () => {
  it("explicitly clips macOS tab surfaces to the scroll viewport", async () => {
    const [supportViews, viewModel, layout, dragDrop] =
      await Promise.all([
        readFile(
          new URL(
            "../src-tauri/native/macos/RionRuntimeTabsController/03_support_views.mm",
            import.meta.url
          ),
          "utf8"
        ),
        readFile(
          new URL(
            "../src-tauri/native/macos/RionRuntimeTabsController/04_view_model.mm",
            import.meta.url
          ),
          "utf8"
        ),
        readFile(
          new URL(
            "../src-tauri/native/macos/RionRuntimeTabsController/05_layout.mm",
            import.meta.url
          ),
          "utf8"
        ),
        readFile(
          new URL(
            "../src-tauri/native/macos/RionRuntimeTabsController/07_drag_drop.mm",
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
    expect(viewModel).toContain("if (_clusterContainer != _clusterContent)");
    expect(viewModel).toContain("[root addSubview:_tabScrollView");
    expect(viewModel).toContain("positioned:NSWindowAbove");
    expect(viewModel).toContain("relativeTo:_clusterContainer");
    expect(layout).toContain("- (NSView *)tabSurfaceOverlayHost");
    expect(layout).toContain("NSView *overlayHost = [self tabSurfaceOverlayHost]");
    expect(dragDrop).toContain("NSView *overlayHost = [self tabSurfaceOverlayHost]");
    expect(layout).not.toContain("[_clusterContent addSubview:surface");
    expect(dragDrop).not.toContain("[_clusterContent addSubview:surface");
  });
});
