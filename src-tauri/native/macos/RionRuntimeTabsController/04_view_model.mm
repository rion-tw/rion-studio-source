NS_ASSUME_NONNULL_BEGIN

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
  [self.tabsController scrollTabStripForDragPoint:point inView:self];
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = RionRuntimeTabDragPayloadParts(payload);
  if (parts) {
    CGFloat grabRatioX = parts[3].doubleValue;
    CGFloat sourceTabWidth = parts[5].doubleValue;
    id source = sender.draggingSource;
    if ([source isKindOfClass:RionRuntimeTabItemView.class]) {
      [(RionRuntimeTabItemView *)source
          lockDragPreviewToScreenY:self.tabsController.dragPreviewScreenOriginY];
    }
    [self.tabsController setDragPlaceholderIdentifier:parts[1]];
    [self.tabsController positionDragSurfaceForTabIdentifier:parts[1]
                                                     atPoint:point
                                                      inView:self
                                                  grabRatioX:grabRatioX
                                               sourceTabWidth:sourceTabWidth];
    NSString *identifier =
        [self.tabsController stableTabIdentifierBeforePoint:point
                                                     inView:self
                                       draggedTabIdentifier:parts[1]
                                                  sessionID:parts[2]
                                                 grabRatioX:grabRatioX
                                             sourceTabWidth:sourceTabWidth];
    BOOL reorderedLocalTab =
        [self.tabsController previewDragTabIdentifier:parts[1]
                                    beforeIdentifier:identifier];
    if (reorderedLocalTab) {
      [self.tabsController hideExternalDragGhost];
      [self.tabsController hideInsertionIndicator];
    } else {
      // Keep a lightweight slot while the memory-only runtime lane reparents
      // the real tab and WKWebView into this host.
      [self.tabsController showExternalDragGhostForTabIdentifier:parts[1]
                                                beforeIdentifier:identifier
                                                            width:sourceTabWidth];
      [self.tabsController hideInsertionIndicator];
    }
    NSPoint screenPoint =
        [self.window convertPointToScreen:sender.draggingLocation];
    [self.tabsController handleHoverWithTabIdentifier:parts[1]
                                        sourceWindowID:parts[0]
                                             sessionID:parts[2]
                                      beforeIdentifier:identifier
                                           screenPoint:screenPoint];
  } else {
    NSString *identifier =
        [self.tabsController tabIdentifierBeforePoint:point inView:self];
    [self.tabsController updateInsertionIndicatorBeforeIdentifier:identifier];
  }
  return NSDragOperationMove;
}

- (void)draggingExited:(nullable id<NSDraggingInfo>)sender {
  id source = sender.draggingSource;
  if ([source isKindOfClass:RionRuntimeTabItemView.class]) {
    RionRuntimeTabItemView *sourceItem = (RionRuntimeTabItemView *)source;
    [sourceItem clearDragPreviewYLock];
  }
  [self.tabsController hideInsertionIndicator];
  [self.tabsController hideExternalDragGhost];
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = RionRuntimeTabDragPayloadParts(payload);
  if (!parts) {
    [self.tabsController setDragPlaceholderIdentifier:nil];
  }
  [self.tabsController resetTabDragInsertionState];
  [self.tabsController stopTabDragEdgeScroll];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = RionRuntimeTabDragPayloadParts(payload);
  if (!parts) return NO;
  NSString *sourceWindowID = parts[0];
  NSString *tabIdentifier = parts[1];
  NSString *sessionID = parts[2];
  NSPoint point = [self convertPoint:sender.draggingLocation fromView:nil];
  NSString *beforeIdentifier =
      [self.tabsController stableTabIdentifierBeforePoint:point
                                                   inView:self
                                     draggedTabIdentifier:tabIdentifier
                                                sessionID:sessionID
                                               grabRatioX:parts[3].doubleValue
                                           sourceTabWidth:parts[5].doubleValue];
  [self.tabsController previewDragTabIdentifier:tabIdentifier
                                beforeIdentifier:beforeIdentifier];
  NSPoint screenPoint =
      [self.window convertPointToScreen:sender.draggingLocation];
  id source = sender.draggingSource;
  if ([source isKindOfClass:RionRuntimeTabItemView.class]) {
    RionRuntimeTabItemView *sourceItem = (RionRuntimeTabItemView *)source;
    sourceItem.tabDropHandled = YES;
    [sourceItem clearDragPreviewYLock];
  }
  [self.tabsController hideInsertionIndicator];
  [self.tabsController hideExternalDragGhost];
  [self.tabsController setDragPlaceholderIdentifier:nil];
  [self.tabsController resetTabDragInsertionState];
  [self.tabsController stopTabDragEdgeScroll];
  [self.tabsController handleDropWithTabIdentifier:tabIdentifier
                                    sourceWindowID:sourceWindowID
                                         sessionID:sessionID
                                  beforeIdentifier:beforeIdentifier
                                       screenPoint:screenPoint];
  return YES;
}

@end

@implementation RionRuntimeTitlebarAccessoryViewController

- (void)viewDidAppear {
  [super viewDidAppear];
  if (self.appearanceHandler) self.appearanceHandler();
}

@end

@implementation RionRuntimeTabsController {
  RionRuntimeTabsActionHandler _actionHandler;
  RionRuntimeContentLayoutHandler _contentLayoutHandler;
  RionRuntimeTitlebarAccessoryViewController *_accessoryController;
  RionRuntimeSurfaceView *_addSurface;
  RionRuntimeAddButton *_addButton;
  RionRuntimeSurfaceView *_scrollLeftSurface;
  RionRuntimeAddButton *_scrollLeftButton;
  RionRuntimeSurfaceView *_scrollRightSurface;
  RionRuntimeAddButton *_scrollRightButton;
  NSView *_clusterContainer;
  RionRuntimeDraggableView *_clusterContent;
  NSString *_windowID;
  NSView *_insertionIndicator;
  NSString *_dragPlaceholderTabIdentifier;
  NSString *_dragInsertionSessionIdentifier;
  NSString *_dragInsertionBeforeIdentifier;
  NSString *_dragHoverSessionIdentifier;
  NSString *_dragHoverBeforeIdentifier;
  CGFloat _dragInsertionVisualCenterX;
  NSString *_externalDragGhostBeforeIdentifier;
  NSString *_externalDragGhostTabIdentifier;
  CGFloat _externalDragGhostWidth;
  CGFloat _dragSurfaceCanvasX;
  NSString *_dragSurfacePositionTabIdentifier;
  BOOL _dragSurfaceOverlayActive;
  BOOL _dragSurfaceVisible;
  CGFloat _dragScrollRootX;
  NSTimer *_dragScrollTimer;
  NSMutableArray<NSButton *> *_observedTrafficLightButtons;
  NSMutableDictionary<NSValue *, NSDictionary<NSString *, NSNumber *> *> *
      _originalTrafficLightStates;
  NSMutableDictionary<NSNumber *, NSValue *> *_windowedTrafficLightFrames;
  RionRuntimeWindowNameField *_windowNameField;
  NSToolbar *_fullscreenToolbar;
  NSToolbar *_toolbar;
  dispatch_block_t _pendingContentLayoutNotification;
  dispatch_block_t _pendingFullscreenHostRefresh;
  RionRuntimeDraggableView *_tabCanvas;
  __weak RionRuntimeTabItemView *_activeTabItem;
  NSMutableArray<RionRuntimeTabItemView *> *_tabItems;
  NSMutableDictionary<NSString *, RionRuntimeTabItemView *> *_tabItemsByIdentifier;
  NSMutableDictionary<NSString *, NSImage *> *_tabIconCache;
  NSMutableDictionary<NSString *, NSString *> *_tabIconCacheKeys;
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
  __weak NSResponder *_tabShortcutOriginResponder;
  NSString *_tabShortcutOriginTabIdentifier;
  NSEventModifierFlags _tabShortcutPendingModifiers;
  NSMutableArray<id> *_windowObservers;
  id _tabShortcutMonitor;
  BOOL _destroyed;
  BOOL _contentLayoutObserved;
  BOOL _enforcingTrafficLightVisibility;
  BOOL _hasLastNotifiedContentLayout;
  BOOL _fullscreenTransitionActive;
  BOOL _fullscreenHostReady;
  RionRuntimeContentLayout _lastNotifiedContentLayout;
  CGFloat _stableTrafficLightReserveWidth;
}

- (nullable instancetype)initWithWindow:(NSWindow *)window
                       windowIdentifier:(NSString *)windowIdentifier
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler
                    contentLayoutHandler:
                        (RionRuntimeContentLayoutHandler)contentLayoutHandler {
  if (!window || windowIdentifier.length == 0 || !actionHandler ||
      !contentLayoutHandler) {
    return nil;
  }
  self = [super init];
  if (!self) return nil;

  _window = window;
  // The plus button exists before the first tab. Bind the controller to its
  // Game Window during construction so an empty host can still scope
  // openLauncher to the correct launch target.
  _windowID = [windowIdentifier copy];
  _hasPreviousCustomTitlebarHeight =
      [self readCustomTitlebarHeight:&_previousCustomTitlebarHeight
                       fromFrameView:window.contentView.superview];
  _hasStableTitlebarWidgetInset =
      [self readTitlebarWidgetInset:&_stableTitlebarWidgetInset
                      fromFrameView:window.contentView.superview];
  [self ensureTitlebarHeightOverride];
  _actionHandler = [actionHandler copy];
  _contentLayoutHandler = [contentLayoutHandler copy];
  _observedTrafficLightButtons = [NSMutableArray array];
  _originalTrafficLightStates = [NSMutableDictionary dictionary];
  _windowedTrafficLightFrames = [NSMutableDictionary dictionary];
  _tabItems = [NSMutableArray array];
  _tabItemsByIdentifier = [NSMutableDictionary dictionary];
  _tabIconCache = [NSMutableDictionary dictionary];
  _tabIconCacheKeys = [NSMutableDictionary dictionary];
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
  _fullscreenHostReady = _fullscreenTransitionActive;
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

  _tabScrollView = [[RionRuntimeHorizontalScrollView alloc] initWithFrame:NSZeroRect];
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
  _tabScrollView.contentView.postsBoundsChangedNotifications = YES;

  RionRuntimeVerticallyCenteredTextFieldCell *windowNameCell =
      [[RionRuntimeVerticallyCenteredTextFieldCell alloc] initTextCell:@""];
  windowNameCell.alignment = NSTextAlignmentLeft;
  windowNameCell.bezeled = NO;
  windowNameCell.bordered = NO;
  windowNameCell.drawsBackground = NO;
  windowNameCell.editable = NO;
  windowNameCell.selectable = NO;
  windowNameCell.usesSingleLineMode = YES;
  windowNameCell.lineBreakMode = NSLineBreakByTruncatingTail;
  _windowNameField = [[RionRuntimeWindowNameField alloc] initWithFrame:NSZeroRect];
  _windowNameField.cell = windowNameCell;
  _windowNameField.focusRingType = NSFocusRingTypeNone;
  _windowNameField.enabled = YES;
  _windowNameField.font = [NSFont systemFontOfSize:12.0 weight:NSFontWeightSemibold];
  _windowNameField.textColor = NSColor.labelColor;
  _windowNameField.hidden = YES;

  NSImage *scrollLeft = [NSImage imageWithSystemSymbolName:@"chevron.left"
                                  accessibilityDescription:nil];
  scrollLeft = [scrollLeft imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:9.0
                                                      weight:NSFontWeightSemibold]];
  _scrollLeftButton = [RionRuntimeAddButton buttonWithImage:scrollLeft
                                                     target:self
                                                     action:@selector(scrollTabsLeft:)];
  _scrollLeftButton.bordered = NO;
  _scrollLeftButton.imageScaling = NSImageScaleProportionallyDown;
  _scrollLeftButton.contentTintColor = NSColor.secondaryLabelColor;
  _scrollLeftSurface = [[RionRuntimeSurfaceView alloc]
      initWithContentView:_scrollLeftButton cornerRadius:7.0];
  _scrollLeftButton.surfaceView = _scrollLeftSurface;
  _scrollLeftSurface.hidden = YES;

  NSImage *scrollRight = [NSImage imageWithSystemSymbolName:@"chevron.right"
                                   accessibilityDescription:nil];
  scrollRight = [scrollRight imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:9.0
                                                      weight:NSFontWeightSemibold]];
  _scrollRightButton = [RionRuntimeAddButton buttonWithImage:scrollRight
                                                      target:self
                                                      action:@selector(scrollTabsRight:)];
  _scrollRightButton.bordered = NO;
  _scrollRightButton.imageScaling = NSImageScaleProportionallyDown;
  _scrollRightButton.contentTintColor = NSColor.secondaryLabelColor;
  _scrollRightSurface = [[RionRuntimeSurfaceView alloc]
      initWithContentView:_scrollRightButton cornerRadius:7.0];
  _scrollRightButton.surfaceView = _scrollRightSurface;
  _scrollRightSurface.hidden = YES;

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

  [_clusterContent addSubview:_scrollLeftSurface];
  [_clusterContent addSubview:_windowNameField];
  if (_clusterContainer != _clusterContent) {
    // NSGlassEffectContainerView promotes every descendant glass surface above
    // its content view. Keep scrolling tabs outside that hierarchy so the
    // NSClipView remains their final compositing boundary on macOS 26.
    [root addSubview:_tabScrollView
          positioned:NSWindowAbove
          relativeTo:_clusterContainer];
  } else {
    [_clusterContent addSubview:_tabScrollView];
  }
  [_clusterContent addSubview:_scrollRightSurface];
  [_clusterContent addSubview:_addSurface];

  __weak RionRuntimeTabsController *weakScrollSelf = self;
  id scrollObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:NSViewBoundsDidChangeNotification
                  object:_tabScrollView.contentView
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(__unused NSNotification *notification) {
                [weakScrollSelf updateTabScrollButtonState];
              }];
  [_windowObservers addObject:scrollObserver];

  _insertionIndicator = [[NSView alloc] initWithFrame:NSZeroRect];
  _insertionIndicator.wantsLayer = YES;
  _insertionIndicator.layer.backgroundColor = NSColor.controlAccentColor.CGColor;
  _insertionIndicator.layer.cornerRadius = 1.0;
  _insertionIndicator.hidden = YES;
  [root addSubview:_insertionIndicator];

  _accessoryController =
      [[RionRuntimeTitlebarAccessoryViewController alloc] init];
  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _accessoryController.fullScreenMinHeight = 0;
  _accessoryController.view = root;
  __weak RionRuntimeTabsController *weakSelf = self;
  _accessoryController.appearanceHandler = ^{
    [weakSelf scheduleFullscreenHostRefresh];
  };
  [self applyLiquidGlassTitlebarAppearance];
  [self configureAccessoryForTitlebar];
  [self attachAccessoryController];
  [self layoutTitlebarContent];
  [self captureWindowedTrafficLightFrames];
  [self installWindowObservers];
  __weak RionRuntimeTabsController *weakShortcutSelf = self;
  _tabShortcutMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:(NSEventMaskKeyDown |
                                             NSEventMaskFlagsChanged)
                                handler:^NSEvent *(NSEvent *event) {
    RionRuntimeTabsController *strongSelf = weakShortcutSelf;
    if (!strongSelf || strongSelf->_destroyed || event.window != strongSelf->_window) {
      return event;
    }
    if (event.type == NSEventTypeFlagsChanged) {
      [strongSelf handleTabShortcutModifierEvent:event];
      return event;
    }
    if (event.keyCode != 48) return event;
    NSEventModifierFlags flags = event.modifierFlags &
        NSEventModifierFlagDeviceIndependentFlagsMask;
    if ((flags & NSEventModifierFlagControl) == 0 ||
        (flags & (NSEventModifierFlagCommand | NSEventModifierFlagOption |
                  NSEventModifierFlagFunction)) != 0 ||
        strongSelf->_tabItems.count < 2) {
      return event;
    }
    NSUInteger activeIndex = [strongSelf->_tabItems indexOfObjectPassingTest:
        ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
      (void)index;
      if (item.activeTab) *stop = YES;
      return item.activeTab;
    }];
    if (activeIndex == NSNotFound) activeIndex = 0;
    BOOL previous = (flags & NSEventModifierFlagShift) != 0;
    NSUInteger count = strongSelf->_tabItems.count;
    NSUInteger targetIndex = previous ? (activeIndex + count - 1) % count
                                      : (activeIndex + 1) % count;
    [strongSelf beginTabShortcutModifierHandoff:flags];
    [strongSelf activateTab:strongSelf->_tabItems[targetIndex].tabIdentifier];
    return nil;
  }];
  // A controller can be created for a window that is already fullscreen
  // (for example after a display-host rebuild). Register that settled state
  // immediately instead of waiting for a future fullscreen notification.
  [self updateFullscreenToolbarPresentationPolicy];
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

NS_ASSUME_NONNULL_END
