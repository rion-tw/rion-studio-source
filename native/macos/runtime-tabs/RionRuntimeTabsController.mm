#import "RionRuntimeTabsController.h"

#include <cmath>

static const CGFloat kRionTitlebarHeight = 36.0;
static const CGFloat kRionTabHeight = 28.0;
static const CGFloat kRionTabMinimumWidth = 96.0;
static const CGFloat kRionTabMaximumWidth = 220.0;
static const NSInteger kRionAddButtonTag = 41001;
static NSPasteboardType const RionRuntimeTabPasteboardType =
    @"com.rionstudio.runtime-tab";

@class RionRuntimeTabsController;

@interface RionRuntimeTabButton : NSButton <NSDraggingSource>

@property(nonatomic) BOOL activeTab;
@property(nonatomic, weak) RionRuntimeTabsController *tabsController;
@property(nonatomic, copy) NSString *tabIdentifier;
@property(nonatomic) NSInteger sourceDisplayID;

@end

@interface RionRuntimeTabsRootView : NSView <NSDraggingDestination>

@property(nonatomic, weak) RionRuntimeTabsController *tabsController;

@end

@interface RionRuntimeTabsController ()

@property(nonatomic, readwrite) BOOL alwaysShowInFullScreen;
@property(nonatomic, readwrite) BOOL revealLocked;

- (void)activateTab:(NSString *)tabIdentifier;
- (void)attachAccessoryController;
- (void)beginTabDrag:(RionRuntimeTabButton *)button event:(NSEvent *)event;
- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                    sourceDisplayID:(NSInteger)sourceDisplayID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier;
- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view;

@end


@implementation RionRuntimeTabModel
@end

@implementation RionRuntimeTabsState
@end

@implementation RionRuntimeTabButton {
  NSTrackingArea *_trackingArea;
  BOOL _hovered;
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
  _hovered = YES;
  self.needsDisplay = YES;
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  _hovered = NO;
  self.needsDisplay = YES;
}

- (void)drawRect:(NSRect)dirtyRect {
  NSColor *fill = nil;
  if (self.activeTab) {
    fill = [NSColor.selectedContentBackgroundColor colorWithAlphaComponent:0.34];
  } else if (_hovered) {
    fill = [NSColor.controlAccentColor colorWithAlphaComponent:0.12];
  }
  if (fill) {
    [fill setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 1.0, 1.0)
                                     xRadius:7.0
                                     yRadius:7.0] fill];
  }
  [super drawRect:dirtyRect];
}

- (void)mouseDown:(NSEvent *)event {
  NSPoint start = event.locationInWindow;
  while (true) {
    NSEvent *next = [self.window
        nextEventMatchingMask:NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged];
    if (!next || next.type == NSEventTypeLeftMouseUp) {
      [self performClick:nil];
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

@implementation RionRuntimeTabsRootView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    [self registerForDraggedTypes:@[ RionRuntimeTabPasteboardType ]];
  }
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
  return [[sender draggingPasteboard] availableTypeFromArray:@[
    RionRuntimeTabPasteboardType
  ]]
             ? NSDragOperationMove
             : NSDragOperationNone;
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
  [self.tabsController handleDropWithTabIdentifier:tabIdentifier
                                   sourceDisplayID:sourceDisplayID
                                  beforeIdentifier:beforeIdentifier];
  return YES;
}

@end

@implementation RionRuntimeTabsController {
  RionRuntimeTabsActionHandler _actionHandler;
  NSTitlebarAccessoryViewController *_accessoryController;
  NSButton *_addButton;
  NSInteger _displayID;
  NSStackView *_tabStack;
  NSMutableArray<RionRuntimeTabButton *> *_tabButtons;
  NSScrollView *_tabScrollView;
  NSToolbar *_toolbar;
  NSWindowTitleVisibility _previousTitleVisibility;
  BOOL _previousTitlebarAppearsTransparent;
  NSToolbar *_previousToolbar;
  __weak NSWindow *_window;
  NSMutableArray<id> *_windowObservers;
  BOOL _destroyed;
}

- (nullable instancetype)initWithWindow:(NSWindow *)window
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler {
  if (!window || !actionHandler) return nil;
  self = [super init];
  if (!self) return nil;

  _window = window;
  _actionHandler = [actionHandler copy];
  _tabButtons = [NSMutableArray array];
  _windowObservers = [NSMutableArray array];
  _previousTitleVisibility = window.titleVisibility;
  _previousTitlebarAppearsTransparent = window.titlebarAppearsTransparent;
  _previousToolbar = window.toolbar;

  window.titleVisibility = NSWindowTitleHidden;
  window.titlebarAppearsTransparent = NO;
  if (@available(macOS 11.0, *)) window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;

  _toolbar = [[NSToolbar alloc]
      initWithIdentifier:[NSString stringWithFormat:@"rion-runtime-tabs-%p", self]];
  _toolbar.allowsUserCustomization = NO;
  _toolbar.autosavesConfiguration = NO;
  _toolbar.displayMode = NSToolbarDisplayModeIconOnly;
  _toolbar.showsBaselineSeparator = NO;
  _toolbar.visible = NO;

  RionRuntimeTabsRootView *root = [[RionRuntimeTabsRootView alloc]
      initWithFrame:NSMakeRect(0, 0, MAX(1.0, window.frame.size.width),
                               kRionTitlebarHeight)];
  root.tabsController = self;

  _tabScrollView = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  _tabScrollView.autohidesScrollers = YES;
  _tabScrollView.borderType = NSNoBorder;
  _tabScrollView.drawsBackground = NO;
  _tabScrollView.hasHorizontalScroller = NO;
  _tabScrollView.hasVerticalScroller = NO;

  _tabStack = [[NSStackView alloc] initWithFrame:NSZeroRect];
  _tabStack.alignment = NSLayoutAttributeCenterY;
  _tabStack.distribution = NSStackViewDistributionGravityAreas;
  _tabStack.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  _tabStack.spacing = 4.0;
  _tabStack.accessibilityRole = NSAccessibilityTabGroupRole;
  _tabScrollView.documentView = _tabStack;

  _addButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"plus"
                                                              accessibilityDescription:nil]
                                 target:self
                                 action:@selector(openLauncher:)];
  _addButton.bordered = NO;
  _addButton.tag = kRionAddButtonTag;
  _addButton.imageScaling = NSImageScaleProportionallyDown;

  [root addSubview:_tabScrollView];
  [root addSubview:_addButton];
  _accessoryController = [[NSTitlebarAccessoryViewController alloc] init];
  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _accessoryController.fullScreenMinHeight = kRionTitlebarHeight;
  _accessoryController.view = root;
  [self attachAccessoryController];
  [self layoutTitlebarContent];
  [self installWindowObservers];
  return self;
}

- (NSUInteger)renderedTabCount {
  return _tabButtons.count;
}

- (void)installWindowObservers {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  __weak RionRuntimeTabsController *weakSelf = self;
  NSArray<NSNotificationName> *names = @[
    NSWindowDidResizeNotification,
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
      } else if ([notification.name
                     isEqualToString:NSWindowWillEnterFullScreenNotification]) {
        // AppKit needs to re-host the accessory inside its fullscreen toolbar
        // window after the transition. Leaving it attached here makes the tab
        // row stay visible even while the fullscreen toolbar is hidden.
        [strongSelf->_accessoryController removeFromParentViewController];
      } else if ([notification.name
                     isEqualToString:NSWindowDidEnterFullScreenNotification]) {
        // Matching Chromium's immersive titlebar timing is important here:
        // attaching a toolbar before the fullscreen transition makes AppKit
        // reserve an empty toolbar row even when the toolbar is hidden.
        strongSelf->_window.toolbar = strongSelf->_toolbar;
        [strongSelf attachAccessoryController];
        [strongSelf applyFullScreenPolicy];
      } else if ([notification.name
                     isEqualToString:NSWindowWillExitFullScreenNotification]) {
        strongSelf->_toolbar.visible = NO;
        [strongSelf->_accessoryController removeFromParentViewController];
      } else if ([notification.name
                     isEqualToString:NSWindowDidExitFullScreenNotification]) {
        strongSelf->_window.toolbar = strongSelf->_previousToolbar;
        [strongSelf attachAccessoryController];
        [strongSelf layoutTitlebarContent];
      } else {
        [strongSelf applyFullScreenPolicy];
      }
    }];
    [_windowObservers addObject:observer];
  }
}

- (void)attachAccessoryController {
  if (_destroyed || !_window || !_accessoryController) return;
  if (![_window.titlebarAccessoryViewControllers
          containsObject:_accessoryController]) {
    [_window addTitlebarAccessoryViewController:_accessoryController];
  }
}

- (void)layoutTitlebarContent {
  if (_destroyed || !_window) return;
  NSView *root = _accessoryController.view;
  CGFloat width = MAX(1.0, _window.frame.size.width - 76.0);
  root.frame = NSMakeRect(0, 0, width, kRionTitlebarHeight);
  CGFloat addWidth = 30.0;
  _tabScrollView.frame = NSMakeRect(0, 0, MAX(1.0, width - addWidth - 4.0),
                                    kRionTitlebarHeight);
  _addButton.frame = NSMakeRect(MAX(0.0, width - addWidth), 3.0, addWidth,
                                kRionTabHeight);

  CGFloat stackWidth = 0;
  for (NSView *view in _tabStack.arrangedSubviews) stackWidth += view.frame.size.width;
  if (_tabStack.arrangedSubviews.count > 1) {
    stackWidth += (_tabStack.arrangedSubviews.count - 1) * _tabStack.spacing;
  }
  _tabStack.frame = NSMakeRect(0, 4.0, MAX(stackWidth, _tabScrollView.bounds.size.width),
                               kRionTabHeight);
}

- (void)updateState:(RionRuntimeTabsState *)state {
  if (_destroyed) return;
  _displayID = state.displayID;
  _addButton.toolTip = state.addLabel;
  _addButton.accessibilityLabel = state.addLabel;

  for (NSView *view in [_tabStack.arrangedSubviews copy]) {
    [_tabStack removeArrangedSubview:view];
    [view removeFromSuperview];
  }
  [_tabButtons removeAllObjects];

  for (RionRuntimeTabModel *tab in state.tabs) {
    CGFloat nameWidth = [tab.name sizeWithAttributes:@{
      NSFontAttributeName : [NSFont systemFontOfSize:12.0]
    }].width;
    CGFloat width = MIN(kRionTabMaximumWidth,
                        MAX(kRionTabMinimumWidth, nameWidth + 66.0));
    NSView *item = [[NSView alloc]
        initWithFrame:NSMakeRect(0, 0, width, kRionTabHeight)];

    RionRuntimeTabButton *button = [[RionRuntimeTabButton alloc]
        initWithFrame:NSMakeRect(0, 0, width - 24.0, kRionTabHeight)];
    button.activeTab = tab.active;
    button.bordered = NO;
    button.font = [NSFont systemFontOfSize:12.0 weight:NSFontWeightRegular];
    button.image = [self imageForTab:tab];
    button.imagePosition = NSImageLeft;
    button.imageScaling = NSImageScaleProportionallyDown;
    button.lineBreakMode = NSLineBreakByTruncatingTail;
    button.sourceDisplayID = state.displayID;
    button.tabIdentifier = tab.identifier;
    button.tabsController = self;
    button.target = self;
    button.action = @selector(tabPressed:);
    button.title = tab.roleCount > 0
                       ? [NSString stringWithFormat:@"%@  %ld", tab.name,
                                                    (long)tab.roleCount]
                       : tab.name;
    button.toolTip = tab.name;
    button.accessibilityLabel = tab.name;
    button.accessibilityRole = NSAccessibilityRadioButtonRole;
    button.accessibilityValue = @(tab.active);

    NSButton *more = [NSButton
        buttonWithImage:[NSImage imageWithSystemSymbolName:@"ellipsis"
                                 accessibilityDescription:state.moreLabel]
                 target:self
                 action:@selector(morePressed:)];
    more.bordered = NO;
    more.frame = NSMakeRect(width - 24.0, 0, 24.0, kRionTabHeight);
    more.identifier = tab.identifier;
    more.toolTip = state.moreLabel;
    more.accessibilityLabel = state.moreLabel;

    [item addSubview:button];
    [item addSubview:more];
    [_tabButtons addObject:button];
    [_tabStack addArrangedSubview:item];
  }
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

- (void)tabPressed:(RionRuntimeTabButton *)sender {
  [self activateTab:sender.tabIdentifier];
}

- (void)activateTab:(NSString *)tabIdentifier {
  if (_actionHandler && tabIdentifier.length > 0) {
    _actionHandler(@{ @"type" : @"activate", @"tabId" : tabIdentifier });
  }
}

- (void)morePressed:(NSButton *)sender {
  [self showTabMenu:sender.identifier];
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

- (void)beginTabDrag:(RionRuntimeTabButton *)button event:(NSEvent *)event {
  NSPasteboardItem *pasteboardItem = [[NSPasteboardItem alloc] init];
  [pasteboardItem
      setString:[NSString stringWithFormat:@"%ld\n%@", (long)button.sourceDisplayID,
                                           button.tabIdentifier]
        forType:RionRuntimeTabPasteboardType];
  NSDraggingItem *draggingItem =
      [[NSDraggingItem alloc] initWithPasteboardWriter:pasteboardItem];
  [draggingItem setDraggingFrame:button.bounds contents:button];
  [button beginDraggingSessionWithItems:@[ draggingItem ] event:event source:button];
}

- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view {
  NSPoint stackPoint = [_tabStack convertPoint:point fromView:view];
  for (RionRuntimeTabButton *button in _tabButtons) {
    NSRect frame = [_tabStack convertRect:button.superview.frame
                                  fromView:button.superview.superview];
    if (stackPoint.x < NSMidX(frame)) return button.tabIdentifier;
  }
  return nil;
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
  BOOL fullScreen = (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  if (fullScreen) {
    // Electron can finish applying its own fullscreen window state after the
    // AppKit did-enter notification. Reassert the immersive toolbar host when
    // policy or reveal-lock state changes so the accessory remains attached to
    // the live fullscreen titlebar window.
    if (_window.toolbar != _toolbar) _window.toolbar = _toolbar;
    [self attachAccessoryController];
  }
  _toolbar.visible = fullScreen &&
                     (self.alwaysShowInFullScreen || self.revealLocked);
}

- (void)destroy {
  if (_destroyed) return;
  _destroyed = YES;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (id observer in _windowObservers) [center removeObserver:observer];
  [_windowObservers removeAllObjects];
  [_accessoryController removeFromParentViewController];
  if (_window) {
    _window.toolbar = _previousToolbar;
    _window.titleVisibility = _previousTitleVisibility;
    _window.titlebarAppearsTransparent = _previousTitlebarAppearsTransparent;
  }
  _actionHandler = nil;
}

- (void)dealloc {
  [self destroy];
}

@end
