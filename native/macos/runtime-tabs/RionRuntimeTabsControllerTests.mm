#import <AppKit/AppKit.h>

#include <cmath>
#include <cstdlib>
#include <iostream>

#import "RionRuntimeTabsController.h"

@interface RionRuntimeTabsController (RionRuntimeTabsTests)

- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                    sourceDisplayID:(NSInteger)sourceDisplayID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier;
- (void)applyFullScreenPolicy;
- (void)applyLiquidGlassTitlebarAppearance;
- (void)attachAccessoryController;
- (void)captureWindowedTrafficLightFrames;
- (void)detachAccessoryController;
- (void)hideInsertionIndicator;
- (void)installFreshToolbarForFullScreen;
- (void)installFreshToolbarForWindowedMode;
- (void)layoutTitlebarContent;
- (void)restoreWindowedTrafficLightFrames;
- (void)restoreWindowedTitlebarHost;
- (void)settleWindowedTitlebarAfterFullScreenExit;
- (CGFloat)trafficLightReserveWidth;
- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier;

@end

static void Assert(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << std::endl;
    std::exit(1);
  }
}

static RionRuntimeTabModel *MakeTab(NSString *identifier, NSString *name,
                                    BOOL active, NSInteger roleCount) {
  RionRuntimeTabModel *tab = [[RionRuntimeTabModel alloc] init];
  tab.active = active;
  tab.identifier = identifier;
  tab.name = name;
  tab.roleCount = roleCount;
  tab.type = roleCount > 0 ? @"workspace" : @"role";
  tab.workspaceTemplate = roleCount > 0 ? @"quad" : nil;
  return tab;
}

static RionRuntimeTabsState *MakeState(NSArray<RionRuntimeTabModel *> *tabs) {
  RionRuntimeTabsState *state = [[RionRuntimeTabsState alloc] init];
  state.addLabel = @"Add";
  state.displayID = 11;
  state.moreLabel = @"More";
  state.tabs = tabs;
  return state;
}

static void AssertItemSubviewsDoNotOverlap(NSView *item) {
  NSView *icon = [item valueForKey:@"_iconView"];
  NSView *title = [item valueForKey:@"_titleField"];
  NSView *badge = [item valueForKey:@"_badgeView"];
  NSView *more = [item valueForKey:@"_moreButton"];
  if (NSIntersectsRect(icon.frame, title.frame) ||
      NSIntersectsRect(title.frame, more.frame) ||
      (!badge.hidden && (NSIntersectsRect(title.frame, badge.frame) ||
                         NSIntersectsRect(badge.frame, more.frame)))) {
    std::cerr << "Overlapping tab frames: item=" << NSStringFromRect(item.frame).UTF8String
              << " icon=" << NSStringFromRect(icon.frame).UTF8String
              << " title=" << NSStringFromRect(title.frame).UTF8String
              << " badge=" << NSStringFromRect(badge.frame).UTF8String
              << " more=" << NSStringFromRect(more.frame).UTF8String << std::endl;
  }
  Assert(!NSIntersectsRect(icon.frame, title.frame),
         "Icon and title frames must not overlap.");
  Assert(!NSIntersectsRect(title.frame, more.frame),
         "Title and more-button frames must not overlap.");
  if (item.frame.size.width < 223.5) {
    NSTextField *titleField = (NSTextField *)title;
    CGFloat measuredTitleWidth =
        [titleField.stringValue sizeWithAttributes:@{
          NSFontAttributeName : [NSFont systemFontOfSize:12.0
                                                   weight:NSFontWeightSemibold]
        }].width;
    Assert(title.frame.size.width + 0.5 >= ceil(measuredTitleWidth),
           "A non-max-width tab must not truncate its title prematurely.");
  }
  if (!badge.hidden) {
    Assert(!NSIntersectsRect(title.frame, badge.frame),
           "Title and badge frames must not overlap.");
    Assert(!NSIntersectsRect(badge.frame, more.frame),
           "Badge and more-button frames must not overlap.");
  }
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 900, 600)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    Assert([window standardWindowButton:NSWindowCloseButton] != nil,
           "Expected a standard close button before attaching runtime tabs.");
    NSWindowToolbarStyle previousToolbarStyle = window.toolbarStyle;
    NSTitlebarSeparatorStyle previousTitlebarSeparatorStyle =
        window.titlebarSeparatorStyle;
    NSApplicationPresentationOptions previousPresentationOptions =
        NSApplication.sharedApplication.presentationOptions;

    __block NSDictionary<NSString *, id> *lastAction = nil;
    RionRuntimeTabsController *controller = [[RionRuntimeTabsController alloc]
        initWithWindow:window
         actionHandler:^(NSDictionary<NSString *, id> *action) {
      lastAction = action;
    }];
    Assert(controller != nil, "Expected the native runtime tabs controller.");
    Assert(window.titleVisibility == NSWindowTitleHidden,
           "Expected the native title to be hidden.");
    Assert(window.titlebarAppearsTransparent,
           "Expected the system titlebar material to remain visible through the accessory.");
    Assert(window.titlebarAccessoryViewControllers.count == 1,
           "Expected one titlebar accessory controller.");
    Assert(window.toolbar != nil && window.toolbar.visible,
           "Normal windows must use a visible compact toolbar for titlebar height and material.");
    Assert(window.toolbar.items.count == 1 &&
               window.toolbar.items.firstObject.view.frame.size.height == 28.0 &&
               window.toolbar.items.firstObject.visibilityPriority ==
                   NSToolbarItemVisibilityPriorityHigh,
           "The compact toolbar must retain its high-priority 28pt layout spacer.");
    if (@available(macOS 11.0, *)) {
      Assert(window.toolbarStyle == NSWindowToolbarStyleUnifiedCompact,
             "Runtime tabs must use the standard compact macOS toolbar host.");
      Assert(window.titlebarSeparatorStyle == NSTitlebarSeparatorStyleNone,
             "Runtime tabs must suppress AppKit's titlebar separator strip.");
    }
    Assert([window standardWindowButton:NSWindowCloseButton] != nil,
           "Attaching runtime tabs must preserve standard traffic lights.");

    RionRuntimeTabModel *role = MakeTab(@"tab-1", @"Mina", YES, 0);
    RionRuntimeTabModel *workspace = MakeTab(@"tab-2", @"Team", NO, 4);
    RionRuntimeTabsState *state = MakeState(@[ role, workspace ]);
    [controller updateState:state];
    Assert(controller.renderedTabCount == 2, "Expected two rendered native tabs.");

    NSArray<NSView *> *tabItems = [controller valueForKey:@"_tabItems"];
    NSArray<NSView *> *tabSurfaces = [controller valueForKey:@"_tabSurfaces"];
    NSView *root = [controller valueForKeyPath:@"_accessoryController.view"];
    NSView *addSurface = [controller valueForKey:@"_addSurface"];
    NSScrollView *scrollView = [controller valueForKey:@"_tabScrollView"];
    Assert(tabItems.count == 2 && tabSurfaces.count == 2,
           "Expected one item and surface for every tab.");
    Assert(root.intrinsicContentSize.height == 40.0,
           "The accessory root must match the compact 40pt titlebar host.");
    NSVisualEffectView *backdrop = [controller valueForKey:@"_titlebarBackdrop"];
    Assert([backdrop isKindOfClass:NSVisualEffectView.class] &&
               backdrop.material == NSVisualEffectMaterialHeaderView &&
               backdrop.blendingMode == NSVisualEffectBlendingModeBehindWindow &&
               backdrop.state == NSVisualEffectStateFollowsWindowActiveState &&
               NSEqualRects(backdrop.frame, root.bounds),
           "The full titlebar must use a soft system header blur material.");
    NSTitlebarAccessoryViewController *accessory =
        [controller valueForKey:@"_accessoryController"];
    Assert(accessory.layoutAttribute == NSLayoutAttributeTrailing &&
               accessory.fullScreenMinHeight == 40.0,
           "Windowed and fullscreen tabs must share the same 40pt titlebar layout.");

    // AppKit may mutate titlebar properties while re-hosting the accessory for
    // fullscreen. The shared appearance pass must restore the exact windowed
    // Liquid Glass metrics and material without replacing the tab surfaces.
    NSArray<NSView *> *originalTabSurfaces = tabSurfaces;
    window.titleVisibility = NSWindowTitleVisible;
    window.titlebarAppearsTransparent = NO;
    if (@available(macOS 11.0, *)) {
      window.toolbarStyle = NSWindowToolbarStyleExpanded;
    }
    backdrop.material = NSVisualEffectMaterialMenu;
    backdrop.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    backdrop.state = NSVisualEffectStateInactive;
    accessory.layoutAttribute = NSLayoutAttributeBottom;
    accessory.fullScreenMinHeight = 28.0;
    [controller applyLiquidGlassTitlebarAppearance];
    Assert(window.titleVisibility == NSWindowTitleHidden &&
               window.titlebarAppearsTransparent,
           "The fullscreen re-host pass must restore the windowed titlebar style.");
    if (@available(macOS 11.0, *)) {
      Assert(window.toolbarStyle == NSWindowToolbarStyleUnifiedCompact,
             "The fullscreen re-host pass must restore the compact toolbar style.");
    }
    Assert(backdrop.material == NSVisualEffectMaterialHeaderView &&
               backdrop.blendingMode == NSVisualEffectBlendingModeBehindWindow &&
               backdrop.state == NSVisualEffectStateFollowsWindowActiveState,
           "The fullscreen re-host pass must restore the same blurred header material.");
    Assert(accessory.layoutAttribute == NSLayoutAttributeTrailing &&
               accessory.fullScreenMinHeight == 40.0,
           "The fullscreen re-host pass must restore the same accessory geometry.");
    Assert([controller valueForKey:@"_tabSurfaces"] == originalTabSurfaces,
           "Re-hosting must preserve the existing Liquid Glass tab surfaces.");
    [controller detachAccessoryController];
    Assert(window.titlebarAccessoryViewControllers.count == 0,
           "Fullscreen transitions must completely detach the accessory host.");
    [controller attachAccessoryController];
    Assert(window.titlebarAccessoryViewControllers.count == 1,
           "Fullscreen transitions must reliably reattach the Liquid Glass tabs.");
    for (NSView *surface in tabSurfaces) {
      Assert(surface.frame.size.height == 28.0,
             "Tab surfaces must use the 28pt visual height.");
      Assert(surface.frame.size.width >= 112.0 &&
                 surface.frame.size.width <= 224.0,
             "Tab surfaces must respect the 112–224pt width range.");
    }
    for (NSView *item in tabItems) AssertItemSubviewsDoNotOverlap(item);
    Assert([[tabItems[0] accessibilityRole]
               isEqualToString:NSAccessibilityRadioButtonRole],
           "Tabs must expose the radio-button accessibility role.");
    Assert([[[tabItems[0] accessibilityValue] description] isEqualToString:@"1"],
           "The active tab must expose its selected accessibility value.");
    Assert(std::fabs(NSMinX(addSurface.frame) -
                         (NSMaxX(scrollView.frame) + 8.0)) < 0.5,
           "The add button must follow the tab strip by 8pt.");
    Assert(NSMaxX(addSurface.frame) < root.bounds.size.width - 12.0,
           "A short tab strip must leave a clean draggable trailing region.");

    CGFloat windowedLeadingInset = scrollView.frame.origin.x;
    CGFloat windowedTrafficReserve = [controller trafficLightReserveWidth];
    NSToolbar *windowedToolbar = window.toolbar;
    [controller setValue:@YES forKey:@"fullscreenTransitionActive"];
    [controller installFreshToolbarForFullScreen];
    NSToolbar *fullscreenToolbar = [controller valueForKey:@"_toolbar"];
    Assert(fullscreenToolbar != windowedToolbar &&
               window.toolbar == fullscreenToolbar &&
               !fullscreenToolbar.visible,
           "Fullscreen must install Chromium's fresh, initially hidden native toolbar host.");
    [controller applyFullScreenPolicy];
    NSTitlebarAccessoryViewController *thinController =
        [controller valueForKey:@"_thinTitlebarController"];
    Assert(window.toolbar == fullscreenToolbar && !window.toolbar.visible &&
               root.superview != window.contentView && !root.hidden &&
               window.titlebarAccessoryViewControllers.count == 2,
           "Fullscreen auto-hide must remain entirely hosted by AppKit titlebar accessories.");
    Assert(accessory.fullScreenMinHeight == 0 && !thinController.hidden &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0 &&
               root.frame.size.height == 40.0,
           "Auto-hide must use full-size game content and let AppKit reveal the 40pt tabs as an overlay.");
    Assert(std::fabs([controller trafficLightReserveWidth] -
                         windowedTrafficReserve) < 0.5 &&
               std::fabs(scrollView.frame.origin.x - windowedLeadingInset) < 0.5,
           "Fullscreen tabs must retain the windowed traffic-light reserve.");

    [controller setRevealLocked:YES];
    Assert(window.toolbar.visible &&
               accessory.fullScreenMinHeight == 40.0 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "A reveal lock must pin the native titlebar while preserving overlay-style full-size content.");
    [controller setRevealLocked:NO];
    Assert(!window.toolbar.visible && accessory.fullScreenMinHeight == 0 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Releasing the final reveal lock must restore AppKit auto-hide.");

    NSButton *closeButton = [window standardWindowButton:NSWindowCloseButton];
    NSButton *minimizeButton =
        [window standardWindowButton:NSWindowMiniaturizeButton];
    NSButton *zoomButton = [window standardWindowButton:NSWindowZoomButton];
    NSRect closeFrame = closeButton.frame;
    NSRect minimizeFrame = minimizeButton.frame;
    NSRect zoomFrame = zoomButton.frame;
    [controller captureWindowedTrafficLightFrames];
    id zoomTarget = zoomButton.target;
    SEL zoomAction = zoomButton.action;
    [controller setAlwaysShowInFullScreen:YES];
    NSArray<NSButton *> *observedFullscreenButtons =
        [controller valueForKey:@"_observedTrafficLightButtons"];
    Assert(window.toolbar.visible && !root.hidden &&
               accessory.fullScreenMinHeight == 40.0 && thinController.hidden &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) == 0,
           "Always-show must reserve a static native 40pt titlebar above the game.");
    Assert(observedFullscreenButtons.count == 3 && !closeButton.hidden &&
               !minimizeButton.hidden && !zoomButton.hidden,
           "Always-show must retain all three AppKit traffic lights.");
    Assert(zoomButton.target == zoomTarget && zoomButton.action == zoomAction,
           "Always-show must retain the native fullscreen traffic-light action.");

    closeButton.frame = NSMakeRect(0, 0, closeFrame.size.width,
                                   closeFrame.size.height);
    minimizeButton.frame = closeButton.frame;
    zoomButton.frame = closeButton.frame;
    zoomButton.state = NSControlStateValueOn;
    NSView *residualFullScreenOverlay = [[NSView alloc]
        initWithFrame:NSUnionRect(closeFrame, zoomFrame)];
    [closeButton.superview addSubview:residualFullScreenOverlay];
    [controller setValue:@NO forKey:@"fullscreenTransitionActive"];
    [controller restoreWindowedTitlebarHost];
    [controller installFreshToolbarForWindowedMode];
    Assert(window.toolbar != fullscreenToolbar,
           "Leaving fullscreen must replace the fullscreen toolbar host with a fresh windowed toolbar.");
    Assert(residualFullScreenOverlay.superview == nil,
           "Leaving fullscreen must remove AppKit's residual fullscreen-exit overlay without replacing the native controls.");
    [controller applyFullScreenPolicy];
    Assert(window.toolbar.visible,
           "Leaving fullscreen must restore the visible windowed toolbar.");
    for (NSButton *button in @[ closeButton, minimizeButton, zoomButton ]) {
      Assert(!button.hidden && button.alphaValue == 1.0 &&
                 button.state == NSControlStateValueOff,
             "Leaving fullscreen must not restore fullscreen-hidden traffic lights over AppKit's windowed state.");
    }
    Assert(!NSIntersectsRect(closeButton.frame, minimizeButton.frame) &&
               !NSIntersectsRect(minimizeButton.frame, zoomButton.frame) &&
               closeButton.frame.size.width == closeFrame.size.width &&
               minimizeButton.frame.size.width == minimizeFrame.size.width &&
               zoomButton.frame.size.width == zoomFrame.size.width,
           "Leaving fullscreen must restore standard, non-overlapping traffic-light geometry.");

    NSToolbar *firstWindowedToolbar = window.toolbar;
    [controller settleWindowedTitlebarAfterFullScreenExit];
    Assert(window.toolbar != firstWindowedToolbar && window.toolbar.visible,
           "The settled exit pass must replace any toolbar still owned by the fullscreen auxiliary window.");
    Assert(window.titlebarAccessoryViewControllers.count == 1,
           "The settled exit pass must reattach one tabs accessory to the normal window.");
    for (NSButton *button in @[ closeButton, minimizeButton, zoomButton ]) {
      Assert(!button.hidden && button.alphaValue == 1.0,
             "The settled exit pass must leave all normal traffic lights visible.");
    }

    [controller setValue:@YES forKey:@"fullscreenTransitionActive"];
    [controller setAlwaysShowInFullScreen:NO];
    Assert(!window.toolbar.visible && accessory.fullScreenMinHeight == 0 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Disabling always-show must immediately restore auto-hide.");
    Assert(NSApplication.sharedApplication.presentationOptions ==
               previousPresentationOptions,
           "Runtime tabs must not mutate process-wide presentation options.");

    [controller setValue:@NO forKey:@"fullscreenTransitionActive"];
    [controller applyFullScreenPolicy];

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
    if (@available(macOS 26.0, *)) {
      NSView *container = [controller valueForKey:@"_clusterContainer"];
      NSView *effect = [tabSurfaces[0] valueForKey:@"_effectView"];
      Assert([container isKindOfClass:NSGlassEffectContainerView.class],
             "macOS 26 must group tab glass in NSGlassEffectContainerView.");
      Assert([effect isKindOfClass:NSGlassEffectView.class],
             "macOS 26 must render tabs with regular Liquid Glass.");
    } else
#endif
    {
      NSView *effect = [tabSurfaces[0] valueForKey:@"_effectView"];
      Assert([effect isKindOfClass:NSVisualEffectView.class],
             "macOS 12–25 must use the visual-effect material fallback.");
    }

    [window setContentSize:NSMakeSize(960, 640)];
    NSMutableArray<RionRuntimeTabModel *> *manyTabs = [NSMutableArray array];
    for (NSInteger index = 0; index < 10; ++index) {
      NSString *identifier = [NSString stringWithFormat:@"many-%ld", (long)index];
      NSString *name = index == 3
                           ? @"A very long workspace name that must truncate safely"
                           : [NSString stringWithFormat:@"Tab %ld", (long)index + 1];
      [manyTabs addObject:MakeTab(identifier, name, index == 9,
                                  index == 3 ? 128 : 0)];
    }
    [controller updateState:MakeState(manyTabs)];
    tabItems = [controller valueForKey:@"_tabItems"];
    tabSurfaces = [controller valueForKey:@"_tabSurfaces"];
    root = [controller valueForKeyPath:@"_accessoryController.view"];
    addSurface = [controller valueForKey:@"_addSurface"];
    scrollView = [controller valueForKey:@"_tabScrollView"];
    Assert(scrollView.documentView.frame.size.width > scrollView.bounds.size.width,
           "Many tabs must overflow into a horizontal scroll view.");
    Assert(scrollView.horizontalScroller == nil ||
               scrollView.horizontalScroller.isHidden,
           "Overflow must not depend on a visible scrollbar.");
    Assert(scrollView.contentView.bounds.origin.x > 0,
           "The active trailing tab must be scrolled into view.");
    NSView *activeSurface = tabSurfaces.lastObject;
    NSRect visibleDocumentRect = scrollView.documentVisibleRect;
    Assert(NSMinX(activeSurface.frame) >= NSMinX(visibleDocumentRect) - 0.5 &&
               NSMaxX(activeSurface.frame) <= NSMaxX(visibleDocumentRect) + 0.5,
           "The active tab must remain fully visible after automatic scrolling.");
    for (NSView *item in tabItems) AssertItemSubviewsDoNotOverlap(item);
    Assert(NSMaxX(addSurface.frame) <= root.bounds.size.width - 12.0 + 0.5,
           "Overflow layout must preserve at least 12pt of draggable space.");

    [controller updateInsertionIndicatorBeforeIdentifier:@"many-3"];
    NSView *insertionIndicator = [controller valueForKey:@"_insertionIndicator"];
    Assert(!insertionIndicator.hidden && insertionIndicator.frame.size.width == 2.0,
           "Dragging must display a 2pt accent insertion indicator.");
    [controller hideInsertionIndicator];
    Assert(insertionIndicator.hidden,
           "The insertion indicator must disappear when dragging ends.");

    NSButton *addButton = root ? [root viewWithTag:41001] : nil;
    Assert(addButton != nil, "Expected the native add button.");
    [addButton performClick:nil];
    Assert([lastAction[@"type"] isEqualToString:@"openLauncher"],
           "Expected the add button to emit openLauncher.");

    [controller handleDropWithTabIdentifier:@"tab-2"
                            sourceDisplayID:11
                           beforeIdentifier:@"tab-1"];
    Assert([lastAction[@"type"] isEqualToString:@"reorder"] &&
               [lastAction[@"tabId"] isEqualToString:@"tab-2"] &&
               [lastAction[@"beforeTabId"] isEqualToString:@"tab-1"],
           "Expected a same-display drag to emit a reorder action.");
    [controller handleDropWithTabIdentifier:@"tab-2"
                            sourceDisplayID:22
                           beforeIdentifier:nil];
    Assert([lastAction[@"type"] isEqualToString:@"move"] &&
               [lastAction[@"tabId"] isEqualToString:@"tab-2"] &&
               [lastAction[@"displayId"] integerValue] == 11,
           "Expected a cross-display drag to emit a move action.");

    [controller setAlwaysShowInFullScreen:YES];
    Assert(controller.alwaysShowInFullScreen,
           "Expected the always-show fullscreen policy.");
    [controller setRevealLocked:YES];
    Assert(controller.revealLocked, "Expected the native reveal lock.");

    [controller destroy];
    Assert(window.titlebarAccessoryViewControllers.count == 0,
           "Destroying the controller must detach its accessory.");
    Assert(window.toolbar == nil,
           "Destroying runtime tabs must restore the previous toolbar.");
    if (@available(macOS 11.0, *)) {
      Assert(window.toolbarStyle == previousToolbarStyle,
             "Destroying runtime tabs must restore the previous toolbar style.");
      Assert(window.titlebarSeparatorStyle == previousTitlebarSeparatorStyle,
             "Destroying runtime tabs must restore the previous titlebar separator style.");
    }
    Assert([window standardWindowButton:NSWindowCloseButton] != nil,
           "Destroying runtime tabs must preserve standard traffic lights.");
  }
  std::cout << "macOS runtime tabs native tests passed" << std::endl;
  return 0;
}
