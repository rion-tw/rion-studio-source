#import "RionRuntimeTabsController.h"

#include <cmath>

// Unified compact is AppKit's 40pt titlebar host on macOS 12 and newer. Keep
// the accessory at the exact host height so the blur covers the whole row and
// never leaves a separator-colored strip above the game content.
static const CGFloat kRionTitlebarHeight = 40.0;
static const CGFloat kRionTabHeight = 28.0;
static const CGFloat kRionTabMinimumWidth = 112.0;
static const CGFloat kRionTabMaximumWidth = 224.0;
static const CGFloat kRionTabSpacing = 6.0;
static const CGFloat kRionAddButtonSpacing = 8.0;
static const CGFloat kRionRootLeadingInset = 4.0;
static const CGFloat kRionRootTrailingDraggableWidth = 12.0;
static const CGFloat kRionTrafficLightFallbackWidth = 76.0;
static const NSInteger kRionAddButtonTag = 41001;
static NSToolbarItemIdentifier const RionRuntimeToolbarSpacerIdentifier =
    @"com.rionstudio.runtime-tabs.layout-spacer";
static NSPasteboardType const RionRuntimeTabPasteboardType =
    @"com.rionstudio.runtime-tab";

// NSApplicationPresentationAutoHideToolbar is process-wide. Runtime windows
// can exist on more than one display, so merge their requests and restore the
// presentation bit that Electron owned before the first request.
static NSMutableDictionary<NSValue *, NSNumber *> *RionFullscreenToolbarRequests() {
  static NSMutableDictionary<NSValue *, NSNumber *> *requests;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    requests = [NSMutableDictionary dictionary];
  });
  return requests;
}

static BOOL RionFullscreenToolbarBaselineCaptured = NO;
static BOOL RionFullscreenToolbarBaselineAutoHide = NO;

static void RionApplyFullscreenToolbarPresentationPolicy() {
  NSApplication *application = NSApplication.sharedApplication;
  NSApplicationPresentationOptions current = application.presentationOptions;
  BOOL appIsFullScreen =
      (current & NSApplicationPresentationFullScreen) != 0;
  NSMutableDictionary<NSValue *, NSNumber *> *requests =
      RionFullscreenToolbarRequests();

  if (appIsFullScreen && !RionFullscreenToolbarBaselineCaptured &&
      requests.count > 0) {
    RionFullscreenToolbarBaselineCaptured = YES;
    RionFullscreenToolbarBaselineAutoHide =
        (current & NSApplicationPresentationAutoHideToolbar) != 0;
  }

  if (!appIsFullScreen) {
    if (requests.count == 0) {
      RionFullscreenToolbarBaselineCaptured = NO;
      RionFullscreenToolbarBaselineAutoHide = NO;
    }
    return;
  }

  BOOL shouldAutoHide = RionFullscreenToolbarBaselineAutoHide;
  if (requests.count > 0) {
    shouldAutoHide = YES;
    for (NSNumber *request in requests.objectEnumerator) {
      if (!request.boolValue) {
        shouldAutoHide = NO;
        break;
      }
    }
  }

  NSApplicationPresentationOptions updated = current;
  if (shouldAutoHide) {
    updated |= NSApplicationPresentationAutoHideToolbar;
  } else {
    updated &= ~NSApplicationPresentationAutoHideToolbar;
  }
  if (updated == current) return;

  @try {
    application.presentationOptions = updated;
  } @catch (NSException *exception) {
    NSLog(@"Rion Studio could not update the fullscreen toolbar policy: %@",
          exception.reason);
  }
}

static void RionSetFullscreenToolbarRequest(const void *owner, BOOL active,
                                            BOOL autoHide) {
  NSValue *key = [NSValue valueWithPointer:owner];
  NSMutableDictionary<NSValue *, NSNumber *> *requests =
      RionFullscreenToolbarRequests();
  if (active) {
    requests[key] = @(autoHide);
  } else {
    [requests removeObjectForKey:key];
  }
  RionApplyFullscreenToolbarPresentationPolicy();
  if (requests.count == 0) {
    RionFullscreenToolbarBaselineCaptured = NO;
    RionFullscreenToolbarBaselineAutoHide = NO;
  }
}

@class RionRuntimeTabsController;
@class RionRuntimeSurfaceView;

@interface RionRuntimeDraggableView : NSView
@end

@interface RionRuntimeBackdropView : NSVisualEffectView
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
- (void)detachAccessoryController;
- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                    sourceDisplayID:(NSInteger)sourceDisplayID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier;
- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view;
- (void)hideInsertionIndicator;
- (void)scheduleLiquidGlassTitlebarRehost;
- (void)updateFullscreenToolbarPresentationPolicy;
- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier;

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

@implementation RionRuntimeBackdropView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
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

  _titleField = [NSTextField labelWithString:@""];
  _titleField.alignment = NSTextAlignmentLeft;
  _titleField.lineBreakMode = NSLineBreakByTruncatingTail;
  _titleField.maximumNumberOfLines = 1;
  _titleField.usesSingleLineMode = YES;

  _badgeView = [[NSView alloc] initWithFrame:NSZeroRect];
  _badgeView.wantsLayer = YES;
  _badgeView.layer.cornerRadius = 8.0;
  _badgeView.layer.masksToBounds = YES;
  _badgeField = [NSTextField labelWithString:@""];
  _badgeField.alignment = NSTextAlignmentCenter;
  _badgeField.font = [NSFont monospacedDigitSystemFontOfSize:10.0
                                                    weight:NSFontWeightMedium];
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
  CGFloat fixedWidth = 10.0 + 16.0 + 6.0 + 4.0 + 20.0 + 8.0;
  if (!_badgeView.hidden) fixedWidth += 4.0 + _badgeWidth;
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
    _badgeWidth = MAX(18.0, ceil(measured) + 10.0);
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
  CGFloat x = 10.0;
  _iconView.frame = NSMakeRect(x, 6.0, 16.0, 16.0);
  x += 22.0;

  CGFloat moreX = MAX(x, width - 28.0);
  _moreButton.frame = NSMakeRect(moreX, 0, 20.0, kRionTabHeight);
  CGFloat titleEnd = moreX - 4.0;
  if (!_badgeView.hidden) {
    CGFloat badgeX = MAX(x, titleEnd - _badgeWidth);
    _badgeView.frame = NSMakeRect(badgeX, 6.0, _badgeWidth, 16.0);
    _badgeField.frame = _badgeView.bounds;
    titleEnd = badgeX - 4.0;
  }
  _titleField.frame = NSMakeRect(x, 5.0, MAX(1.0, titleEnd - x), 18.0);
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
  NSTitlebarAccessoryViewController *_accessoryController;
  RionRuntimeSurfaceView *_addSurface;
  RionRuntimeAddButton *_addButton;
  NSView *_clusterContainer;
  RionRuntimeDraggableView *_clusterContent;
  NSInteger _displayID;
  NSView *_insertionIndicator;
  NSToolbar *_toolbar;
  RionRuntimeDraggableView *_tabCanvas;
  NSMutableArray<RionRuntimeTabItemView *> *_tabItems;
  NSScrollView *_tabScrollView;
  NSMutableArray<RionRuntimeSurfaceView *> *_tabSurfaces;
  RionRuntimeBackdropView *_titlebarBackdrop;
  NSWindowTitleVisibility _previousTitleVisibility;
  BOOL _previousTitlebarAppearsTransparent;
  NSWindowToolbarStyle _previousToolbarStyle;
  NSToolbar *_previousToolbar;
  __weak NSWindow *_window;
  NSMutableArray<id> *_windowObservers;
  BOOL _destroyed;
  BOOL _fullscreenTransitionActive;
  CGFloat _stableTrafficLightReserveWidth;
}

- (nullable instancetype)initWithWindow:(NSWindow *)window
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler {
  if (!window || !actionHandler) return nil;
  self = [super init];
  if (!self) return nil;

  _window = window;
  _actionHandler = [actionHandler copy];
  _tabItems = [NSMutableArray array];
  _tabSurfaces = [NSMutableArray array];
  _windowObservers = [NSMutableArray array];
  _previousTitleVisibility = window.titleVisibility;
  _previousTitlebarAppearsTransparent = window.titlebarAppearsTransparent;
  _previousToolbarStyle = window.toolbarStyle;
  _previousToolbar = window.toolbar;
  _fullscreenTransitionActive =
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  _stableTrafficLightReserveWidth = kRionTrafficLightFallbackWidth;

  window.titleVisibility = NSWindowTitleHidden;
  window.titlebarAppearsTransparent = YES;
  if (@available(macOS 11.0, *)) {
    window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
  }

  _toolbar = [[NSToolbar alloc]
      initWithIdentifier:[NSString stringWithFormat:@"rion-runtime-tabs-%p", self]];
  _toolbar.allowsUserCustomization = NO;
  _toolbar.autosavesConfiguration = NO;
  _toolbar.delegate = self;
  _toolbar.displayMode = NSToolbarDisplayModeIconOnly;
  _toolbar.showsBaselineSeparator = NO;
  _toolbar.visible = YES;
  window.toolbar = _toolbar;

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
  [self installWindowObservers];
  return self;
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
      } else if ([notification.name isEqualToString:NSWindowDidBecomeKeyNotification] ||
                 [notification.name isEqualToString:NSWindowDidResignKeyNotification]) {
        [strongSelf updateWindowActiveState];
      } else if ([notification.name
                     isEqualToString:NSWindowWillEnterFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = YES;
        [strongSelf detachAccessoryController];
        strongSelf->_toolbar.visible = NO;
        strongSelf->_window.toolbar = strongSelf->_previousToolbar;
      } else if ([notification.name
                     isEqualToString:NSWindowDidEnterFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = YES;
        strongSelf->_window.toolbar = strongSelf->_toolbar;
        [strongSelf applyFullScreenPolicy];
        [strongSelf scheduleLiquidGlassTitlebarRehost];
      } else if ([notification.name
                     isEqualToString:NSWindowWillExitFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = NO;
        [strongSelf updateFullscreenToolbarPresentationPolicy];
        strongSelf->_toolbar.visible = NO;
        [strongSelf detachAccessoryController];
      } else if ([notification.name
                     isEqualToString:NSWindowDidExitFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = NO;
        strongSelf->_window.toolbar = strongSelf->_toolbar;
        [strongSelf applyFullScreenPolicy];
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

- (void)applyLiquidGlassTitlebarAppearance {
  if (_destroyed || !_window) return;

  // These values are deliberately shared by windowed and fullscreen modes.
  // AppKit may reset parts of the titlebar while moving an accessory into the
  // fullscreen toolbar window, so keep this as the single appearance source.
  _window.titleVisibility = NSWindowTitleHidden;
  _window.titlebarAppearsTransparent = YES;
  if (@available(macOS 11.0, *)) {
    _window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
  }

  _toolbar.allowsUserCustomization = NO;
  _toolbar.autosavesConfiguration = NO;
  _toolbar.delegate = self;
  _toolbar.displayMode = NSToolbarDisplayModeIconOnly;
  _toolbar.showsBaselineSeparator = NO;

  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
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
    strongSelf->_window.toolbar = strongSelf->_toolbar;
    [strongSelf applyFullScreenPolicy];
  });
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
  CGFloat rootHeight = root.bounds.size.height;
  if (rootHeight < kRionTabHeight) rootHeight = kRionTitlebarHeight;
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

- (void)setRevealLocked:(BOOL)locked {
  _revealLocked = locked;
  [self applyFullScreenPolicy];
}

- (void)applyFullScreenPolicy {
  if (_destroyed || !_window) return;
  if (_window.toolbar != _toolbar) _window.toolbar = _toolbar;
  [self attachAccessoryController];
  [self applyLiquidGlassTitlebarAppearance];
  [self layoutTitlebarContent];
  // The toolbar must remain present in both modes. AppKit's presentation
  // option detaches and rolls the complete compact toolbar in/out together
  // with the menu bar; hiding NSToolbar here would reveal only the 32pt base
  // titlebar and squeeze the tabs into the traffic lights.
  _toolbar.visible = YES;
  [self updateFullscreenToolbarPresentationPolicy];
}

- (void)updateFullscreenToolbarPresentationPolicy {
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  BOOL autoHide = !self.alwaysShowInFullScreen && !self.revealLocked;
  RionSetFullscreenToolbarRequest((__bridge const void *)self, fullScreen,
                                  autoHide);
}

- (void)destroy {
  if (_destroyed) return;
  _destroyed = YES;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (id observer in _windowObservers) [center removeObserver:observer];
  [_windowObservers removeAllObjects];
  RionSetFullscreenToolbarRequest((__bridge const void *)self, NO, NO);
  [self detachAccessoryController];
  if (_window) {
    _window.toolbar = _previousToolbar;
    _window.titleVisibility = _previousTitleVisibility;
    _window.titlebarAppearsTransparent = _previousTitlebarAppearsTransparent;
    if (@available(macOS 11.0, *)) {
      _window.toolbarStyle = _previousToolbarStyle;
    }
  }
  _actionHandler = nil;
}

- (void)dealloc {
  [self destroy];
}

@end
