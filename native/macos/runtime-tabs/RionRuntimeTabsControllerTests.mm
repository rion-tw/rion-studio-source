#import <AppKit/AppKit.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
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
- (void)installPreparedToolbarForFullScreen;
- (void)installFreshToolbarForWindowedMode;
- (void)layoutTitlebarContent;
- (void)restoreWindowedTrafficLightFrames;
- (void)restoreWindowedTitlebarHost;
- (BOOL)attachTitlebarHeightOverrideToFrameView:(nullable NSView *)frameView;
- (BOOL)attachTitlebarWidgetInsetOverride:(CGFloat)inset
                              toFrameView:(nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrideFromFrameView:
    (nullable NSView *)frameView;
- (void)settleWindowedTitlebarAfterFullScreenExit;
- (BOOL)synchronizeTitlebarGeometryForFrameView:(nullable NSView *)frameView;
- (CGFloat)trafficLightReserveWidth;
- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier;

@end

@interface RionTitlebarGeometryProbeView : NSView {
 @private
  CGFloat _customTitlebarHeight;
}

@property(nonatomic) NSUInteger buttonPositionUpdateCount;
@property(nonatomic) CGFloat customTitlebarHeight;
@property(nonatomic) NSUInteger layoutPassCount;
@property(nonatomic, strong) NSMutableArray<NSString *> *geometryEvents;

@end

@implementation RionTitlebarGeometryProbeView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) _geometryEvents = [NSMutableArray array];
  return self;
}

- (CGFloat)customTitlebarHeight {
  return _customTitlebarHeight;
}

- (void)setCustomTitlebarHeight:(CGFloat)height {
  _customTitlebarHeight = height;
  [self.geometryEvents addObject:@"height"];
}

- (void)_updateButtonPositions {
  self.buttonPositionUpdateCount += 1;
  [self.geometryEvents addObject:@"buttons"];
}

- (void)layout {
  self.layoutPassCount += 1;
  [self.geometryEvents addObject:@"layout"];
  [super layout];
}

@end

@interface RionTitlebarWidgetInsetProbeView : NSView

@property(nonatomic) CGFloat nativeTitlebarWidgetInset;

@end

@implementation RionTitlebarWidgetInsetProbeView

- (CGFloat)_minXTitlebarWidgetInset {
  return self.nativeTitlebarWidgetInset;
}

@end

@interface RionInvalidTitlebarWidgetInsetProbeView : NSView
@end

@implementation RionInvalidTitlebarWidgetInsetProbeView

- (id)_minXTitlebarWidgetInset {
  return nil;
}

@end

@interface RionInvalidTitlebarGeometryProbeView : NSView
@end

@implementation RionInvalidTitlebarGeometryProbeView

- (void)setCustomTitlebarHeight:(id)value {
  (void)value;
}

- (NSInteger)_updateButtonPositions {
  return 0;
}

@end

static void Assert(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << std::endl;
    std::exit(1);
  }
}

static BOOL ReadTitlebarHeight(NSView *frameView, CGFloat *height) {
  if (!frameView || !height) return NO;
  SEL selector = NSSelectorFromString(@"_titlebarHeight");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation invoke];
  [invocation getReturnValue:height];
  return YES;
}

static void AssertTitlebarHeight(NSView *frameView, CGFloat expected,
                                 const char *message) {
  CGFloat height = -1;
  Assert(ReadTitlebarHeight(frameView, &height) &&
             std::fabs(height - expected) < 0.01,
         message);
}

static BOOL ReadTitlebarWidgetInset(NSView *frameView, CGFloat *inset) {
  if (!frameView || !inset) return NO;
  SEL selector = NSSelectorFromString(@"_minXTitlebarWidgetInset");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation invoke];
  [invocation getReturnValue:inset];
  return YES;
}

static BOOL ReadCustomTitlebarHeightIfSupported(NSView *frameView,
                                                 CGFloat *height) {
  if (!frameView || !height) return NO;
  SEL selector = NSSelectorFromString(@"customTitlebarHeight");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation invoke];
  [invocation getReturnValue:height];
  return YES;
}

static BOOL SetCustomTitlebarHeightIfSupported(NSView *frameView,
                                                CGFloat height) {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"setCustomTitlebarHeight:");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  const char *argumentType = signature && signature.numberOfArguments == 3
      ? [signature getArgumentTypeAtIndex:2]
      : nullptr;
  if (!signature || signature.numberOfArguments != 3 ||
      signature.methodReturnLength != 0 || !argumentType ||
      std::strcmp(argumentType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation setArgument:&height atIndex:2];
  [invocation invoke];
  return YES;
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
  if (item.frame.size.width < 279.5) {
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

static void AssertTitleTextVerticallyCentered(NSView *item) {
  NSTextField *titleField = [item valueForKey:@"_titleField"];
  NSTextFieldCell *titleCell = (NSTextFieldCell *)titleField.cell;
  Assert([titleCell isKindOfClass:
                        NSClassFromString(@"RionRuntimeVerticallyCenteredTextFieldCell")],
         "Tab names must use the vertically centered native text-field cell.");
  Assert(titleCell.alignment == NSTextAlignmentLeft,
         "Vertically centering tab names must preserve their left alignment.");

  NSRect titleRect = [titleCell titleRectForBounds:titleField.bounds];
  NSFont *font = titleCell.font;
  CGFloat metricHeight =
      MIN(NSHeight(titleField.bounds),
          ceil(font.ascender - font.descender + font.leading));
  Assert(std::fabs(NSMidY(titleRect) - NSMidY(titleField.bounds)) < 0.01 &&
             std::fabs(NSHeight(titleRect) - metricHeight) < 0.01,
         "Tab-name title rects must be vertically centered from native font metrics.");
}

static void AssertBadgeTextVerticallyCentered(NSView *item,
                                              NSInteger count) {
  NSView *badge = [item valueForKey:@"_badgeView"];
  NSTextField *badgeField = [item valueForKey:@"_badgeField"];
  NSTextFieldCell *badgeCell = (NSTextFieldCell *)badgeField.cell;
  NSString *expected = [NSString stringWithFormat:@"%ld", (long)count];
  Assert(!badge.hidden && badge.frame.size.height == 16.0 &&
             [badgeField.stringValue isEqualToString:expected],
         "One-, two-, and three-digit badges must retain the 16pt badge height.");
  Assert([badgeCell isKindOfClass:
                        NSClassFromString(@"RionRuntimeVerticallyCenteredTextFieldCell")],
         "Badges must use the vertically centered native text-field cell.");

  NSRect titleRect = [badgeCell titleRectForBounds:badgeField.bounds];
  NSFont *font = badgeCell.font;
  CGFloat metricHeight =
      MIN(NSHeight(badgeField.bounds),
          ceil(font.ascender - font.descender + font.leading));
  Assert(std::fabs(NSMidY(titleRect) - NSMidY(badgeField.bounds)) < 0.01 &&
             std::fabs(NSHeight(titleRect) - metricHeight) < 0.01,
         "Badge title rects must be vertically centered from native font metrics.");

  NSView *title = [item valueForKey:@"_titleField"];
  NSView *more = [item valueForKey:@"_moreButton"];
  Assert(std::fabs(NSMaxX(badge.frame) - (NSMinX(more.frame) - 4.0)) < 0.01 &&
             std::fabs(NSMaxX(title.frame) - (NSMinX(badge.frame) - 4.0)) <
                 0.01,
         "The badge and more button must keep fixed trailing slots while the title receives the remaining width.");
}

int main() {
  @autoreleasepool {
    RionRuntimeContentLayout flippedLayout =
        RionRuntimeContentLayoutForRects(NSMakeRect(0, 0, 900, 600),
                                         NSMakeRect(0, 8, 900, 592), YES);
    Assert(flippedLayout.yOffset == 8 && flippedLayout.heightInset == 8,
           "Flipped content coordinates must preserve AppKit's top layout inset.");
    RionRuntimeContentLayout unflippedLayout =
        RionRuntimeContentLayoutForRects(NSMakeRect(0, 0, 900, 600),
                                         NSMakeRect(0, 0, 900, 592), NO);
    Assert(unflippedLayout.yOffset == 8 &&
               unflippedLayout.heightInset == 8,
           "Unflipped content coordinates must measure the inset from the visual top.");
    RionRuntimeContentLayout splitInsets =
        RionRuntimeContentLayoutForRects(NSMakeRect(0, 0, 900, 600),
                                         NSMakeRect(0, 8, 900, 580), YES);
    Assert(splitInsets.yOffset == 8 && splitInsets.heightInset == 20,
           "The layout conversion must retain distinct top and total height insets.");
    RionRuntimeContentLayout roundedLayout =
        RionRuntimeContentLayoutForRects(NSMakeRect(0, 0, 900, 600),
                                         NSMakeRect(0, 7.6, 900, 592.4), YES);
    Assert(roundedLayout.yOffset == 8 && roundedLayout.heightInset == 8,
           "Fractional AppKit geometry must be rounded to integer DIP values.");
    RionRuntimeContentLayout clippedLayout =
        RionRuntimeContentLayoutForRects(NSMakeRect(0, 0, 900, 600),
                                         NSMakeRect(0, -10, 900, 620), YES);
    Assert(clippedLayout.yOffset == 0 && clippedLayout.heightInset == 0,
           "Layout geometry outside the content bounds must be clipped safely.");

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
    BOOL previousFullSizeContentView =
        (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0;
    NSApplicationPresentationOptions previousPresentationOptions =
        NSApplication.sharedApplication.presentationOptions;
    NSView *originalTitlebarFrameView = window.contentView.superview;
    CGFloat originalTitlebarHeight = -1;
    Assert(ReadTitlebarHeight(originalTitlebarFrameView,
                              &originalTitlebarHeight),
           "Expected AppKit's titlebar frame to expose its native height.");
    CGFloat originalCustomTitlebarHeight = -1;
    BOOL supportsCustomTitlebarHeight =
        ReadCustomTitlebarHeightIfSupported(originalTitlebarFrameView,
                                            &originalCustomTitlebarHeight);
    CGFloat originalTitlebarWidgetInset = -1;
    BOOL supportsTitlebarWidgetInset =
        ReadTitlebarWidgetInset(originalTitlebarFrameView,
                                &originalTitlebarWidgetInset);

    // The hook is installed per frame class, but its 40pt result must be
    // scoped by an associated marker to only the Rion-managed window.
    NSWindow *controlWindow = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 900, 600)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    NSView *controlTitlebarFrameView = controlWindow.contentView.superview;
    CGFloat controlTitlebarHeight = -1;
    Assert(ReadTitlebarHeight(controlTitlebarFrameView,
                              &controlTitlebarHeight),
           "Expected the control window to expose its native titlebar height.");
    CGFloat controlCustomTitlebarHeight = -1;
    BOOL controlSupportsCustomTitlebarHeight =
        ReadCustomTitlebarHeightIfSupported(controlTitlebarFrameView,
                                            &controlCustomTitlebarHeight);
    CGFloat controlTitlebarWidgetInset = -1;
    BOOL controlSupportsTitlebarWidgetInset =
        ReadTitlebarWidgetInset(controlTitlebarFrameView,
                                &controlTitlebarWidgetInset);

    __block NSDictionary<NSString *, id> *lastAction = nil;
    RionRuntimeTabsController *controller = [[RionRuntimeTabsController alloc]
        initWithWindow:window
         actionHandler:^(NSDictionary<NSString *, id> *action) {
      lastAction = action;
    }];
    Assert(controller != nil, "Expected the native runtime tabs controller.");
    NSView *contentView = window.contentView;
    [contentView.superview layoutSubtreeIfNeeded];
    NSRect convertedContentLayoutRect =
        [contentView convertRect:window.contentLayoutRect fromView:nil];
    RionRuntimeContentLayout expectedWindowedLayout =
        RionRuntimeContentLayoutForRects(contentView.bounds,
                                         convertedContentLayoutRect,
                                         contentView.isFlipped);
    RionRuntimeContentLayout actualWindowedLayout =
        [controller windowedContentLayout];
    Assert(actualWindowedLayout.yOffset == expectedWindowedLayout.yOffset &&
               actualWindowedLayout.heightInset ==
                   expectedWindowedLayout.heightInset &&
               actualWindowedLayout.yOffset >= 0 &&
               actualWindowedLayout.heightInset >=
                   actualWindowedLayout.yOffset &&
               actualWindowedLayout.heightInset <=
                   floor(contentView.bounds.size.height),
           "The controller must expose AppKit's contentLayoutRect in bounded content-view coordinates.");
    NSView *titlebarFrameView = window.contentView.superview;
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "A Rion-managed frame must expose the 40pt titlebar height used by fullscreen reveal.");
    AssertTitlebarHeight(
        controlTitlebarFrameView, controlTitlebarHeight,
        "Installing the frame hook must not change unmarked windows of the same AppKit class.");
    CGFloat expectedFullscreenWidgetInset = supportsTitlebarWidgetInset
        ? originalTitlebarWidgetInset
        : 13.0;
    CGFloat managedWindowedInset = -1;
    BOOL managedSupportsTitlebarWidgetInset =
        ReadTitlebarWidgetInset(titlebarFrameView, &managedWindowedInset);
    if (supportsTitlebarWidgetInset) {
      NSNumber *capturedInset =
          [controller valueForKey:@"stableTitlebarWidgetInset"];
      NSNumber *hasCapturedInset =
          [controller valueForKey:@"hasStableTitlebarWidgetInset"];
      Assert(hasCapturedInset.boolValue &&
                 std::fabs(capturedInset.doubleValue -
                           originalTitlebarWidgetInset) < 0.01,
             "The controller must capture Chromium's windowed horizontal inset before changing the toolbar host.");
    }
    if (controlSupportsTitlebarWidgetInset) {
      CGFloat controlWindowedInset = -1;
      Assert(ReadTitlebarWidgetInset(controlTitlebarFrameView,
                                     &controlWindowedInset) &&
                 std::fabs(controlWindowedInset -
                           controlTitlebarWidgetInset) < 0.01,
             "Creating runtime tabs must not change an unmanaged window's native horizontal inset.");
    }
    if (managedSupportsTitlebarWidgetInset &&
        controlSupportsTitlebarWidgetInset) {
      Assert([controller
                 attachTitlebarWidgetInsetOverride:expectedFullscreenWidgetInset
                                        toFrameView:titlebarFrameView],
             "The managed frame must accept the captured fullscreen horizontal inset.");
      CGFloat overriddenManagedInset = -1;
      CGFloat unchangedControlInset = -1;
      Assert(ReadTitlebarWidgetInset(titlebarFrameView,
                                     &overriddenManagedInset) &&
                 std::fabs(overriddenManagedInset -
                           expectedFullscreenWidgetInset) < 0.01 &&
                 ReadTitlebarWidgetInset(controlTitlebarFrameView,
                                         &unchangedControlInset) &&
                 std::fabs(unchangedControlInset -
                           controlTitlebarWidgetInset) < 0.01,
             "A per-instance fullscreen inset marker must not affect an unmarked frame of the same AppKit class.");
      [controller
          detachTitlebarWidgetInsetOverrideFromFrameView:titlebarFrameView];
      CGFloat restoredManagedInset = -1;
      CGFloat restoredControlInset = -1;
      Assert(ReadTitlebarWidgetInset(titlebarFrameView,
                                     &restoredManagedInset) &&
                 std::fabs(restoredManagedInset - managedWindowedInset) <
                     0.01 &&
                 ReadTitlebarWidgetInset(controlTitlebarFrameView,
                                         &restoredControlInset) &&
                 std::fabs(restoredControlInset -
                           controlTitlebarWidgetInset) < 0.01,
             "Removing the fullscreen marker must restore both windowed frames to their native horizontal insets.");
    }
    BOOL toolbarVisibleBeforeGeometrySync = window.toolbar.visible;
    if (supportsCustomTitlebarHeight &&
        SetCustomTitlebarHeightIfSupported(titlebarFrameView, -1.0)) {
      AssertTitlebarHeight(
          titlebarFrameView, 40.0,
          "AppKit resetting customTitlebarHeight during fullscreen entry must not collapse the marked frame to 32pt.");
      Assert([controller
                 synchronizeTitlebarGeometryForFrameView:titlebarFrameView],
             "Fullscreen geometry sync must restore AppKit's internal titlebar metric and update its window buttons.");
      CGFloat synchronizedCustomTitlebarHeight = -1;
      Assert(ReadCustomTitlebarHeightIfSupported(
                 titlebarFrameView, &synchronizedCustomTitlebarHeight) &&
                 std::fabs(synchronizedCustomTitlebarHeight - 40.0) < 0.01,
             "Fullscreen geometry sync must restore customTitlebarHeight to 40pt after AppKit resets it.");
    }
    RionTitlebarGeometryProbeView *geometryProbe =
        [[RionTitlebarGeometryProbeView alloc] initWithFrame:NSZeroRect];
    geometryProbe.customTitlebarHeight = -1.0;
    [geometryProbe.geometryEvents removeAllObjects];
    Assert([controller synchronizeTitlebarGeometryForFrameView:geometryProbe] &&
               std::fabs(geometryProbe.customTitlebarHeight - 40.0) < 0.01 &&
               geometryProbe.buttonPositionUpdateCount == 1 &&
               geometryProbe.layoutPassCount == 1 &&
               [geometryProbe.geometryEvents isEqualToArray:
                   @[ @"height", @"buttons", @"layout" ]],
          "Geometry sync must update the 40pt metric, button positions and layout without driving reveal state.");
    RionInvalidTitlebarGeometryProbeView *invalidGeometryProbe =
        [[RionInvalidTitlebarGeometryProbeView alloc] initWithFrame:NSZeroRect];
    Assert(![controller
               synchronizeTitlebarGeometryForFrameView:invalidGeometryProbe],
           "Invalid private selector signatures must fail safely.");
    RionTitlebarWidgetInsetProbeView *firstInsetHost =
        [[RionTitlebarWidgetInsetProbeView alloc] initWithFrame:NSZeroRect];
    firstInsetHost.nativeTitlebarWidgetInset = 5.0;
    RionTitlebarWidgetInsetProbeView *secondInsetHost =
        [[RionTitlebarWidgetInsetProbeView alloc] initWithFrame:NSZeroRect];
    secondInsetHost.nativeTitlebarWidgetInset = 7.0;
    RionTitlebarWidgetInsetProbeView *unmarkedInsetHost =
        [[RionTitlebarWidgetInsetProbeView alloc] initWithFrame:NSZeroRect];
    unmarkedInsetHost.nativeTitlebarWidgetInset = 9.0;
    Assert([controller
               attachTitlebarWidgetInsetOverride:expectedFullscreenWidgetInset
                                      toFrameView:firstInsetHost],
           "A fullscreen host with a valid inset getter must accept the per-instance override.");
    CGFloat firstOverriddenInset = -1;
    CGFloat unmarkedNativeInset = -1;
    Assert(ReadTitlebarWidgetInset(firstInsetHost, &firstOverriddenInset) &&
               std::fabs(firstOverriddenInset -
                         expectedFullscreenWidgetInset) < 0.01 &&
               ReadTitlebarWidgetInset(unmarkedInsetHost,
                                       &unmarkedNativeInset) &&
               std::fabs(unmarkedNativeInset - 9.0) < 0.01,
           "The fullscreen inset marker must not affect an unmarked host of the same class.");
    [controller
        detachTitlebarWidgetInsetOverrideFromFrameView:firstInsetHost];
    Assert([controller
               attachTitlebarWidgetInsetOverride:expectedFullscreenWidgetInset
                                      toFrameView:secondInsetHost],
           "Rehosting must transfer the horizontal inset marker to the new frame.");
    CGFloat restoredFirstInset = -1;
    CGFloat secondOverriddenInset = -1;
    Assert(ReadTitlebarWidgetInset(firstInsetHost, &restoredFirstInset) &&
               std::fabs(restoredFirstInset - 5.0) < 0.01 &&
               ReadTitlebarWidgetInset(secondInsetHost,
                                       &secondOverriddenInset) &&
               std::fabs(secondOverriddenInset -
                         expectedFullscreenWidgetInset) < 0.01,
           "Replacing the fullscreen host must restore the old frame and mark only the new frame.");
    RionInvalidTitlebarWidgetInsetProbeView *invalidInsetHost =
        [[RionInvalidTitlebarWidgetInsetProbeView alloc]
            initWithFrame:NSZeroRect];
    Assert(![controller
               attachTitlebarWidgetInsetOverride:expectedFullscreenWidgetInset
                                      toFrameView:invalidInsetHost],
           "An invalid horizontal inset selector signature must fail safely.");
    Assert(window.toolbar.visible == toolbarVisibleBeforeGeometrySync,
           "Geometry sync must not reveal, hide or pin the toolbar.");
    if (controlSupportsCustomTitlebarHeight) {
      CGFloat unchangedControlCustomTitlebarHeight = -1;
      Assert(ReadCustomTitlebarHeightIfSupported(
                 controlTitlebarFrameView,
                 &unchangedControlCustomTitlebarHeight) &&
                 std::fabs(unchangedControlCustomTitlebarHeight -
                           controlCustomTitlebarHeight) < 0.01,
             "Fullscreen geometry sync must not change an unmarked control window.");
    }
    Assert(window.titleVisibility == NSWindowTitleHidden,
           "Expected the native title to be hidden.");
    Assert(window.titlebarAppearsTransparent,
           "Expected the system titlebar material to remain visible through the accessory.");
    Assert(window.titlebarAccessoryViewControllers.count == 1,
           "Expected one titlebar accessory controller.");
    Assert(window.toolbar != nil && window.toolbar.visible,
           "Normal windows must use a visible compact toolbar for titlebar height and material.");
    NSView *unsupportedFrameView = [[NSView alloc] initWithFrame:NSZeroRect];
    Assert(![controller
               attachTitlebarHeightOverrideToFrameView:unsupportedFrameView],
           "A frame without AppKit's private titlebar metric must fail safely.");
    Assert(![controller
               attachTitlebarWidgetInsetOverride:expectedFullscreenWidgetInset
                                      toFrameView:unsupportedFrameView],
           "A frame without AppKit's private widget inset must fail safely.");
    Assert(![controller
               synchronizeTitlebarGeometryForFrameView:unsupportedFrameView],
           "A frame without fullscreen geometry selectors must fail safely.");
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
    Assert([accessory isMemberOfClass:NSTitlebarAccessoryViewController.class] &&
               accessory.layoutAttribute == NSLayoutAttributeTrailing &&
               accessory.fullScreenMinHeight == 40.0,
           "Runtime tabs must use one standard 40pt titlebar accessory.");

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
               accessory.fullScreenMinHeight == 28.0,
           "Appearance refreshes must not transiently rewrite fullscreen geometry.");
    [controller applyFullScreenPolicy];
    Assert(accessory.fullScreenMinHeight == 40.0,
           "The windowed policy must restore the settled 40pt accessory geometry.");
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
      Assert(surface.frame.size.width >= 144.0 &&
                 surface.frame.size.width <= 280.0,
             "Tab surfaces must respect the 144–280pt width range.");
    }
    for (NSView *item in tabItems) {
      AssertItemSubviewsDoNotOverlap(item);
      AssertTitleTextVerticallyCentered(item);
    }
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

    for (NSNumber *count in @[ @1, @12, @123 ]) {
      RionRuntimeTabModel *countedWorkspace =
          MakeTab(@"tab-2", @"Team", NO, count.integerValue);
      [controller updateState:MakeState(@[ role, countedWorkspace ])];
      NSArray<NSView *> *countedItems = [controller valueForKey:@"_tabItems"];
      AssertBadgeTextVerticallyCentered(countedItems[1], count.integerValue);
      AssertItemSubviewsDoNotOverlap(countedItems[1]);
    }
    [controller updateState:state];

    CGFloat windowedLeadingInset = scrollView.frame.origin.x;
    CGFloat windowedTrafficReserve = [controller trafficLightReserveWidth];
    NSToolbar *windowedToolbar = window.toolbar;
    NSToolbar *preparedFullscreenToolbar =
        [controller valueForKey:@"_fullscreenToolbar"];
    [controller setAlwaysShowInFullScreen:YES];
    [controller prepareForFullscreenTransition:YES];
    NSToolbar *fullscreenToolbar = [controller valueForKey:@"_toolbar"];
    Assert(fullscreenToolbar == preparedFullscreenToolbar &&
               fullscreenToolbar != windowedToolbar &&
               window.toolbar == fullscreenToolbar &&
               !fullscreenToolbar.visible && fullscreenToolbar.delegate == nil &&
               fullscreenToolbar.items.count == 0,
           "Fullscreen preflight must install the prepared empty toolbar before AppKit starts its transition.");
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "Fullscreen preflight must preserve the 40pt frame metric before AppKit snapshots it.");
    Assert(accessory.fullScreenMinHeight == 40.0 &&
               window.titlebarAccessoryViewControllers.count == 1 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Fullscreen preflight must preserve one stable 40pt native accessory.");
    [controller applyFullScreenPolicy];
    Assert(window.toolbar.visible && accessory.fullScreenMinHeight == 40.0 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Did-enter always-show must keep Electron's fullscreen root content full-size.");
    [controller setAlwaysShowInFullScreen:NO];
    Assert(!accessory.hidden &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Always-to-auto-hide must keep the single accessory over the same full-size root content.");
    [controller prepareForFullscreenTransition:YES];
    Assert(window.toolbar == fullscreenToolbar && !window.toolbar.visible &&
               accessory.fullScreenMinHeight == 40.0 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Auto-hide preflight must establish the final tab row before AppKit snapshots fullscreen geometry.");
    [controller applyLiquidGlassTitlebarAppearance];
    Assert(fullscreenToolbar.delegate == nil &&
               fullscreenToolbar.items.count == 0,
           "Fullscreen appearance passes must not restore the windowed layout spacer.");
    [controller applyFullScreenPolicy];
    Assert(window.toolbar == fullscreenToolbar && !window.toolbar.visible &&
               window.toolbar.delegate == nil && window.toolbar.items.count == 0 &&
               root.superview != window.contentView && !root.hidden &&
               !accessory.hidden &&
               window.titlebarAccessoryViewControllers.count == 1,
           "Fullscreen auto-hide must use exactly one AppKit titlebar accessory.");
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "Fullscreen auto-hide must retain the frame-level 40pt reveal metric.");
    Assert(accessory.fullScreenMinHeight == 40.0 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0 &&
               root.frame.size.height == 40.0,
           "Auto-hide must keep one stable 40pt tab row over full-size game content.");
    Assert(std::fabs([controller trafficLightReserveWidth] -
                         windowedTrafficReserve) < 0.5 &&
               std::fabs(scrollView.frame.origin.x - windowedLeadingInset) < 0.5,
           "Fullscreen tabs must retain the windowed traffic-light reserve.");

    [controller setRevealLocked:YES];
    Assert(window.toolbar.visible &&
               accessory.fullScreenMinHeight == 40.0 &&
               window.titlebarAccessoryViewControllers.count == 1 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "A reveal lock must pin the native titlebar while preserving overlay-style full-size content.");
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "A reveal lock must not change the fullscreen frame height.");
    [controller setRevealLocked:NO];
    Assert(!window.toolbar.visible && accessory.fullScreenMinHeight == 40.0 &&
               window.titlebarAccessoryViewControllers.count == 1 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Releasing a reveal lock must return the single native host to AppKit auto-hide.");
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "Releasing a reveal lock must restore auto-hide at the same 40pt frame height.");

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
               window.toolbar.delegate == nil && window.toolbar.items.count == 0 &&
               accessory.fullScreenMinHeight == 40.0 && !accessory.hidden &&
               window.titlebarAccessoryViewControllers.count == 1 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Always-show must reveal one 40pt native row over the unchanged full-size root content.");
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "Switching to always-show must preserve the fullscreen frame metric.");
    Assert(observedFullscreenButtons.count == 3 && !closeButton.hidden &&
               !minimizeButton.hidden && !zoomButton.hidden,
           "Always-show must retain all three AppKit traffic lights.");
    Assert(zoomButton.target == zoomTarget && zoomButton.action == zoomAction,
           "Always-show must retain the native fullscreen traffic-light action.");

    [controller setAlwaysShowInFullScreen:YES];
    Assert(window.titlebarAccessoryViewControllers.count == 1 &&
               fullscreenToolbar.items.count == 0,
           "Repeating the same policy must not rebuild native toolbar state.");
    [controller setRevealLocked:YES];
    [controller setAlwaysShowInFullScreen:NO];
    Assert(window.toolbar.visible && !accessory.hidden &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Switching to auto-hide under a reveal lock must use overlay layout while keeping the toolbar pinned.");
    [controller setRevealLocked:NO];
    Assert(!window.toolbar.visible,
           "Releasing the lock after a policy switch must hide natively.");
    [controller setAlwaysShowInFullScreen:YES];
    Assert(window.toolbar.visible && !accessory.hidden &&
               window.titlebarAccessoryViewControllers.count == 1 &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Repeated bidirectional policy switches must preserve one visible native accessory.");

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
    Assert(window.toolbar != fullscreenToolbar &&
               window.toolbar.delegate == controller &&
               window.toolbar.items.count == 1 &&
               window.toolbar.items.firstObject.view.frame.size.height == 28.0,
           "Leaving fullscreen must restore a fresh windowed toolbar with its 28pt layout spacer.");
    Assert([controller valueForKey:@"_fullscreenToolbar"] != fullscreenToolbar,
           "Windowed settlement must prepare a fresh empty toolbar for the next fullscreen entry.");
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
    Assert(window.toolbar != firstWindowedToolbar && window.toolbar.visible &&
               window.toolbar.delegate == controller &&
               window.toolbar.items.count == 1,
           "The settled exit pass must replace any fullscreen toolbar with the windowed spacer host.");
    Assert(window.titlebarAccessoryViewControllers.count == 1,
           "The settled exit pass must reattach one tabs accessory to the normal window.");
    for (NSButton *button in @[ closeButton, minimizeButton, zoomButton ]) {
      Assert(!button.hidden && button.alphaValue == 1.0,
             "The settled exit pass must leave all normal traffic lights visible.");
    }

    [controller prepareForFullscreenTransition:YES];
    [controller setAlwaysShowInFullScreen:NO];
    Assert(!window.toolbar.visible && accessory.fullScreenMinHeight == 40.0 &&
               !accessory.hidden &&
               (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
           "Disabling always-show must immediately restore auto-hide.");
    AssertTitlebarHeight(
        titlebarFrameView, 40.0,
        "Returning to auto-hide must retain the 40pt frame-level metric.");
    Assert(NSApplication.sharedApplication.presentationOptions ==
               previousPresentationOptions,
           "Runtime tabs must not mutate process-wide presentation options.");

    [controller prepareForFullscreenTransition:NO];

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
    Assert([controller
               attachTitlebarWidgetInsetOverride:expectedFullscreenWidgetInset
                                      toFrameView:secondInsetHost],
           "The destroy path must be exercised with an active fullscreen inset marker.");

    [controller destroy];
    if (supportsCustomTitlebarHeight) {
      CGFloat restoredCustomTitlebarHeight = -1;
      Assert(ReadCustomTitlebarHeightIfSupported(
                 originalTitlebarFrameView,
                 &restoredCustomTitlebarHeight) &&
                 std::fabs(restoredCustomTitlebarHeight -
                           originalCustomTitlebarHeight) < 0.01,
             "Destroying runtime tabs must restore the original custom titlebar metric.");
    }
    AssertTitlebarHeight(
        originalTitlebarFrameView, originalTitlebarHeight,
        "Destroying runtime tabs must remove the per-window titlebar height marker.");
    AssertTitlebarHeight(
        controlTitlebarFrameView, controlTitlebarHeight,
        "Destroying runtime tabs must leave other windows on AppKit's original metric.");
    CGFloat restoredSecondInset = -1;
    CGFloat finalUnmarkedInset = -1;
    Assert(ReadTitlebarWidgetInset(secondInsetHost, &restoredSecondInset) &&
               std::fabs(restoredSecondInset - 7.0) < 0.01 &&
               ReadTitlebarWidgetInset(unmarkedInsetHost,
                                       &finalUnmarkedInset) &&
               std::fabs(finalUnmarkedInset - 9.0) < 0.01,
           "Destroying runtime tabs must remove fullscreen inset markers without changing unmarked hosts.");
    if (supportsTitlebarWidgetInset && controlSupportsTitlebarWidgetInset) {
      CGFloat restoredManagedInset = -1;
      CGFloat restoredControlInset = -1;
      Assert(ReadTitlebarWidgetInset(originalTitlebarFrameView,
                                     &restoredManagedInset) &&
                 std::fabs(restoredManagedInset -
                           originalTitlebarWidgetInset) < 0.01 &&
                 ReadTitlebarWidgetInset(controlTitlebarFrameView,
                                         &restoredControlInset) &&
                 std::fabs(restoredControlInset -
                           controlTitlebarWidgetInset) < 0.01,
             "Destroying runtime tabs must preserve the original horizontal metrics of managed and control windows.");
    }
    Assert(window.titlebarAccessoryViewControllers.count == 0,
           "Destroying the controller must detach its accessory.");
    Assert(window.toolbar == nil,
           "Destroying runtime tabs must restore the previous toolbar.");
    Assert(((window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0) ==
               previousFullSizeContentView,
           "Destroying runtime tabs must restore the window's original content-view style.");
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
