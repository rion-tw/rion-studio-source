#import "RionRuntimeTabsController.h"
#import <objc/runtime.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <unordered_map>

// Unified compact is AppKit's 40pt titlebar host on macOS 12 and newer. Keep
// the accessory at the exact host height so the blur covers the whole row and
// never leaves a separator-colored strip above the game content.
static const CGFloat kRionTitlebarHeight = 40.0;
static const CGFloat kRionTabHeight = 28.0;
static const CGFloat kRionTabMinimumWidth = 144.0;
static const CGFloat kRionTabMaximumWidth = 280.0;
static const CGFloat kRionTabSpacing = 6.0;
static const CGFloat kRionTabLeadingPadding = 10.0;
static const CGFloat kRionTabIconSize = 16.0;
static const CGFloat kRionTabIconTitleSpacing = 6.0;
static const CGFloat kRionTabAccessorySpacing = 4.0;
static const CGFloat kRionTabMoreButtonWidth = 20.0;
static const CGFloat kRionTabTrailingPadding = 8.0;
static const CGFloat kRionBadgeHeight = 16.0;
static const CGFloat kRionBadgeMinimumWidth = 18.0;
static const CGFloat kRionBadgeHorizontalPadding = 10.0;
static const CGFloat kRionAddButtonSpacing = 8.0;
static const CGFloat kRionRootLeadingInset = 4.0;
static const CGFloat kRionRootTrailingDraggableWidth = 12.0;
static const CGFloat kRionTrafficLightFallbackWidth = 76.0;
static const NSInteger kRionAddButtonTag = 41001;
static NSToolbarItemIdentifier const RionRuntimeToolbarSpacerIdentifier =
    @"com.rionstudio.runtime-tabs.layout-spacer";
static NSPasteboardType const RionRuntimeTabPasteboardType =
    @"com.rionstudio.runtime-tab";

static char RionRuntimeTitlebarHeightAssociationKey;
static std::mutex RionRuntimeTitlebarHeightHookMutex;
static std::unordered_map<Class, IMP> RionRuntimeOriginalTitlebarHeightIMPs;
static char RionRuntimeTitlebarWidgetInsetAssociationKey;
static std::mutex RionRuntimeTitlebarWidgetInsetHookMutex;
static std::unordered_map<Class, IMP>
    RionRuntimeOriginalTitlebarWidgetInsetIMPs;

RionRuntimeContentLayout RionRuntimeContentLayoutForRects(
    NSRect contentBounds, NSRect contentLayoutRect, BOOL contentViewFlipped) {
  RionRuntimeContentLayout result = {0, 0, NO};
  const CGFloat contentHeight = NSHeight(contentBounds);
  if (!std::isfinite(NSMinX(contentBounds)) ||
      !std::isfinite(NSMinY(contentBounds)) ||
      !std::isfinite(NSWidth(contentBounds)) ||
      !std::isfinite(contentHeight) || contentHeight <= 0 ||
      !std::isfinite(NSMinX(contentLayoutRect)) ||
      !std::isfinite(NSMinY(contentLayoutRect)) ||
      !std::isfinite(NSWidth(contentLayoutRect)) ||
      !std::isfinite(NSHeight(contentLayoutRect))) {
    return result;
  }

  NSRect clippedLayoutRect = NSIntersectionRect(contentBounds,
                                                 contentLayoutRect);
  if (NSIsEmptyRect(clippedLayoutRect)) return result;

  const CGFloat topInset = contentViewFlipped
      ? NSMinY(clippedLayoutRect) - NSMinY(contentBounds)
      : NSMaxY(contentBounds) - NSMaxY(clippedLayoutRect);
  const CGFloat totalInset = contentHeight - NSHeight(clippedLayoutRect);
  const CGFloat maximumInset = floor(contentHeight);
  result.yOffset = MIN(maximumInset, MAX(0.0, round(topInset)));
  result.heightInset = MIN(maximumInset,
                           MAX(result.yOffset, round(totalInset)));
  result.valid = YES;
  return result;
}

// Electron's BrowserWindowFrame deliberately falls back to AppKit's 32pt
// fullscreen metric unless Chromium's tabbed immersive-mode controller is
// present. Rion uses AppKit's native fullscreen host without that Chromium
// controller, so wrap the frame getter and opt in only marked Rion windows.
// The class-level hook remains safe for every other instance by forwarding to
// the exact original implementation saved for that frame class.
//
// Chromium also overrides _minXTitlebarWidgetInset on BrowserWindowFrame for
// macOS 26, but AppKit's auxiliary fullscreen toolbar window has its own frame
// class and misses that metric. Mirror the windowed value onto only the active
// Rion frame instances so AppKit can lay out its own controls at the same inset.
static void RionLogTitlebarHeightOverrideUnavailable(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSLog(@"Rion Studio could not configure the native titlebar height; "
          "AppKit's default metric will be used.");
  });
}

static void RionLogFullscreenTitlebarGeometrySyncUnavailable(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSLog(@"Rion Studio could not synchronize the fullscreen titlebar "
          "geometry; AppKit's window-button layout will be used.");
  });
}

static void RionLogTitlebarWidgetInsetOverrideUnavailable(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSLog(@"Rion Studio could not align the fullscreen window controls; "
          "AppKit's native horizontal inset will be used.");
  });
}

static IMP RionOriginalTitlebarHeightIMPForObject(id object) {
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarHeightHookMutex);
  for (Class candidate = object_getClass(object); candidate;
       candidate = class_getSuperclass(candidate)) {
    auto found = RionRuntimeOriginalTitlebarHeightIMPs.find(candidate);
    if (found != RionRuntimeOriginalTitlebarHeightIMPs.end()) {
      return found->second;
    }
  }
  return nullptr;
}

static CGFloat RionRuntimeTitlebarHeight(id frameView, SEL selector) {
  NSNumber *overrideHeight = objc_getAssociatedObject(
      frameView, &RionRuntimeTitlebarHeightAssociationKey);
  if (overrideHeight) return overrideHeight.doubleValue;

  IMP original = RionOriginalTitlebarHeightIMPForObject(frameView);
  if (!original) return 0;
  using TitlebarHeightFunction = CGFloat (*)(id, SEL);
  return reinterpret_cast<TitlebarHeightFunction>(original)(frameView, selector);
}

static IMP RionOriginalTitlebarWidgetInsetIMPForObject(id object) {
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarWidgetInsetHookMutex);
  for (Class candidate = object_getClass(object); candidate;
       candidate = class_getSuperclass(candidate)) {
    auto found = RionRuntimeOriginalTitlebarWidgetInsetIMPs.find(candidate);
    if (found != RionRuntimeOriginalTitlebarWidgetInsetIMPs.end()) {
      return found->second;
    }
  }
  return nullptr;
}

static CGFloat RionRuntimeTitlebarWidgetInset(id frameView, SEL selector) {
  NSNumber *overrideInset = objc_getAssociatedObject(
      frameView, &RionRuntimeTitlebarWidgetInsetAssociationKey);
  if (overrideInset) return overrideInset.doubleValue;

  IMP original = RionOriginalTitlebarWidgetInsetIMPForObject(frameView);
  if (!original) return 0;
  using TitlebarWidgetInsetFunction = CGFloat (*)(id, SEL);
  return reinterpret_cast<TitlebarWidgetInsetFunction>(original)(frameView,
                                                                  selector);
}

static Method RionDirectInstanceMethod(Class targetClass, SEL selector) {
  unsigned int count = 0;
  Method *methods = class_copyMethodList(targetClass, &count);
  Method result = nullptr;
  for (unsigned int index = 0; index < count; ++index) {
    if (method_getName(methods[index]) == selector) {
      result = methods[index];
      break;
    }
  }
  std::free(methods);
  return result;
}

static BOOL RionInstallTitlebarHeightHook(NSView *frameView) {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"_titlebarHeight");
  if (![frameView respondsToSelector:selector]) {
    RionLogTitlebarHeightOverrideUnavailable();
    return NO;
  }

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    RionLogTitlebarHeightOverrideUnavailable();
    return NO;
  }

  Class targetClass = object_getClass(frameView);
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarHeightHookMutex);
  if (RionRuntimeOriginalTitlebarHeightIMPs.find(targetClass) !=
      RionRuntimeOriginalTitlebarHeightIMPs.end()) {
    return YES;
  }

  Method inheritedMethod = class_getInstanceMethod(targetClass, selector);
  if (!inheritedMethod) {
    RionLogTitlebarHeightOverrideUnavailable();
    return NO;
  }
  IMP original = method_getImplementation(inheritedMethod);
  // A superclass may already carry the wrapper. In that case this exact
  // class inherits the marker-aware behavior and must not save the wrapper as
  // its "original" implementation, which would recurse for unmarked views.
  if (original == (IMP)RionRuntimeTitlebarHeight) return YES;
  const char *types = method_getTypeEncoding(inheritedMethod);
  RionRuntimeOriginalTitlebarHeightIMPs.emplace(targetClass, original);

  Method directMethod = RionDirectInstanceMethod(targetClass, selector);
  if (directMethod) {
    method_setImplementation(directMethod, (IMP)RionRuntimeTitlebarHeight);
    return YES;
  }
  if (class_addMethod(targetClass, selector,
                      (IMP)RionRuntimeTitlebarHeight, types)) {
    return YES;
  }

  RionRuntimeOriginalTitlebarHeightIMPs.erase(targetClass);
  RionLogTitlebarHeightOverrideUnavailable();
  return NO;
}

static BOOL RionInstallTitlebarWidgetInsetHook(NSView *frameView) {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"_minXTitlebarWidgetInset");
  if (![frameView respondsToSelector:selector]) {
    RionLogTitlebarWidgetInsetOverrideUnavailable();
    return NO;
  }

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    RionLogTitlebarWidgetInsetOverrideUnavailable();
    return NO;
  }

  Class targetClass = object_getClass(frameView);
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarWidgetInsetHookMutex);
  if (RionRuntimeOriginalTitlebarWidgetInsetIMPs.find(targetClass) !=
      RionRuntimeOriginalTitlebarWidgetInsetIMPs.end()) {
    return YES;
  }

  Method inheritedMethod = class_getInstanceMethod(targetClass, selector);
  if (!inheritedMethod) {
    RionLogTitlebarWidgetInsetOverrideUnavailable();
    return NO;
  }
  IMP original = method_getImplementation(inheritedMethod);
  if (original == (IMP)RionRuntimeTitlebarWidgetInset) return YES;
  const char *types = method_getTypeEncoding(inheritedMethod);
  RionRuntimeOriginalTitlebarWidgetInsetIMPs.emplace(targetClass, original);

  Method directMethod = RionDirectInstanceMethod(targetClass, selector);
  if (directMethod) {
    method_setImplementation(directMethod,
                             (IMP)RionRuntimeTitlebarWidgetInset);
    return YES;
  }
  if (class_addMethod(targetClass, selector,
                      (IMP)RionRuntimeTitlebarWidgetInset, types)) {
    return YES;
  }

  RionRuntimeOriginalTitlebarWidgetInsetIMPs.erase(targetClass);
  RionLogTitlebarWidgetInsetOverrideUnavailable();
  return NO;
}

@class RionRuntimeTabsController;
@class RionRuntimeSurfaceView;

@interface RionRuntimeDraggableView : NSView
@end

@interface RionRuntimeBackdropView : NSVisualEffectView
@end

@interface RionRuntimeVerticallyCenteredTextFieldCell : NSTextFieldCell
@end

@interface RionRuntimeSurfaceView : NSView

@property(nonatomic, strong, readonly) NSView *contentView;

- (instancetype)initWithContentView:(NSView *)contentView
                       cornerRadius:(CGFloat)cornerRadius;
- (void)updateActive:(BOOL)active
             hovered:(BOOL)hovered
        windowActive:(BOOL)windowActive
             animate:(BOOL)animate;

@end

@interface RionRuntimeTabItemView : NSControl <NSDraggingSource>

@property(nonatomic) BOOL activeTab;
@property(nonatomic) NSInteger sourceDisplayID;
@property(nonatomic, weak) RionRuntimeSurfaceView *surfaceView;
@property(nonatomic, weak) RionRuntimeTabsController *tabsController;
@property(nonatomic, copy) NSString *tabIdentifier;
@property(nonatomic, readonly) CGFloat preferredWidth;

- (void)configureWithTab:(RionRuntimeTabModel *)tab
                    image:(NSImage *)image
                moreLabel:(NSString *)moreLabel
             windowActive:(BOOL)windowActive;
- (void)updateWindowActive:(BOOL)windowActive;

@end

@interface RionRuntimeAddButton : NSButton

@property(nonatomic, weak) RionRuntimeSurfaceView *surfaceView;

@end

@interface RionRuntimeTabsRootView : RionRuntimeDraggableView
    <NSDraggingDestination>

@property(nonatomic, weak) RionRuntimeTabsController *tabsController;

@end

@interface RionRuntimeTabsController () <NSToolbarDelegate>

@property(nonatomic, readwrite) BOOL alwaysShowInFullScreen;
@property(nonatomic, readwrite) BOOL revealLocked;

- (void)activateTab:(NSString *)tabIdentifier;
- (void)applyLiquidGlassTitlebarAppearance;
- (void)attachAccessoryController;
- (void)beginTabDrag:(RionRuntimeTabItemView *)item event:(NSEvent *)event;
- (void)captureWindowedTrafficLightFrames;
- (void)detachAccessoryController;
- (void)detachTitlebarHeightOverrideFromFrameView:(nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrideFromFrameView:
    (nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrides;
- (void)ensureTitlebarHeightOverride;
- (void)ensureFullScreenTitlebarWidgetInsetOverrides;
- (void)enforceTrafficLightVisibility;
- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                    sourceDisplayID:(NSInteger)sourceDisplayID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier;
- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view;
- (void)hideInsertionIndicator;
- (void)hideResidualFullScreenTrafficLightOverlay;
- (void)installPreparedToolbarForFullScreen;
- (void)installFreshToolbarForWindowedMode;
- (NSToolbar *)makeFullScreenToolbar;
- (NSToolbar *)makeToolbarHost;
- (NSToolbar *)makeWindowedToolbar;
- (BOOL)orderToolbarBelowAccessory;
- (void)removeTrafficLightObservationRestoringState:(BOOL)restoreState;
- (void)revealToolbarAndOrderBelowAccessory;
- (BOOL)readCustomTitlebarHeight:(CGFloat *)height
                   fromFrameView:(nullable NSView *)frameView;
- (BOOL)readTitlebarWidgetInset:(CGFloat *)inset
                  fromFrameView:(nullable NSView *)frameView;
- (void)restoreWindowedTrafficLightFrames;
- (void)restoreWindowedTitlebarHost;
- (void)scheduleContentLayoutNotification;
- (void)scheduleLiquidGlassTitlebarRehost;
- (BOOL)setCustomTitlebarHeight:(CGFloat)height
                    onFrameView:(nullable NSView *)frameView;
- (BOOL)attachTitlebarHeightOverrideToFrameView:(nullable NSView *)frameView;
- (BOOL)attachTitlebarWidgetInsetOverride:(CGFloat)inset
                              toFrameView:(nullable NSView *)frameView;
- (void)settleWindowedTitlebarAfterFullScreenExit;
- (void)synchronizeFullScreenTitlebarGeometry;
- (BOOL)synchronizeTitlebarGeometryForFrameView:(nullable NSView *)frameView;
- (void)updateTrafficLightObservation;
- (BOOL)updateTitlebarButtonPositionsForFrameView:(nullable NSView *)frameView;
- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier;
- (nullable NSView *)toolbarHostView;

@end

@implementation RionRuntimeTabModel
@end

@implementation RionRuntimeTabsState
@end

@implementation RionRuntimeDraggableView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

static void *RionRuntimeTrafficLightObservationContext =
    &RionRuntimeTrafficLightObservationContext;
static void *RionRuntimeContentLayoutObservationContext =
    &RionRuntimeContentLayoutObservationContext;

@implementation RionRuntimeBackdropView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeVerticallyCenteredTextFieldCell

- (NSRect)titleRectForBounds:(NSRect)bounds {
  NSRect titleRect = [super titleRectForBounds:bounds];
  NSFont *font = self.font;
  if (!font || NSHeight(bounds) <= 0) return titleRect;

  CGFloat metricHeight =
      ceil(font.ascender - font.descender + font.leading);
  CGFloat titleHeight = MIN(NSHeight(bounds), MAX(0, metricHeight));
  titleRect.origin.y =
      NSMinY(bounds) + (NSHeight(bounds) - titleHeight) / 2.0;
  titleRect.size.height = titleHeight;
  return titleRect;
}

- (void)drawInteriorWithFrame:(NSRect)cellFrame
                       inView:(NSView *)controlView {
  [super drawInteriorWithFrame:[self titleRectForBounds:cellFrame]
                        inView:controlView];
}

@end

@implementation RionRuntimeSurfaceView {
  BOOL _active;
  CGFloat _cornerRadius;
  NSView *_effectView;
  BOOL _hovered;
  BOOL _usesLiquidGlass;
  BOOL _windowActive;
}

- (instancetype)initWithContentView:(NSView *)contentView
                       cornerRadius:(CGFloat)cornerRadius {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;

  _contentView = contentView;
  _cornerRadius = cornerRadius;
  self.wantsLayer = YES;

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    NSGlassEffectView *glass = [[NSGlassEffectView alloc] initWithFrame:NSZeroRect];
    glass.cornerRadius = cornerRadius;
    glass.style = NSGlassEffectViewStyleRegular;
    glass.contentView = contentView;
    _effectView = glass;
    _usesLiquidGlass = YES;
  } else
#endif
  {
    NSVisualEffectView *material =
        [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
    material.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    material.material = NSVisualEffectMaterialTitlebar;
    material.state = NSVisualEffectStateFollowsWindowActiveState;
    material.wantsLayer = YES;
    material.layer.cornerRadius = cornerRadius;
    material.layer.masksToBounds = YES;
    [material addSubview:contentView];
    _effectView = material;
  }

  [self addSubview:_effectView];
  [self updateActive:NO hovered:NO windowActive:YES animate:NO];
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (void)layout {
  [super layout];
  _effectView.frame = self.bounds;
  [_effectView layoutSubtreeIfNeeded];
  _contentView.frame = _effectView.bounds;
}

- (void)viewDidChangeEffectiveAppearance {
  [super viewDidChangeEffectiveAppearance];
  [self applyAppearanceAnimated:NO];
}

- (void)updateActive:(BOOL)active
             hovered:(BOOL)hovered
        windowActive:(BOOL)windowActive
             animate:(BOOL)animate {
  _active = active;
  _hovered = hovered;
  _windowActive = windowActive;
  [self applyAppearanceAnimated:animate];
}

- (void)applyAppearanceAnimated:(BOOL)animate {
  BOOL reduceTransparency =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency;
  BOOL reduceMotion =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
  CGFloat accentAlpha = _active ? (_windowActive ? 0.08 : 0.045)
                                : _hovered ? (_windowActive ? 0.035 : 0.025) : 0.0;
  NSColor *tint = accentAlpha > 0
                      ? [NSColor.controlAccentColor colorWithAlphaComponent:accentAlpha]
                      : nil;

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    if (_usesLiquidGlass) {
      NSGlassEffectView *glass = (NSGlassEffectView *)_effectView;
      glass.tintColor = tint;
      glass.alphaValue = _windowActive ? 1.0 : 0.82;
    }
  }
#endif
  if (!_usesLiquidGlass) {
    NSVisualEffectView *material = (NSVisualEffectView *)_effectView;
    material.material = reduceTransparency
                            ? NSVisualEffectMaterialWindowBackground
                            : _active ? NSVisualEffectMaterialSelection
                                      : NSVisualEffectMaterialTitlebar;
    material.emphasized = _active && _windowActive;
    material.alphaValue = _windowActive ? 0.96 : 0.78;
  }

  NSColor *borderColor = _active
                             ? [NSColor.separatorColor colorWithAlphaComponent:
                                                        _windowActive ? 0.25 : 0.17]
                             : [NSColor.separatorColor colorWithAlphaComponent:
                                                        _hovered ? 0.20 : 0.10];
  void (^updates)(void) = ^{
    self.layer.cornerRadius = self->_cornerRadius;
    self.layer.borderWidth = self->_active ? 0.65 : 0.45;
    self.layer.borderColor = borderColor.CGColor;
    self.layer.opacity = 1.0;
  };
  if (animate && !reduceMotion) {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.14;
      updates();
    } completionHandler:nil];
  } else {
    updates();
  }
}

@end

@implementation RionRuntimeTabItemView {
  NSView *_badgeView;
  NSTextField *_badgeField;
  CGFloat _badgeWidth;
  BOOL _hovered;
  NSImageView *_iconView;
  NSButton *_moreButton;
  NSTrackingArea *_trackingArea;
  NSTextField *_titleField;
  BOOL _windowActive;
}

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (!self) return nil;

  self.focusRingType = NSFocusRingTypeNone;
  self.accessibilityRole = NSAccessibilityRadioButtonRole;

  _iconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _iconView.imageAlignment = NSImageAlignCenter;
  _iconView.imageScaling = NSImageScaleProportionallyDown;
  _iconView.wantsLayer = YES;
  _iconView.layer.cornerRadius = 4.0;
  _iconView.layer.masksToBounds = YES;

  RionRuntimeVerticallyCenteredTextFieldCell *titleCell =
      [[RionRuntimeVerticallyCenteredTextFieldCell alloc] initTextCell:@""];
  titleCell.alignment = NSTextAlignmentLeft;
  titleCell.bezeled = NO;
  titleCell.bordered = NO;
  titleCell.drawsBackground = NO;
  titleCell.editable = NO;
  titleCell.selectable = NO;
  titleCell.usesSingleLineMode = YES;
  titleCell.lineBreakMode = NSLineBreakByTruncatingTail;
  _titleField = [[NSTextField alloc] initWithFrame:NSZeroRect];
  _titleField.cell = titleCell;
  _titleField.focusRingType = NSFocusRingTypeNone;

  _badgeView = [[NSView alloc] initWithFrame:NSZeroRect];
  _badgeView.wantsLayer = YES;
  _badgeView.layer.cornerRadius = 8.0;
  _badgeView.layer.masksToBounds = YES;
  RionRuntimeVerticallyCenteredTextFieldCell *badgeCell =
      [[RionRuntimeVerticallyCenteredTextFieldCell alloc] initTextCell:@""];
  badgeCell.alignment = NSTextAlignmentCenter;
  badgeCell.font = [NSFont monospacedDigitSystemFontOfSize:10.0
                                                   weight:NSFontWeightMedium];
  badgeCell.bezeled = NO;
  badgeCell.bordered = NO;
  badgeCell.drawsBackground = NO;
  badgeCell.editable = NO;
  badgeCell.selectable = NO;
  badgeCell.usesSingleLineMode = YES;
  badgeCell.lineBreakMode = NSLineBreakByClipping;
  _badgeField = [[NSTextField alloc] initWithFrame:NSZeroRect];
  _badgeField.cell = badgeCell;
  _badgeField.focusRingType = NSFocusRingTypeNone;
  [_badgeView addSubview:_badgeField];

  NSImage *ellipsis = [NSImage imageWithSystemSymbolName:@"ellipsis"
                                accessibilityDescription:nil];
  ellipsis = [ellipsis imageWithSymbolConfiguration:
                         [NSImageSymbolConfiguration configurationWithPointSize:11.0
                                                                        weight:NSFontWeightSemibold]];
  _moreButton = [NSButton buttonWithImage:ellipsis
                                   target:self
                                   action:@selector(morePressed:)];
  _moreButton.bordered = NO;
  _moreButton.imageScaling = NSImageScaleProportionallyDown;
  _moreButton.contentTintColor = NSColor.secondaryLabelColor;

  [self addSubview:_iconView];
  [self addSubview:_titleField];
  [self addSubview:_badgeView];
  [self addSubview:_moreButton];
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (CGFloat)preferredWidth {
  CGFloat labelWidth = [_titleField.stringValue sizeWithAttributes:@{
    NSFontAttributeName : [NSFont systemFontOfSize:12.0 weight:NSFontWeightSemibold]
  }].width;
  CGFloat fixedWidth = kRionTabLeadingPadding + kRionTabIconSize +
      kRionTabIconTitleSpacing + kRionTabAccessorySpacing +
      kRionTabMoreButtonWidth + kRionTabTrailingPadding;
  if (!_badgeView.hidden) {
    fixedWidth += kRionTabAccessorySpacing + _badgeWidth;
  }
  return MIN(kRionTabMaximumWidth,
             MAX(kRionTabMinimumWidth, ceil(labelWidth) + fixedWidth));
}

- (NSSize)intrinsicContentSize {
  return NSMakeSize(self.preferredWidth, kRionTabHeight);
}

- (void)configureWithTab:(RionRuntimeTabModel *)tab
                    image:(NSImage *)image
                moreLabel:(NSString *)moreLabel
             windowActive:(BOOL)windowActive {
  _windowActive = windowActive;
  self.tabIdentifier = tab.identifier;
  self.activeTab = tab.active;
  _iconView.image = image;
  _titleField.stringValue = tab.name;
  _moreButton.identifier = tab.identifier;
  _moreButton.toolTip = moreLabel;
  _moreButton.accessibilityLabel = moreLabel;
  self.toolTip = tab.name;
  self.accessibilityLabel = tab.name;
  self.accessibilityValue = @(tab.active);

  if (tab.roleCount > 0) {
    NSString *count = [NSString stringWithFormat:@"%ld", (long)tab.roleCount];
    _badgeField.stringValue = count;
    CGFloat measured = [count sizeWithAttributes:@{
      NSFontAttributeName : _badgeField.font
    }].width;
    _badgeWidth =
        MAX(kRionBadgeMinimumWidth, ceil(measured) + kRionBadgeHorizontalPadding);
    _badgeView.hidden = NO;
  } else {
    _badgeField.stringValue = @"";
    _badgeWidth = 0;
    _badgeView.hidden = YES;
  }
  [self invalidateIntrinsicContentSize];
  [self updateVisualStateAnimated:YES];
  self.needsLayout = YES;
}

- (void)layout {
  [super layout];
  CGFloat width = self.bounds.size.width;
  CGFloat x = kRionTabLeadingPadding;
  _iconView.frame =
      NSMakeRect(x, (kRionTabHeight - kRionTabIconSize) / 2.0,
                 kRionTabIconSize, kRionTabIconSize);
  x += kRionTabIconSize + kRionTabIconTitleSpacing;

  CGFloat moreX = MAX(
      x, width - kRionTabTrailingPadding - kRionTabMoreButtonWidth);
  _moreButton.frame =
      NSMakeRect(moreX, 0, kRionTabMoreButtonWidth, kRionTabHeight);
  CGFloat titleEnd = moreX - kRionTabAccessorySpacing;
  if (!_badgeView.hidden) {
    CGFloat badgeX = MAX(x, titleEnd - _badgeWidth);
    _badgeView.frame =
        NSMakeRect(badgeX, (kRionTabHeight - kRionBadgeHeight) / 2.0,
                   _badgeWidth, kRionBadgeHeight);
    _badgeField.frame = _badgeView.bounds;
    titleEnd = badgeX - kRionTabAccessorySpacing;
  }
  _titleField.frame =
      NSMakeRect(x, 0, MAX(1.0, titleEnd - x), kRionTabHeight);
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  _hovered = YES;
  [self updateVisualStateAnimated:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  _hovered = NO;
  [self updateVisualStateAnimated:YES];
}

- (void)updateWindowActive:(BOOL)windowActive {
  _windowActive = windowActive;
  [self updateVisualStateAnimated:YES];
}

- (void)updateVisualStateAnimated:(BOOL)animate {
  [_surfaceView updateActive:self.activeTab
                     hovered:_hovered
                windowActive:_windowActive
                     animate:animate];
  _titleField.font = [NSFont systemFontOfSize:12.0
                                       weight:self.activeTab ? NSFontWeightSemibold
                                                             : NSFontWeightRegular];
  _titleField.textColor = self.activeTab
                              ? (_windowActive ? NSColor.labelColor
                                               : NSColor.secondaryLabelColor)
                              : NSColor.secondaryLabelColor;
  _badgeField.textColor = NSColor.secondaryLabelColor;
  _badgeView.layer.backgroundColor =
      [NSColor.quaternaryLabelColor colorWithAlphaComponent:0.15].CGColor;
  CGFloat moreAlpha = self.activeTab ? 0.46 : _hovered ? 0.76 : 0.0;
  BOOL reduceMotion =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
  if (animate && !reduceMotion) {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.12;
      self->_moreButton.animator.alphaValue = moreAlpha;
    } completionHandler:nil];
  } else {
    _moreButton.alphaValue = moreAlpha;
  }
}

- (NSView *)hitTest:(NSPoint)point {
  NSView *hit = [super hitTest:point];
  if (hit == _moreButton && _moreButton.alphaValue > 0.05) return hit;
  return hit ? self : nil;
}

- (void)mouseDown:(NSEvent *)event {
  NSPoint start = event.locationInWindow;
  while (true) {
    NSEvent *next = [self.window
        nextEventMatchingMask:NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged];
    if (!next || next.type == NSEventTypeLeftMouseUp) {
      [NSApp sendAction:self.action to:self.target from:self];
      return;
    }
    NSPoint current = next.locationInWindow;
    if (std::hypot(current.x - start.x, current.y - start.y) >= 3.0) {
      [self.tabsController beginTabDrag:self event:next];
      return;
    }
  }
}

- (void)rightMouseDown:(NSEvent *)event {
  (void)event;
  [self.tabsController performSelector:@selector(showTabMenu:)
                             withObject:self.tabIdentifier];
}

- (void)morePressed:(id)sender {
  (void)sender;
  [self.tabsController performSelector:@selector(showTabMenu:)
                             withObject:self.tabIdentifier];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  (void)session;
  (void)context;
  return NSDragOperationMove;
}

- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session {
  (void)session;
  return YES;
}

@end

@implementation RionRuntimeAddButton {
  NSTrackingArea *_trackingArea;
}

- (BOOL)isFlipped {
  return YES;
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  [_surfaceView updateActive:NO hovered:YES windowActive:self.window.isKeyWindow animate:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  [_surfaceView updateActive:NO hovered:NO windowActive:self.window.isKeyWindow animate:YES];
}

@end

@implementation RionRuntimeTabsRootView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    [self registerForDraggedTypes:@[ RionRuntimeTabPasteboardType ]];
  }
  return self;
}

- (NSSize)intrinsicContentSize {
  return NSMakeSize(NSViewNoIntrinsicMetric, kRionTitlebarHeight);
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
  return [self draggingUpdated:sender];
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
  if (![[sender draggingPasteboard]
          availableTypeFromArray:@[ RionRuntimeTabPasteboardType ]]) {
    return NSDragOperationNone;
  }
  NSPoint point = [self convertPoint:sender.draggingLocation fromView:nil];
  NSString *identifier =
      [self.tabsController tabIdentifierBeforePoint:point inView:self];
  [self.tabsController updateInsertionIndicatorBeforeIdentifier:identifier];
  return NSDragOperationMove;
}

- (void)draggingExited:(nullable id<NSDraggingInfo>)sender {
  (void)sender;
  [self.tabsController hideInsertionIndicator];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = [payload componentsSeparatedByString:@"\n"];
  if (parts.count != 2) return NO;
  NSInteger sourceDisplayID = parts[0].integerValue;
  NSString *tabIdentifier = parts[1];
  NSPoint point = [self convertPoint:sender.draggingLocation fromView:nil];
  NSString *beforeIdentifier =
      [self.tabsController tabIdentifierBeforePoint:point inView:self];
  [self.tabsController hideInsertionIndicator];
  [self.tabsController handleDropWithTabIdentifier:tabIdentifier
                                   sourceDisplayID:sourceDisplayID
                                  beforeIdentifier:beforeIdentifier];
  return YES;
}

@end

@implementation RionRuntimeTabsController {
  RionRuntimeTabsActionHandler _actionHandler;
  RionRuntimeContentLayoutHandler _contentLayoutHandler;
  NSTitlebarAccessoryViewController *_accessoryController;
  RionRuntimeSurfaceView *_addSurface;
  RionRuntimeAddButton *_addButton;
  NSView *_clusterContainer;
  RionRuntimeDraggableView *_clusterContent;
  NSInteger _displayID;
  NSView *_insertionIndicator;
  NSMutableArray<NSButton *> *_observedTrafficLightButtons;
  NSMutableDictionary<NSValue *, NSDictionary<NSString *, NSNumber *> *> *
      _originalTrafficLightStates;
  NSMutableDictionary<NSNumber *, NSValue *> *_windowedTrafficLightFrames;
  NSToolbar *_fullscreenToolbar;
  NSToolbar *_toolbar;
  dispatch_block_t _pendingContentLayoutNotification;
  RionRuntimeDraggableView *_tabCanvas;
  NSMutableArray<RionRuntimeTabItemView *> *_tabItems;
  NSScrollView *_tabScrollView;
  NSMutableArray<RionRuntimeSurfaceView *> *_tabSurfaces;
  RionRuntimeBackdropView *_titlebarBackdrop;
  __weak NSView *_titlebarFrameView;
  NSHashTable<NSView *> *_titlebarWidgetInsetFrameViews;
  __weak NSWindow *_fullscreenTitlebarHostWindow;
  NSWindowTitleVisibility _previousTitleVisibility;
  BOOL _previousTitlebarAppearsTransparent;
  NSTitlebarSeparatorStyle _previousTitlebarSeparatorStyle;
  NSWindowToolbarStyle _previousToolbarStyle;
  NSToolbar *_previousToolbar;
  BOOL _previousFullSizeContentView;
  CGFloat _previousCustomTitlebarHeight;
  BOOL _hasPreviousCustomTitlebarHeight;
  CGFloat _stableTitlebarWidgetInset;
  BOOL _hasStableTitlebarWidgetInset;
  __weak NSWindow *_window;
  NSMutableArray<id> *_windowObservers;
  BOOL _destroyed;
  BOOL _contentLayoutObserved;
  BOOL _enforcingTrafficLightVisibility;
  BOOL _hasLastNotifiedContentLayout;
  BOOL _fullscreenTransitionActive;
  RionRuntimeContentLayout _lastNotifiedContentLayout;
  CGFloat _stableTrafficLightReserveWidth;
}

- (nullable instancetype)initWithWindow:(NSWindow *)window
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler
                    contentLayoutHandler:
                        (RionRuntimeContentLayoutHandler)contentLayoutHandler {
  if (!window || !actionHandler || !contentLayoutHandler) return nil;
  self = [super init];
  if (!self) return nil;

  _window = window;
  _hasPreviousCustomTitlebarHeight =
      [self readCustomTitlebarHeight:&_previousCustomTitlebarHeight
                       fromFrameView:window.contentView.superview];
  _hasStableTitlebarWidgetInset =
      [self readTitlebarWidgetInset:&_stableTitlebarWidgetInset
                      fromFrameView:window.contentView.superview];
  if (@available(macOS 26.0, *)) {
    if (!_hasStableTitlebarWidgetInset) {
      RionLogTitlebarWidgetInsetOverrideUnavailable();
    }
  }
  [self ensureTitlebarHeightOverride];
  _actionHandler = [actionHandler copy];
  _contentLayoutHandler = [contentLayoutHandler copy];
  _observedTrafficLightButtons = [NSMutableArray array];
  _originalTrafficLightStates = [NSMutableDictionary dictionary];
  _windowedTrafficLightFrames = [NSMutableDictionary dictionary];
  _tabItems = [NSMutableArray array];
  _tabSurfaces = [NSMutableArray array];
  _titlebarWidgetInsetFrameViews = [NSHashTable weakObjectsHashTable];
  _windowObservers = [NSMutableArray array];
  _previousTitleVisibility = window.titleVisibility;
  _previousTitlebarAppearsTransparent = window.titlebarAppearsTransparent;
  if (@available(macOS 11.0, *)) {
    _previousTitlebarSeparatorStyle = window.titlebarSeparatorStyle;
  }
  _previousToolbarStyle = window.toolbarStyle;
  _previousToolbar = window.toolbar;
  _previousFullSizeContentView =
      (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0;
  _fullscreenTransitionActive =
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  _stableTrafficLightReserveWidth = kRionTrafficLightFallbackWidth;

  window.titleVisibility = NSWindowTitleHidden;
  window.titlebarAppearsTransparent = YES;
  if (@available(macOS 11.0, *)) {
    window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
  }

  _toolbar = [self makeWindowedToolbar];
  _fullscreenToolbar = [self makeFullScreenToolbar];
  _toolbar.visible = YES;
  window.toolbar = _toolbar;
  [self ensureTitlebarHeightOverride];

  RionRuntimeTabsRootView *root = [[RionRuntimeTabsRootView alloc]
      initWithFrame:NSMakeRect(0, 0, MAX(1.0, window.frame.size.width),
                               kRionTitlebarHeight)];
  root.tabsController = self;
  _titlebarBackdrop = [[RionRuntimeBackdropView alloc] initWithFrame:root.bounds];
  _titlebarBackdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  _titlebarBackdrop.material = NSVisualEffectMaterialHeaderView;
  _titlebarBackdrop.state = NSVisualEffectStateFollowsWindowActiveState;
  [root addSubview:_titlebarBackdrop];
  _clusterContent = [[RionRuntimeDraggableView alloc] initWithFrame:root.bounds];

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    NSGlassEffectContainerView *glassContainer =
        [[NSGlassEffectContainerView alloc] initWithFrame:root.bounds];
    glassContainer.spacing = kRionTabSpacing;
    glassContainer.contentView = _clusterContent;
    _clusterContainer = glassContainer;
  } else
#endif
  {
    _clusterContainer = _clusterContent;
  }
  [root addSubview:_clusterContainer];

  _tabScrollView = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  _tabScrollView.autohidesScrollers = YES;
  _tabScrollView.borderType = NSNoBorder;
  _tabScrollView.drawsBackground = NO;
  _tabScrollView.hasHorizontalScroller = NO;
  _tabScrollView.hasVerticalScroller = NO;
  _tabScrollView.horizontalScrollElasticity = NSScrollElasticityAllowed;
  _tabScrollView.verticalScrollElasticity = NSScrollElasticityNone;
  _tabCanvas = [[RionRuntimeDraggableView alloc] initWithFrame:NSZeroRect];
  _tabCanvas.accessibilityRole = NSAccessibilityTabGroupRole;
  _tabScrollView.documentView = _tabCanvas;

  NSImage *plus = [NSImage imageWithSystemSymbolName:@"plus"
                           accessibilityDescription:nil];
  plus = [plus imageWithSymbolConfiguration:
                   [NSImageSymbolConfiguration configurationWithPointSize:11.0
                                                                  weight:NSFontWeightSemibold]];
  _addButton = [RionRuntimeAddButton buttonWithImage:plus
                                              target:self
                                              action:@selector(openLauncher:)];
  _addButton.bordered = NO;
  _addButton.tag = kRionAddButtonTag;
  _addButton.imageScaling = NSImageScaleProportionallyDown;
  _addButton.contentTintColor = NSColor.secondaryLabelColor;
  _addSurface = [[RionRuntimeSurfaceView alloc] initWithContentView:_addButton
                                                       cornerRadius:14.0];
  _addButton.surfaceView = _addSurface;

  [_clusterContent addSubview:_tabScrollView];
  [_clusterContent addSubview:_addSurface];

  _insertionIndicator = [[NSView alloc] initWithFrame:NSZeroRect];
  _insertionIndicator.wantsLayer = YES;
  _insertionIndicator.layer.backgroundColor = NSColor.controlAccentColor.CGColor;
  _insertionIndicator.layer.cornerRadius = 1.0;
  _insertionIndicator.hidden = YES;
  [root addSubview:_insertionIndicator];

  _accessoryController = [[NSTitlebarAccessoryViewController alloc] init];
  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
  _accessoryController.view = root;
  [self applyLiquidGlassTitlebarAppearance];
  [self attachAccessoryController];
  [self layoutTitlebarContent];
  [self captureWindowedTrafficLightFrames];
  [self installWindowObservers];
  return self;
}

- (BOOL)attachTitlebarHeightOverrideToFrameView:(nullable NSView *)frameView {
  if (!frameView || !RionInstallTitlebarHeightHook(frameView)) return NO;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarHeightAssociationKey,
                           @(kRionTitlebarHeight),
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  frameView.needsLayout = YES;
  return YES;
}

- (void)detachTitlebarHeightOverrideFromFrameView:(nullable NSView *)frameView {
  if (!frameView) return;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarHeightAssociationKey,
                           nil,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  frameView.needsLayout = YES;
}

- (void)ensureTitlebarHeightOverride {
  if (_destroyed || !_window) return;
  NSView *currentFrameView = _window.contentView.superview;
  if (currentFrameView == _titlebarFrameView) {
    [self attachTitlebarHeightOverrideToFrameView:currentFrameView];
    return;
  }

  [self detachTitlebarHeightOverrideFromFrameView:_titlebarFrameView];
  _titlebarFrameView = nil;
  if ([self attachTitlebarHeightOverrideToFrameView:currentFrameView]) {
    _titlebarFrameView = currentFrameView;
  }
}

- (BOOL)readTitlebarWidgetInset:(CGFloat *)inset
                  fromFrameView:(nullable NSView *)frameView {
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

- (BOOL)attachTitlebarWidgetInsetOverride:(CGFloat)inset
                              toFrameView:(nullable NSView *)frameView {
  if (!frameView || !RionInstallTitlebarWidgetInsetHook(frameView)) return NO;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarWidgetInsetAssociationKey,
                           @(inset),
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [_titlebarWidgetInsetFrameViews addObject:frameView];
  frameView.needsLayout = YES;
  return YES;
}

- (void)detachTitlebarWidgetInsetOverrideFromFrameView:
    (nullable NSView *)frameView {
  if (!frameView) return;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarWidgetInsetAssociationKey,
                           nil,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [_titlebarWidgetInsetFrameViews removeObject:frameView];
  frameView.needsLayout = YES;
}

- (void)detachTitlebarWidgetInsetOverrides {
  for (NSView *frameView in _titlebarWidgetInsetFrameViews.allObjects) {
    objc_setAssociatedObject(frameView,
                             &RionRuntimeTitlebarWidgetInsetAssociationKey,
                             nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    frameView.needsLayout = YES;
  }
  [_titlebarWidgetInsetFrameViews removeAllObjects];
}

- (void)ensureFullScreenTitlebarWidgetInsetOverrides {
  if (_destroyed || !_window || !_hasStableTitlebarWidgetInset ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
    [self detachTitlebarWidgetInsetOverrides];
    return;
  }
  if (@available(macOS 26.0, *)) {
    NSMutableOrderedSet<NSView *> *frameViews = [NSMutableOrderedSet orderedSet];
    void (^addFrameForWindow)(NSWindow *_Nullable) =
        ^(NSWindow *_Nullable candidateWindow) {
      NSView *frameView = candidateWindow.contentView.superview;
      if (frameView) [frameViews addObject:frameView];
    };

    addFrameForWindow(_window);
    addFrameForWindow(_accessoryController.view.window);
    NSButton *closeButton = [_window standardWindowButton:NSWindowCloseButton];
    addFrameForWindow(closeButton.window);

    for (NSView *trackedFrameView in
             _titlebarWidgetInsetFrameViews.allObjects) {
      if (![frameViews containsObject:trackedFrameView]) {
        [self detachTitlebarWidgetInsetOverrideFromFrameView:trackedFrameView];
      }
    }
    for (NSView *frameView in frameViews) {
      [self attachTitlebarWidgetInsetOverride:_stableTitlebarWidgetInset
                                  toFrameView:frameView];
    }
  } else {
    [self detachTitlebarWidgetInsetOverrides];
  }
}

- (BOOL)readCustomTitlebarHeight:(CGFloat *)height
                   fromFrameView:(nullable NSView *)frameView {
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

- (BOOL)setCustomTitlebarHeight:(CGFloat)height
                    onFrameView:(nullable NSView *)frameView {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"setCustomTitlebarHeight:");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  const char *argumentType = signature && signature.numberOfArguments == 3
      ? [signature getArgumentTypeAtIndex:2]
      : nullptr;
  if (!signature || signature.numberOfArguments != 3 ||
      signature.methodReturnLength != 0 ||
      std::strcmp(signature.methodReturnType, @encode(void)) != 0 ||
      !argumentType ||
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

- (BOOL)updateTitlebarButtonPositionsForFrameView:
    (nullable NSView *)frameView {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"_updateButtonPositions");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != 0 ||
      std::strcmp(signature.methodReturnType, @encode(void)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation invoke];
  return YES;
}

- (BOOL)synchronizeTitlebarGeometryForFrameView:
    (nullable NSView *)frameView {
  if (!frameView) return NO;
  // AppKit resets customTitlebarHeight while entering fullscreen, then caches
  // the standard window-button origins against its 32pt fallback. Keep that
  // internal metric aligned with the marker-backed 40pt getter before native
  // top-edge reveal runs. This is a settled transition layout pass, never a
  // hover or reveal callback.
  BOOL updatedHeight =
      [self setCustomTitlebarHeight:kRionTitlebarHeight onFrameView:frameView];
  BOOL updatedButtons =
      [self updateTitlebarButtonPositionsForFrameView:frameView];
  frameView.needsLayout = YES;
  [frameView layoutSubtreeIfNeeded];
  if (!updatedHeight || !updatedButtons) {
    RionLogFullscreenTitlebarGeometrySyncUnavailable();
  }
  return updatedHeight && updatedButtons;
}

- (void)synchronizeFullScreenTitlebarGeometry {
  if (_destroyed || !_window ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
    return;
  }
  [self ensureTitlebarHeightOverride];
  [self ensureFullScreenTitlebarWidgetInsetOverrides];
  [self synchronizeTitlebarGeometryForFrameView:_titlebarFrameView];
  for (NSView *frameView in _titlebarWidgetInsetFrameViews.allObjects) {
    if (frameView == _titlebarFrameView) continue;
    [self updateTitlebarButtonPositionsForFrameView:frameView];
    frameView.needsLayout = YES;
    [frameView layoutSubtreeIfNeeded];
  }
}

- (NSUInteger)renderedTabCount {
  return _tabItems.count;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:
    (NSToolbar *)toolbar {
  (void)toolbar;
  return @[ RionRuntimeToolbarSpacerIdentifier ];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:
    (NSToolbar *)toolbar {
  (void)toolbar;
  return @[ RionRuntimeToolbarSpacerIdentifier ];
}

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
     itemForItemIdentifier:(NSToolbarItemIdentifier)itemIdentifier
 willBeInsertedIntoToolbar:(BOOL)flag {
  (void)toolbar;
  (void)flag;
  if (![itemIdentifier isEqualToString:RionRuntimeToolbarSpacerIdentifier]) return nil;
  NSToolbarItem *item =
      [[NSToolbarItem alloc] initWithItemIdentifier:itemIdentifier];
  RionRuntimeDraggableView *spacer = [[RionRuntimeDraggableView alloc]
      initWithFrame:NSMakeRect(0, 0, 1.0, kRionTabHeight)];
  spacer.translatesAutoresizingMaskIntoConstraints = NO;
  [NSLayoutConstraint activateConstraints:@[
    [spacer.widthAnchor constraintEqualToConstant:1.0],
    [spacer.heightAnchor constraintEqualToConstant:kRionTabHeight]
  ]];
  item.view = spacer;
  item.visibilityPriority = NSToolbarItemVisibilityPriorityHigh;
  return item;
}

- (void)installWindowObservers {
  [_window addObserver:self
            forKeyPath:@"contentLayoutRect"
               options:NSKeyValueObservingOptionNew
               context:RionRuntimeContentLayoutObservationContext];
  _contentLayoutObserved = YES;

  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  __weak RionRuntimeTabsController *weakSelf = self;
  NSArray<NSNotificationName> *names = @[
    NSWindowDidResizeNotification,
    NSWindowDidBecomeKeyNotification,
    NSWindowDidResignKeyNotification,
    NSWindowWillEnterFullScreenNotification,
    NSWindowDidEnterFullScreenNotification,
    NSWindowWillExitFullScreenNotification,
    NSWindowDidExitFullScreenNotification
  ];
  for (NSNotificationName name in names) {
    id observer = [center addObserverForName:name
                                     object:_window
                                      queue:NSOperationQueue.mainQueue
                                 usingBlock:^(NSNotification *notification) {
      RionRuntimeTabsController *strongSelf = weakSelf;
      if (!strongSelf) return;
      if ([notification.name isEqualToString:NSWindowDidResizeNotification]) {
        [strongSelf layoutTitlebarContent];
        [strongSelf scheduleContentLayoutNotification];
      } else if ([notification.name isEqualToString:NSWindowDidBecomeKeyNotification] ||
                 [notification.name isEqualToString:NSWindowDidResignKeyNotification]) {
        if ([notification.name isEqualToString:NSWindowDidBecomeKeyNotification] &&
            !strongSelf->_fullscreenTransitionActive &&
            (strongSelf->_window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
          [strongSelf captureWindowedTrafficLightFrames];
          [strongSelf hideResidualFullScreenTrafficLightOverlay];
        }
        [strongSelf updateWindowActiveState];
      } else if ([notification.name
                     isEqualToString:NSWindowWillEnterFullScreenNotification]) {
        // BrowserManager normally prepares the empty toolbar before asking
        // Electron to enter fullscreen. Keep this notification as a fallback
        // for native traffic-light initiated transitions.
        [strongSelf prepareForFullscreenTransition:YES];
      } else if ([notification.name
                     isEqualToString:NSWindowDidEnterFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = YES;
        // AppKit has already built NSToolbarFullScreenWindow. Never replace its
        // toolbar here; apply the final native visibility and frame geometry.
        [strongSelf attachAccessoryController];
        [strongSelf applyFullScreenPolicy];
        [strongSelf scheduleLiquidGlassTitlebarRehost];
      } else if ([notification.name
                     isEqualToString:NSWindowWillExitFullScreenNotification]) {
        NSWindow *titlebarHost = strongSelf->_accessoryController.view.window;
        if ([NSStringFromClass(titlebarHost.class)
                isEqualToString:@"NSToolbarFullScreenWindow"]) {
          strongSelf->_fullscreenTitlebarHostWindow = titlebarHost;
        }
        [strongSelf detachTitlebarWidgetInsetOverrides];
        [strongSelf updateTrafficLightObservation];
        strongSelf->_toolbar.visible = NO;
        [strongSelf detachAccessoryController];
      } else if ([notification.name
                     isEqualToString:NSWindowDidExitFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = NO;
        [strongSelf detachTitlebarWidgetInsetOverrides];
        if (!strongSelf->_previousFullSizeContentView) {
          strongSelf->_window.styleMask &=
              ~NSWindowStyleMaskFullSizeContentView;
        }
        // The fullscreen toolbar belongs to NSToolbarFullScreenWindow. Give
        // the normal titlebar a fresh toolbar as well; otherwise AppKit can
        // retain the fullscreen exit control in place of the three standard
        // traffic lights after the transition.
        [strongSelf restoreWindowedTitlebarHost];
        [strongSelf installFreshToolbarForWindowedMode];
        // Do not attach the trailing accessory in the same AppKit turn that
        // rebuilds the normal titlebar. On macOS 26 that races the standard
        // button layout and collapses the traffic lights into the temporary
        // fullscreen-exit pill. The scheduled rehost runs after AppKit has
        // established the windowed button geometry.
        [strongSelf applyLiquidGlassTitlebarAppearance];
        [strongSelf scheduleLiquidGlassTitlebarRehost];
      } else {
        [strongSelf applyFullScreenPolicy];
      }
    }];
    [_windowObservers addObject:observer];
  }

  id accessibilityObserver = [center
      addObserverForName:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification
                  object:nil
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(NSNotification *notification) {
    (void)notification;
    [weakSelf updateWindowActiveState];
  }];
  [_windowObservers addObject:accessibilityObserver];
}

- (NSToolbar *)makeToolbarHost {
  NSToolbar *toolbar = [[NSToolbar alloc]
      initWithIdentifier:[NSString
          stringWithFormat:@"rion-runtime-tabs-%p-%@", self,
                           NSUUID.UUID.UUIDString]];
  toolbar.allowsUserCustomization = NO;
  toolbar.autosavesConfiguration = NO;
  toolbar.displayMode = NSToolbarDisplayModeIconOnly;
  toolbar.showsBaselineSeparator = NO;
  return toolbar;
}

- (NSToolbar *)makeWindowedToolbar {
  NSToolbar *toolbar = [self makeToolbarHost];
  toolbar.delegate = self;
  return toolbar;
}

- (NSToolbar *)makeFullScreenToolbar {
  // NSToolbarFullScreenWindow only needs an empty native host. Reusing the
  // windowed delegate inserts its 28pt layout spacer as a second visible row
  // underneath the accessory during AppKit's auto-hide reveal.
  return [self makeToolbarHost];
}

- (void)installPreparedToolbarForFullScreen {
  if (_destroyed || !_window) return;
  if (!_fullscreenToolbar) _fullscreenToolbar = [self makeFullScreenToolbar];
  _fullscreenToolbar.delegate = nil;
  _fullscreenToolbar.visible = NO;
  _toolbar = _fullscreenToolbar;
  if (_window.toolbar != _toolbar) _window.toolbar = _toolbar;
  _toolbar.visible = NO;
}

- (void)installFreshToolbarForWindowedMode {
  if (_destroyed || !_window) return;
  [self removeTrafficLightObservationRestoringState:NO];
  _toolbar.delegate = nil;
  _toolbar = [self makeWindowedToolbar];
  _window.toolbar = _toolbar;
  _toolbar.visible = YES;
  // Prepare the next fullscreen host while the window is settled. It must
  // already exist before AppKit starts its next fullscreen transition.
  _fullscreenToolbar = [self makeFullScreenToolbar];
  [self restoreWindowedTrafficLightFrames];
}

- (void)restoreWindowedTitlebarHost {
  if (_destroyed || !_window) return;
  _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
  // Force AppKit to move the accessory out of NSToolbarFullScreenWindow.
  // Merely checking the browser window's controller array can leave the view
  // parented by the transition host even after DidExitFullScreen.
  [self detachAccessoryController];
  [self attachAccessoryController];
  _accessoryController.hidden = NO;
  _accessoryController.view.hidden = NO;
  _accessoryController.view.alphaValue = 1.0;
  [self layoutTitlebarContent];
}

- (void)captureWindowedTrafficLightFrames {
  if (_destroyed || !_window) return;
  for (NSNumber *buttonType in @[
         @(NSWindowCloseButton),
         @(NSWindowMiniaturizeButton),
         @(NSWindowZoomButton)
       ]) {
    NSButton *button =
        [_window standardWindowButton:(NSWindowButton)buttonType.integerValue];
    if (button && !NSIsEmptyRect(button.frame)) {
      _windowedTrafficLightFrames[buttonType] = [NSValue valueWithRect:button.frame];
    }
  }
}

- (void)restoreWindowedTrafficLightFrames {
  if (_destroyed || !_window) return;
  for (NSNumber *buttonType in @[
         @(NSWindowCloseButton),
         @(NSWindowMiniaturizeButton),
         @(NSWindowZoomButton)
       ]) {
    NSButton *button =
        [_window standardWindowButton:(NSWindowButton)buttonType.integerValue];
    NSValue *frame = _windowedTrafficLightFrames[buttonType];
    if (button && frame) button.frame = frame.rectValue;
    button.state = NSControlStateValueOff;
    button.hidden = NO;
    button.alphaValue = 1.0;
    button.needsDisplay = YES;
    button.superview.needsLayout = YES;
    button.superview.needsDisplay = YES;
  }
  [[_window standardWindowButton:NSWindowCloseButton].superview
      layoutSubtreeIfNeeded];
  [self hideResidualFullScreenTrafficLightOverlay];
}

- (void)hideResidualFullScreenTrafficLightOverlay {
  if (_destroyed || !_window ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
    return;
  }

  NSButton *closeButton = [_window standardWindowButton:NSWindowCloseButton];
  NSButton *minimizeButton =
      [_window standardWindowButton:NSWindowMiniaturizeButton];
  NSButton *zoomButton = [_window standardWindowButton:NSWindowZoomButton];
  if (!closeButton || !minimizeButton || !zoomButton) return;
  NSArray<NSButton *> *buttons = @[ closeButton, minimizeButton, zoomButton ];
  NSView *titlebar = buttons.firstObject.superview;
  if (!titlebar) return;

  NSRect clusterFrame = NSZeroRect;
  for (NSButton *button in buttons) {
    if (!button || button.superview != titlebar) return;
    clusterFrame = NSIsEmptyRect(clusterFrame)
        ? button.frame
        : NSUnionRect(clusterFrame, button.frame);
  }

  for (NSView *subview in titlebar.subviews) {
    if (subview == closeButton || subview == minimizeButton ||
        subview == zoomButton || subview.hidden ||
        !NSIntersectsRect(subview.frame, clusterFrame)) {
      continue;
    }
    // macOS 26 can retain its narrow fullscreen-exit overlay after the window
    // has returned to normal mode. It is the only non-button titlebar child
    // whose bounds cover just the traffic-light cluster; wide toolbar,
    // backdrop and accessory views are deliberately excluded.
    if (subview.frame.size.width <= _stableTrafficLightReserveWidth &&
        subview.frame.size.height <= kRionTitlebarHeight) {
      [subview removeFromSuperview];
    }
  }
}

- (void)applyLiquidGlassTitlebarAppearance {
  if (_destroyed || !_window) return;

  // These values are deliberately shared by windowed and fullscreen modes.
  // AppKit may reset parts of the titlebar while moving an accessory into the
  // fullscreen toolbar window, so keep this as the single appearance source.
  _window.titleVisibility = NSWindowTitleHidden;
  _window.titlebarAppearsTransparent = YES;
  if (@available(macOS 11.0, *)) {
    _window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    _window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
  }

  _toolbar.allowsUserCustomization = NO;
  _toolbar.autosavesConfiguration = NO;
  _toolbar.displayMode = NSToolbarDisplayModeIconOnly;
  _toolbar.showsBaselineSeparator = NO;

  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _titlebarBackdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  _titlebarBackdrop.material = NSVisualEffectMaterialHeaderView;
  _titlebarBackdrop.state = NSVisualEffectStateFollowsWindowActiveState;
  [self updateWindowActiveState];
}

- (void)scheduleLiquidGlassTitlebarRehost {
  __weak RionRuntimeTabsController *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    RionRuntimeTabsController *strongSelf = weakSelf;
    if (!strongSelf || strongSelf->_destroyed || !strongSelf->_window) return;

    // Electron can finish its own fullscreen transition after AppKit's
    // did-enter/did-exit notification. Reinstall the same toolbar and accessory
    // after both directions so neither mode briefly inherits default metrics.
    BOOL fullScreen = strongSelf->_fullscreenTransitionActive ||
        (strongSelf->_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
    if (strongSelf->_window.toolbar != strongSelf->_toolbar) {
      strongSelf->_window.toolbar = strongSelf->_toolbar;
    }
    [strongSelf applyFullScreenPolicy];
    if (!fullScreen) {
      [strongSelf restoreWindowedTrafficLightFrames];
      dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf restoreWindowedTrafficLightFrames];
      });
      dispatch_after(
          dispatch_time(DISPATCH_TIME_NOW,
                        (int64_t)(1000 * NSEC_PER_MSEC)),
          dispatch_get_main_queue(), ^{
        RionRuntimeTabsController *settledSelf = weakSelf;
        if (!settledSelf || settledSelf->_destroyed ||
            settledSelf->_fullscreenTransitionActive ||
            (settledSelf->_window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
          return;
        }
        // AppKit 26 can recreate its transient fullscreen-exit overlay near
        // the end of the post-notification titlebar animation. Run one
        // event-triggered settled pass after that animation; this is
        // intentionally not a cursor or timer poll.
        [settledSelf settleWindowedTitlebarAfterFullScreenExit];
      });
    }
  });
}

- (void)settleWindowedTitlebarAfterFullScreenExit {
  if (_destroyed || !_window || _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
    return;
  }

  // On macOS 26 the accessory can still be parented by the transition's
  // NSToolbarFullScreenWindow after DidExitFullScreen. Replacing the toolbar
  // immediately in the notification is not enough: the old auxiliary host
  // then survives as a detached 55pt strip containing the fullscreen-exit
  // control. Detach from that exact host, dismiss only that window, and build
  // the normal toolbar again once the AppKit animation has settled.
  NSWindow *staleHost = _fullscreenTitlebarHostWindow ?:
      _accessoryController.view.window;
  [self detachAccessoryController];
  if (staleHost != _window &&
      [NSStringFromClass(staleHost.class)
          isEqualToString:@"NSToolbarFullScreenWindow"]) {
    [staleHost orderOut:nil];
  }
  _fullscreenTitlebarHostWindow = nil;

  [self installFreshToolbarForWindowedMode];
  [self applyLiquidGlassTitlebarAppearance];
  [self applyFullScreenPolicy];
  [self restoreWindowedTrafficLightFrames];

  // AppKit 26 performs one last titlebar layout after a fresh NSToolbar is
  // assigned. Reattach the accessory after that turn so it cannot finish
  // hidden behind the toolbar host.
  __weak RionRuntimeTabsController *weakSelf = self;
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(100 * NSEC_PER_MSEC)),
      dispatch_get_main_queue(), ^{
    RionRuntimeTabsController *strongSelf = weakSelf;
    if (!strongSelf || strongSelf->_destroyed ||
        strongSelf->_fullscreenTransitionActive ||
        (strongSelf->_window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
      return;
    }
    [strongSelf restoreWindowedTitlebarHost];
    [strongSelf restoreWindowedTrafficLightFrames];
  });
}

- (nullable NSView *)toolbarHostView {
  if (!_toolbar) return nil;
  @try {
    id candidate = [_toolbar valueForKey:@"_toolbarView"];
    return [candidate isKindOfClass:NSView.class] ? candidate : nil;
  } @catch (__unused NSException *exception) {
    return nil;
  }
}

- (BOOL)orderToolbarBelowAccessory {
  if (_destroyed || !_window || !_toolbar) return NO;
  // NSToolbar's host view and titlebar accessories are siblings. AppKit puts
  // the toolbar host back above the accessory whenever it is revealed; on
  // macOS 26 that covers the Liquid Glass tabs with the fullscreen-exit pill.
  // Resolve the private view dynamically so older SDKs keep compiling.
  NSView *toolbarView = [self toolbarHostView];
  if (!toolbarView.superview) return NO;
  [toolbarView.superview addSubview:toolbarView
                         positioned:NSWindowBelow
                         relativeTo:nil];
  return YES;
}

- (void)revealToolbarAndOrderBelowAccessory {
  if (_destroyed || !_window || !_toolbar) return;

  _toolbar.visible = YES;
  if (![self orderToolbarBelowAccessory]) {
    // AppKit has changed this private accessor before. Re-adding the public
    // controller is Chromium's fallback and restores the intended z-order.
    [self detachAccessoryController];
    [self attachAccessoryController];
  }
}

- (void)attachAccessoryController {
  if (_destroyed || !_window || !_accessoryController) return;
  if (![_window.titlebarAccessoryViewControllers
          containsObject:_accessoryController]) {
    [_window addTitlebarAccessoryViewController:_accessoryController];
  }
}

- (void)detachAccessoryController {
  if (!_window || !_accessoryController) return;
  NSUInteger index = [_window.titlebarAccessoryViewControllers
      indexOfObjectIdenticalTo:_accessoryController];
  if (index != NSNotFound) {
    [_window removeTitlebarAccessoryViewControllerAtIndex:index];
  } else {
    [_accessoryController removeFromParentViewController];
  }
}

- (CGFloat)trafficLightReserveWidth {
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  if (fullScreen) return _stableTrafficLightReserveWidth;

  CGFloat maximumX = 0;
  for (NSNumber *buttonType in @[
         @(NSWindowCloseButton),
         @(NSWindowMiniaturizeButton),
         @(NSWindowZoomButton)
       ]) {
    NSButton *button =
        [_window standardWindowButton:(NSWindowButton)buttonType.integerValue];
    if (!button || !button.superview || button.hidden || button.alphaValue <= 0) continue;
    NSRect windowRect = [button.superview convertRect:button.frame toView:nil];
    maximumX = MAX(maximumX, NSMaxX(windowRect));
  }
  if (maximumX > 0) {
    _stableTrafficLightReserveWidth = ceil(maximumX + 8.0);
  }
  return _stableTrafficLightReserveWidth;
}

- (CGFloat)tabsContentWidth {
  CGFloat width = 0;
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    width += _tabItems[index].preferredWidth;
    if (index > 0) width += kRionTabSpacing;
  }
  return width;
}

- (void)layoutTitlebarContent {
  if (_destroyed || !_window) return;
  NSView *root = _accessoryController.view;
  CGFloat rootWidth = MAX(1.0, _window.frame.size.width);
  CGFloat rootHeight = kRionTitlebarHeight;
  root.frame = NSMakeRect(0, 0, rootWidth, rootHeight);
  _titlebarBackdrop.frame = root.bounds;
  _clusterContainer.frame = root.bounds;
  _clusterContent.frame = root.bounds;

  CGFloat leadingInset = [self trafficLightReserveWidth] + kRionRootLeadingInset;
  CGFloat tabsWidth = [self tabsContentWidth];
  CGFloat maximumViewportWidth = MAX(
      0,
      rootWidth - leadingInset - kRionRootTrailingDraggableWidth -
          kRionTabHeight - kRionAddButtonSpacing);
  CGFloat viewportWidth = MIN(tabsWidth, maximumViewportWidth);
  CGFloat verticalInset = MAX(0, (rootHeight - kRionTabHeight) / 2.0);
  _tabScrollView.frame = NSMakeRect(leadingInset, verticalInset,
                                    viewportWidth, kRionTabHeight);
  _tabCanvas.frame = NSMakeRect(0, 0, MAX(tabsWidth, viewportWidth), kRionTabHeight);

  CGFloat x = 0;
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    RionRuntimeTabItemView *item = _tabItems[index];
    RionRuntimeSurfaceView *surface = _tabSurfaces[index];
    CGFloat width = item.preferredWidth;
    surface.frame = NSMakeRect(x, 0, width, kRionTabHeight);
    [surface layoutSubtreeIfNeeded];
    item.frame = surface.bounds;
    [item layoutSubtreeIfNeeded];
    x += width + kRionTabSpacing;
  }
  _addSurface.frame = NSMakeRect(leadingInset + viewportWidth +
                                     kRionAddButtonSpacing,
                                 verticalInset, kRionTabHeight, kRionTabHeight);
  _addButton.frame = _addSurface.bounds;

  [self scrollActiveTabIntoView];
}

- (void)updateState:(RionRuntimeTabsState *)state {
  if (_destroyed) return;
  _displayID = state.displayID;
  _addButton.toolTip = state.addLabel;
  _addButton.accessibilityLabel = state.addLabel;

  NSMutableDictionary<NSString *, RionRuntimeTabItemView *> *existingItems =
      [NSMutableDictionary dictionary];
  NSMutableDictionary<NSString *, RionRuntimeSurfaceView *> *existingSurfaces =
      [NSMutableDictionary dictionary];
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    existingItems[_tabItems[index].tabIdentifier] = _tabItems[index];
    existingSurfaces[_tabItems[index].tabIdentifier] = _tabSurfaces[index];
  }

  NSMutableArray<RionRuntimeTabItemView *> *nextItems = [NSMutableArray array];
  NSMutableArray<RionRuntimeSurfaceView *> *nextSurfaces = [NSMutableArray array];
  for (RionRuntimeTabModel *tab in state.tabs) {
    RionRuntimeTabItemView *item = existingItems[tab.identifier];
    RionRuntimeSurfaceView *surface = existingSurfaces[tab.identifier];
    if (!item || !surface) {
      item = [[RionRuntimeTabItemView alloc] initWithFrame:NSZeroRect];
      item.tabsController = self;
      item.target = self;
      item.action = @selector(tabPressed:);
      surface = [[RionRuntimeSurfaceView alloc] initWithContentView:item
                                                       cornerRadius:14.0];
      item.surfaceView = surface;
    }
    item.sourceDisplayID = state.displayID;
    [item configureWithTab:tab
                     image:[self imageForTab:tab]
                 moreLabel:state.moreLabel
              windowActive:_window.isKeyWindow];
    [nextItems addObject:item];
    [nextSurfaces addObject:surface];
  }

  for (NSView *surface in _tabSurfaces) [surface removeFromSuperview];
  _tabItems = nextItems;
  _tabSurfaces = nextSurfaces;
  for (NSView *surface in _tabSurfaces) [_tabCanvas addSubview:surface];
  [self layoutTitlebarContent];
}

- (NSImage *)imageForTab:(RionRuntimeTabModel *)tab {
  if (tab.iconDataURL.length > 0) {
    NSRange comma = [tab.iconDataURL rangeOfString:@","];
    if (comma.location != NSNotFound) {
      NSString *encoded = [tab.iconDataURL substringFromIndex:comma.location + 1];
      NSData *data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
      NSImage *image = data ? [[NSImage alloc] initWithData:data] : nil;
      if (image) {
        image.size = NSMakeSize(16.0, 16.0);
        return image;
      }
    }
  }
  NSString *symbol = [tab.type isEqualToString:@"workspace"]
                         ? [self symbolForWorkspaceTemplate:tab.workspaceTemplate]
                         : @"gamecontroller";
  NSImage *image = [NSImage imageWithSystemSymbolName:symbol
                            accessibilityDescription:nil];
  image = [image imageWithSymbolConfiguration:
                     [NSImageSymbolConfiguration configurationWithPointSize:12.0
                                                                    weight:NSFontWeightMedium]];
  image.size = NSMakeSize(16.0, 16.0);
  return image;
}

- (NSString *)symbolForWorkspaceTemplate:(NSString *)workspaceTemplate {
  if ([workspaceTemplate containsString:@"columns"] ||
      [workspaceTemplate containsString:@"left"] ||
      [workspaceTemplate containsString:@"right"]) {
    return @"rectangle.split.2x1";
  }
  if ([workspaceTemplate isEqualToString:@"single"]) return @"rectangle";
  return @"square.grid.2x2";
}

- (void)updateWindowActiveState {
  BOOL windowActive = _window.isKeyWindow;
  for (RionRuntimeTabItemView *item in _tabItems) {
    [item updateWindowActive:windowActive];
  }
  [_addSurface updateActive:NO hovered:NO windowActive:windowActive animate:YES];
}

- (void)scrollActiveTabIntoView {
  if (_tabScrollView.bounds.size.width <= 0) return;
  NSUInteger activeIndex = [_tabItems indexOfObjectPassingTest:
      ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
    (void)index;
    if (item.activeTab) *stop = YES;
    return item.activeTab;
  }];
  if (activeIndex == NSNotFound) return;
  NSRect activeFrame = _tabSurfaces[activeIndex].frame;
  NSRect visible = _tabScrollView.contentView.bounds;
  CGFloat originX = visible.origin.x;
  if (NSMinX(activeFrame) < NSMinX(visible)) {
    originX = NSMinX(activeFrame);
  } else if (NSMaxX(activeFrame) > NSMaxX(visible)) {
    originX = NSMaxX(activeFrame) - visible.size.width;
  }
  CGFloat maximumOrigin = MAX(0, _tabCanvas.frame.size.width - visible.size.width);
  originX = MIN(maximumOrigin, MAX(0, originX));
  [_tabScrollView.contentView scrollToPoint:NSMakePoint(originX, 0)];
  [_tabScrollView reflectScrolledClipView:_tabScrollView.contentView];
}

- (void)tabPressed:(RionRuntimeTabItemView *)sender {
  [self activateTab:sender.tabIdentifier];
}

- (void)activateTab:(NSString *)tabIdentifier {
  if (_actionHandler && tabIdentifier.length > 0) {
    _actionHandler(@{ @"type" : @"activate", @"tabId" : tabIdentifier });
  }
}

- (void)showTabMenu:(NSString *)tabIdentifier {
  if (_actionHandler && tabIdentifier.length > 0) {
    _actionHandler(@{ @"type" : @"openTabMenu", @"tabId" : tabIdentifier });
  }
}

- (void)openLauncher:(id)sender {
  (void)sender;
  if (_actionHandler) _actionHandler(@{ @"type" : @"openLauncher" });
}

- (void)beginTabDrag:(RionRuntimeTabItemView *)item event:(NSEvent *)event {
  NSPasteboardItem *pasteboardItem = [[NSPasteboardItem alloc] init];
  [pasteboardItem
      setString:[NSString stringWithFormat:@"%ld\n%@", (long)item.sourceDisplayID,
                                           item.tabIdentifier]
        forType:RionRuntimeTabPasteboardType];
  NSDraggingItem *draggingItem =
      [[NSDraggingItem alloc] initWithPasteboardWriter:pasteboardItem];
  [draggingItem setDraggingFrame:item.bounds contents:item.surfaceView];
  [item beginDraggingSessionWithItems:@[ draggingItem ] event:event source:item];
}

- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view {
  NSPoint canvasPoint = [_tabCanvas convertPoint:point fromView:view];
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    if (canvasPoint.x < NSMidX(_tabSurfaces[index].frame)) {
      return _tabItems[index].tabIdentifier;
    }
  }
  return nil;
}

- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier {
  if (_tabSurfaces.count == 0) {
    _insertionIndicator.hidden = YES;
    return;
  }
  CGFloat canvasX = NSMaxX(_tabSurfaces.lastObject.frame) + kRionTabSpacing / 2.0;
  if (identifier.length > 0) {
    NSUInteger index = [_tabItems indexOfObjectPassingTest:
        ^BOOL(RionRuntimeTabItemView *item, NSUInteger itemIndex, BOOL *stop) {
      (void)itemIndex;
      if ([item.tabIdentifier isEqualToString:identifier]) *stop = YES;
      return [item.tabIdentifier isEqualToString:identifier];
    }];
    if (index != NSNotFound) {
      canvasX = NSMinX(_tabSurfaces[index].frame) - kRionTabSpacing / 2.0;
    }
  }
  NSPoint rootPoint = [_accessoryController.view
      convertPoint:NSMakePoint(canvasX, 0)
          fromView:_tabCanvas];
  _insertionIndicator.frame =
      NSMakeRect(round(rootPoint.x - 1.0),
                 MAX(0, (_accessoryController.view.bounds.size.height - 22.0) /
                            2.0),
                 2.0, 22.0);
  _insertionIndicator.hidden = NO;
}

- (void)hideInsertionIndicator {
  _insertionIndicator.hidden = YES;
}

- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                    sourceDisplayID:(NSInteger)sourceDisplayID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier {
  if (!_actionHandler || tabIdentifier.length == 0) return;
  if (sourceDisplayID != _displayID) {
    _actionHandler(@{
      @"type" : @"move",
      @"tabId" : tabIdentifier,
      @"displayId" : @(_displayID)
    });
    return;
  }
  if ([beforeIdentifier isEqualToString:tabIdentifier]) return;
  NSMutableDictionary<NSString *, id> *action = [@{
    @"type" : @"reorder",
    @"tabId" : tabIdentifier
  } mutableCopy];
  if (beforeIdentifier.length > 0) action[@"beforeTabId"] = beforeIdentifier;
  _actionHandler(action);
}

- (void)setAlwaysShowInFullScreen:(BOOL)alwaysShow {
  _alwaysShowInFullScreen = alwaysShow;
  [self applyFullScreenPolicy];
}

- (void)prepareForFullscreenTransition:(BOOL)fullScreen {
  if (_destroyed || !_window) return;
  [self ensureTitlebarHeightOverride];

  if (fullScreen) {
    // AppKit snapshots the toolbar and titlebar accessory geometry while the
    // fullscreen transition is starting. Install the already-created empty
    // toolbar synchronously before Electron calls -setFullScreen: so native
    // auto-hide owns one stable host for the entire transition.
    _fullscreenTransitionActive = YES;
    [self installPreparedToolbarForFullScreen];
    [self attachAccessoryController];
    [self applyLiquidGlassTitlebarAppearance];
    [self layoutTitlebarContent];
    _accessoryController.hidden = NO;
    _accessoryController.view.hidden = NO;
    _accessoryController.view.alphaValue = 1.0;

    // Preserve the transition geometry that already works for always-show:
    // top chrome stays hidden over full-size content until DidEnterFullscreen
    // applies its steady state. Auto-hide establishes the tab accessory's
    // final 40pt row before AppKit snapshots NSToolbarFullScreenWindow; the
    // hidden toolbar still keeps that row offscreen during the transition.
    _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
    _toolbar.visible = NO;
    [self removeTrafficLightObservationRestoringState:NO];
    [self scheduleContentLayoutNotification];
    return;
  }

  // A normal fullscreen exit keeps the fullscreen toolbar installed until
  // DidExitFullScreen. If entry failed before AppKit changed the style mask,
  // restore the settled windowed host immediately.
  if ((_window.styleMask & NSWindowStyleMaskFullScreen) != 0) return;
  _fullscreenTransitionActive = NO;
  [self detachTitlebarWidgetInsetOverrides];
  [self restoreWindowedTitlebarHost];
  [self installFreshToolbarForWindowedMode];
  [self applyLiquidGlassTitlebarAppearance];
  [self applyFullScreenPolicy];
}

- (void)setRevealLocked:(BOOL)locked {
  _revealLocked = locked;
  [self applyFullScreenPolicy];
}

- (RionRuntimeContentLayout)contentLayout {
  RionRuntimeContentLayout emptyLayout = {0, 0, NO};
  if (_destroyed || !_window) return emptyLayout;

  NSView *contentView = _window.contentView;
  if (!contentView) return emptyLayout;
  [contentView.superview layoutSubtreeIfNeeded];
  [contentView layoutSubtreeIfNeeded];

  // contentLayoutRect is AppKit's authoritative unobscured content region in
  // window coordinates. Convert it into Electron's contentView coordinates so
  // BrowserManager can lay out child Views without reproducing titlebar math.
  NSRect contentLayoutRect =
      [contentView convertRect:_window.contentLayoutRect fromView:nil];
  return RionRuntimeContentLayoutForRects(contentView.bounds,
                                          contentLayoutRect,
                                          contentView.isFlipped);
}

- (void)scheduleContentLayoutNotification {
  if (_destroyed || !_window || !_contentLayoutHandler ||
      _pendingContentLayoutNotification) {
    return;
  }

  __weak RionRuntimeTabsController *weakSelf = self;
  dispatch_block_t notification =
      dispatch_block_create((dispatch_block_flags_t)0, ^{
        RionRuntimeTabsController *strongSelf = weakSelf;
        if (!strongSelf) return;
        if (strongSelf->_destroyed || !strongSelf->_contentLayoutHandler) {
          strongSelf->_pendingContentLayoutNotification = nil;
          return;
        }

        RionRuntimeContentLayout layout = [strongSelf contentLayout];
        RionRuntimeContentLayout previous =
            strongSelf->_lastNotifiedContentLayout;
        if (strongSelf->_hasLastNotifiedContentLayout &&
            previous.valid == layout.valid &&
            previous.heightInset == layout.heightInset &&
            previous.yOffset == layout.yOffset) {
          strongSelf->_pendingContentLayoutNotification = nil;
          return;
        }
        strongSelf->_lastNotifiedContentLayout = layout;
        strongSelf->_hasLastNotifiedContentLayout = YES;
        strongSelf->_contentLayoutHandler(layout);
        strongSelf->_pendingContentLayoutNotification = nil;
      });
  _pendingContentLayoutNotification = notification;
  dispatch_async(dispatch_get_main_queue(), notification);
}

- (void)applyFullScreenPolicy {
  if (_destroyed || !_window) return;
  [self ensureTitlebarHeightOverride];
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  BOOL shouldShow = !fullScreen || self.alwaysShowInFullScreen ||
      self.revealLocked;

  if (fullScreen) {
    if (_window.toolbar != _toolbar) _window.toolbar = _toolbar;
    [self attachAccessoryController];
    [self applyLiquidGlassTitlebarAppearance];
    [self layoutTitlebarContent];
    _accessoryController.hidden = NO;
    _accessoryController.view.hidden = NO;
    _accessoryController.view.alphaValue = 1.0;

    if (self.alwaysShowInFullScreen) {
      // Keep Electron's root content full-size for both fullscreen policies.
      // BrowserManager follows AppKit's contentLayoutRect for the static-safe
      // child View area while this row remains visible.
      _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
      _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
      [self revealToolbarAndOrderBelowAccessory];
      [self synchronizeFullScreenTitlebarGeometry];
      [self updateTrafficLightObservation];
      [self scheduleContentLayoutNotification];
      return;
    }

    // Keep one trailing tab accessory at its final row height and let AppKit's
    // empty fullscreen NSToolbar host own top-edge tracking, clipping, and the
    // reveal animation. Full-size content keeps the native group overlaid.
    _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
    _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    if (self.revealLocked) {
      [self revealToolbarAndOrderBelowAccessory];
    } else {
      _toolbar.visible = NO;
    }
    [self synchronizeFullScreenTitlebarGeometry];
    [self removeTrafficLightObservationRestoringState:NO];
    [self scheduleContentLayoutNotification];
    return;
  }

  if (_previousFullSizeContentView) {
    _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  } else {
    _window.styleMask &= ~NSWindowStyleMaskFullSizeContentView;
  }
  if (_window.toolbar != _toolbar) _window.toolbar = _toolbar;
  [self restoreWindowedTitlebarHost];
  _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
  [self applyLiquidGlassTitlebarAppearance];
  [self layoutTitlebarContent];
  if (shouldShow) {
    [self revealToolbarAndOrderBelowAccessory];
  } else {
    _toolbar.visible = NO;
  }
  [self updateTrafficLightObservation];
  [self scheduleContentLayoutNotification];
}

- (void)updateTrafficLightObservation {
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  BOOL shouldObserve = fullScreen && self.alwaysShowInFullScreen &&
      _toolbar.visible;
  if (!shouldObserve) {
    // The saved state belongs to fullscreen AppKit, where traffic lights are
    // normally hidden. Restore it only while remaining in fullscreen. Once
    // the window exits, AppKit's newly established windowed state must win.
    [self removeTrafficLightObservationRestoringState:fullScreen];
    return;
  }

  if (_observedTrafficLightButtons.count == 0) {
    for (NSNumber *buttonType in @[
           @(NSWindowCloseButton),
           @(NSWindowMiniaturizeButton),
           @(NSWindowZoomButton)
         ]) {
      NSButton *button =
          [_window standardWindowButton:(NSWindowButton)buttonType.integerValue];
      if (!button) continue;

      NSValue *key = [NSValue valueWithPointer:(__bridge const void *)button];
      _originalTrafficLightStates[key] = @{
        @"alpha" : @(button.alphaValue),
        @"hidden" : @(button.hidden)
      };
      BOOL observingAlpha = NO;
      @try {
        [button addObserver:self
                 forKeyPath:@"alphaValue"
                    options:NSKeyValueObservingOptionNew
                    context:RionRuntimeTrafficLightObservationContext];
        observingAlpha = YES;
        [button addObserver:self
                 forKeyPath:@"hidden"
                    options:NSKeyValueObservingOptionNew
                    context:RionRuntimeTrafficLightObservationContext];
        [_observedTrafficLightButtons addObject:button];
      } @catch (NSException *exception) {
        if (observingAlpha) {
          [button removeObserver:self
                     forKeyPath:@"alphaValue"
                        context:RionRuntimeTrafficLightObservationContext];
        }
        [_originalTrafficLightStates removeObjectForKey:key];
        NSLog(@"Rion Studio could not observe a fullscreen traffic light: %@",
              exception.reason);
      }
    }
  }

  [self enforceTrafficLightVisibility];
  __weak RionRuntimeTabsController *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    [weakSelf enforceTrafficLightVisibility];
  });
}

- (void)enforceTrafficLightVisibility {
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  if (_destroyed || _enforcingTrafficLightVisibility || !fullScreen ||
      !self.alwaysShowInFullScreen || !_toolbar.visible) {
    return;
  }

  _enforcingTrafficLightVisibility = YES;
  for (NSButton *button in _observedTrafficLightButtons) {
    button.hidden = NO;
    button.alphaValue = 1.0;
  }
  _enforcingTrafficLightVisibility = NO;
}

- (void)removeTrafficLightObservationRestoringState:(BOOL)restoreState {
  if (_observedTrafficLightButtons.count == 0) return;
  _enforcingTrafficLightVisibility = YES;
  for (NSButton *button in _observedTrafficLightButtons) {
    @try {
      [button removeObserver:self
                  forKeyPath:@"alphaValue"
                     context:RionRuntimeTrafficLightObservationContext];
      [button removeObserver:self
                  forKeyPath:@"hidden"
                     context:RionRuntimeTrafficLightObservationContext];
    } @catch (NSException *exception) {
      NSLog(@"Rion Studio could not remove a traffic-light observer: %@",
            exception.reason);
    }
    if (restoreState) {
      NSValue *key = [NSValue valueWithPointer:(__bridge const void *)button];
      NSDictionary<NSString *, NSNumber *> *state =
          _originalTrafficLightStates[key];
      if (state) {
        button.alphaValue = state[@"alpha"].doubleValue;
        button.hidden = state[@"hidden"].boolValue;
      }
    }
  }
  [_observedTrafficLightButtons removeAllObjects];
  [_originalTrafficLightStates removeAllObjects];
  _enforcingTrafficLightVisibility = NO;
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  if (context == RionRuntimeTrafficLightObservationContext) {
    (void)keyPath;
    (void)object;
    (void)change;
    if (!_enforcingTrafficLightVisibility) {
      [self enforceTrafficLightVisibility];
    }
    return;
  }
  if (context == RionRuntimeContentLayoutObservationContext) {
    (void)keyPath;
    (void)object;
    (void)change;
    [self scheduleContentLayoutNotification];
    return;
  }
  [super observeValueForKeyPath:keyPath
                       ofObject:object
                         change:change
                        context:context];
}

- (void)destroy {
  if (_destroyed) return;
  _destroyed = YES;
  if (_pendingContentLayoutNotification) {
    dispatch_block_cancel(_pendingContentLayoutNotification);
    _pendingContentLayoutNotification = nil;
  }
  if (_contentLayoutObserved && _window) {
    [_window removeObserver:self
                 forKeyPath:@"contentLayoutRect"
                    context:RionRuntimeContentLayoutObservationContext];
    _contentLayoutObserved = NO;
  }
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (id observer in _windowObservers) [center removeObserver:observer];
  [_windowObservers removeAllObjects];
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window && (_window.styleMask & NSWindowStyleMaskFullScreen) != 0);
  [self removeTrafficLightObservationRestoringState:fullScreen];
  [self detachAccessoryController];
  [self detachTitlebarWidgetInsetOverrides];
  [self detachTitlebarHeightOverrideFromFrameView:_titlebarFrameView];
  _titlebarFrameView = nil;
  if (_window) {
    _window.toolbar = _previousToolbar;
    _window.titleVisibility = _previousTitleVisibility;
    _window.titlebarAppearsTransparent = _previousTitlebarAppearsTransparent;
    if (_previousFullSizeContentView) {
      _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    } else {
      _window.styleMask &= ~NSWindowStyleMaskFullSizeContentView;
    }
    if (@available(macOS 11.0, *)) {
      _window.toolbarStyle = _previousToolbarStyle;
      _window.titlebarSeparatorStyle = _previousTitlebarSeparatorStyle;
    }
    if (_hasPreviousCustomTitlebarHeight) {
      NSView *frameView = _window.contentView.superview;
      if ([self setCustomTitlebarHeight:_previousCustomTitlebarHeight
                            onFrameView:frameView]) {
        [self updateTitlebarButtonPositionsForFrameView:frameView];
        frameView.needsLayout = YES;
        [frameView layoutSubtreeIfNeeded];
      }
    }
  }
  _actionHandler = nil;
  _contentLayoutHandler = nil;
}

- (void)dealloc {
  [self destroy];
}

@end
