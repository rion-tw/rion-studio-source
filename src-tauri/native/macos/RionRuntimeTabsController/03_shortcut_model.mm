NS_ASSUME_NONNULL_BEGIN

- (void)captureWindowedTrafficLightFrames;
- (void)configureAccessoryForTitlebar;
- (void)detachAccessoryController;
- (void)displayTitlebarHostIfNeeded;
- (void)detachTitlebarHeightOverrideFromFrameView:(nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrideFromFrameView:
    (nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrides;
- (void)ensureTitlebarHeightOverride;
- (void)ensureFullScreenTitlebarWidgetInsetOverrides;
- (void)enforceTrafficLightVisibility;
- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                     sourceWindowID:(NSString *)sourceWindowID
                       sessionID:(NSString *)sessionID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier
                        screenPoint:(NSPoint)screenPoint;
- (void)handleHoverWithTabIdentifier:(NSString *)tabIdentifier
                      sourceWindowID:(NSString *)sourceWindowID
                           sessionID:(NSString *)sessionID
                    beforeIdentifier:(nullable NSString *)beforeIdentifier
                         screenPoint:(NSPoint)screenPoint;
- (void)moveTabDrag:(RionRuntimeTabItemView *)item atScreenPoint:(NSPoint)screenPoint;
- (void)endTabDrag:(RionRuntimeTabItemView *)item
       screenPoint:(NSPoint)screenPoint
         cancelled:(BOOL)cancelled;
- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view;
- (nullable NSString *)stableTabIdentifierBeforePoint:(NSPoint)point
                                               inView:(NSView *)view
                                 draggedTabIdentifier:(NSString *)tabIdentifier
                                            sessionID:(NSString *)sessionID
                                           grabRatioX:(CGFloat)grabRatioX
                                       sourceTabWidth:(CGFloat)sourceTabWidth;
- (BOOL)previewDragTabIdentifier:(NSString *)tabIdentifier
                beforeIdentifier:(nullable NSString *)beforeIdentifier;
- (void)positionDragSurfaceForTabIdentifier:(NSString *)tabIdentifier
                                    atPoint:(NSPoint)point
                                     inView:(NSView *)view
                                 grabRatioX:(CGFloat)grabRatioX;
- (void)resetTabDragInsertionState;
- (void)hideInsertionIndicator;
- (void)hideExternalDragGhost;
- (void)scrollTabStripForDragPoint:(NSPoint)point inView:(NSView *)view;
- (void)stopTabDragEdgeScroll;
- (void)applyTabDragEdgeScroll;
- (void)setDragPlaceholderIdentifier:(nullable NSString *)identifier;
- (void)updateDragPlaceholderAppearance;
- (void)scrollTabsLeft:(id)sender;
- (void)scrollTabsRight:(id)sender;
- (void)beginTabShortcutModifierHandoff:(NSEventModifierFlags)flags;
- (void)finishTabShortcutModifierHandoffWithAction:(NSString *)actionType;
- (void)flushTabShortcutModifierHandoffWithAction:(NSString *)actionType;
- (void)handleTabShortcutModifierEvent:(NSEvent *)event;
- (void)notifyTabShortcutModifierHandoff:(NSString *)actionType;
- (CGFloat)dragPreviewScreenOriginY;
- (void)updateTabScrollButtonState;
- (BOOL)controlRowContainsTopLeftScreenPoint:(NSPoint)point;
- (BOOL)dragAnchorForTabIdentifier:(NSString *)tabIdentifier
                       grabRatioX:(CGFloat)grabRatioX
                       grabRatioY:(CGFloat)grabRatioY
                     windowOffset:(NSPoint *)windowOffset;
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
- (void)refreshFullscreenTrafficLightVisibility;
- (void)restoreWindowedTitlebarHost;
- (void)scheduleContentLayoutNotification;
- (void)scheduleFullscreenHostRefresh;
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
- (void)ensureFullscreenPresentationOptionsHook;
- (void)updateFullscreenToolbarPresentationPolicy;
- (BOOL)updateTitlebarButtonPositionsForFrameView:(nullable NSView *)frameView;
- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier;
- (void)showExternalDragGhostForTabIdentifier:(NSString *)tabIdentifier
                             beforeIdentifier:(nullable NSString *)identifier
                                         width:(CGFloat)width;
- (nullable NSView *)toolbarHostView;

@end

static void *RionRuntimeTrafficLightObservationContext =
    &RionRuntimeTrafficLightObservationContext;
static void *RionRuntimeContentLayoutObservationContext =
    &RionRuntimeContentLayoutObservationContext;

static BOOL RionRuntimeUsesDarkAppearance(NSAppearance *appearance) {
  NSAppearanceName match = [appearance
      bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua,
                                           NSAppearanceNameDarkAqua ]];
  return [match isEqualToString:NSAppearanceNameDarkAqua];
}

static NSColor *RionRuntimeNeutralColor(BOOL darkAppearance,
                                        CGFloat lightAlpha,
                                        CGFloat darkAlpha) {
  return [NSColor colorWithCalibratedWhite:darkAppearance ? 1.0 : 0.0
                                     alpha:darkAppearance ? darkAlpha : lightAlpha];
}

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
  NSAppearance *appearance = self.effectiveAppearance;
  BOOL darkAppearance = RionRuntimeUsesDarkAppearance(appearance);
  BOOL increaseContrast =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldIncreaseContrast;
  BOOL reduceTransparency =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency;
  BOOL reduceMotion =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
  CGFloat activeFillAlpha = darkAppearance
                                ? (increaseContrast ? 0.12 : 0.075)
                                : (increaseContrast ? 0.075 : 0.045);
  CGFloat hoverFillAlpha = darkAppearance
                               ? (increaseContrast ? 0.065 : 0.045)
                               : (increaseContrast ? 0.045 : 0.025);
  CGFloat activeBorderAlpha = darkAppearance
                                  ? (increaseContrast ? 0.24 : 0.16)
                                  : (increaseContrast ? 0.18 : 0.12);
  CGFloat hoverBorderAlpha = darkAppearance
                                 ? (increaseContrast ? 0.16 : 0.11)
                                 : (increaseContrast ? 0.13 : 0.08);
  CGFloat visibility = _windowActive ? 1.0 : 0.65;
  CGFloat fillAlpha = _active
                          ? activeFillAlpha * visibility
                          : _hovered ? hoverFillAlpha * visibility : 0.0;
  CGFloat borderAlpha = _active
                            ? activeBorderAlpha * visibility
                            : _hovered ? hoverBorderAlpha * visibility : 0.0;
  NSColor *neutralTint = fillAlpha > 0
                             ? RionRuntimeNeutralColor(darkAppearance,
                                                       fillAlpha,
                                                       fillAlpha)
                             : nil;
  NSColor *surfaceFill = neutralTint ?: NSColor.clearColor;
  NSColor *borderColor = borderAlpha > 0
                             ? RionRuntimeNeutralColor(darkAppearance,
                                                       borderAlpha,
                                                       borderAlpha)
                             : NSColor.clearColor;

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    if (_usesLiquidGlass) {
      NSGlassEffectView *glass = (NSGlassEffectView *)_effectView;
      glass.tintColor = neutralTint;
      glass.alphaValue = _windowActive ? 1.0 : 0.82;
    }
  }
#endif
  if (!_usesLiquidGlass) {
    NSVisualEffectView *material = (NSVisualEffectView *)_effectView;
    material.material = reduceTransparency
                            ? NSVisualEffectMaterialWindowBackground
                            : NSVisualEffectMaterialTitlebar;
    material.emphasized = NO;
    material.alphaValue = _windowActive
                              ? (reduceTransparency || increaseContrast ? 1.0 : 0.96)
                              : 0.78;
    material.layer.backgroundColor = surfaceFill.CGColor;
  }

  void (^updates)(void) = ^{
    self.layer.cornerRadius = self->_cornerRadius;
    self.layer.backgroundColor = surfaceFill.CGColor;
    self.layer.borderWidth = self->_active
                                 ? (increaseContrast ? 0.85 : 0.65)
                                 : self->_hovered ? 0.5 : 0.0;
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
  __weak NSDraggingSession *_activeDraggingSession;
  BOOL _dragStarted;
  BOOL _dragPreviewYLocked;
  CGFloat _dragPreviewLockedScreenY;
  NSTimeInterval _lastDragMoveDispatchTime;
  BOOL _hideTabCloseButton;
  BOOL _hovered;
  NSImageView *_audioView;
  NSImageView *_iconView;
  NSButton *_moreButton;
  NSPoint _pointerDownInTab;
  NSPoint _pointerDownLocation;
  BOOL _pointerTracking;
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

  _audioView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _audioView.imageAlignment = NSImageAlignCenter;
  _audioView.imageScaling = NSImageScaleProportionallyDown;
  _audioView.contentTintColor = NSColor.secondaryLabelColor;
  _audioView.toolTip = @"";

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

  NSImage *closeImage = [NSImage imageWithSystemSymbolName:@"xmark"
                                   accessibilityDescription:nil];
  closeImage = [closeImage imageWithSymbolConfiguration:
                         [NSImageSymbolConfiguration configurationWithPointSize:11.0
                                                                        weight:NSFontWeightSemibold]];
  _moreButton = [NSButton buttonWithImage:closeImage
                                   target:self
                                   action:@selector(closePressed:)];
  _moreButton.bordered = NO;
  _moreButton.imageScaling = NSImageScaleProportionallyDown;
  _moreButton.contentTintColor = NSColor.secondaryLabelColor;

  [self addSubview:_iconView];
  [self addSubview:_titleField];
  [self addSubview:_audioView];
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
  return RionRuntimePreferredTabWidth(labelWidth, _hideTabCloseButton);
}

- (NSSize)intrinsicContentSize {
  return NSMakeSize(self.preferredWidth, kRionTabHeight);
}

- (void)configureWithTab:(RionRuntimeTabModel *)tab
                    image:(NSImage *)image
      hideTabCloseButton:(BOOL)hideTabCloseButton
               closeLabel:(NSString *)closeLabel
        audioPlayingLabel:(NSString *)audioPlayingLabel
           audioMutedLabel:(NSString *)audioMutedLabel
             windowActive:(BOOL)windowActive {
  _windowActive = windowActive;
  self.tabIdentifier = tab.identifier;
  self.activeTab = tab.active;
  _hideTabCloseButton = hideTabCloseButton;
  _iconView.image = image;
  _titleField.stringValue = tab.name;
  NSString *audioLabel = tab.audioMuted ? audioMutedLabel : audioPlayingLabel;
  NSString *audioSymbol = tab.audioMuted ? @"speaker.slash.fill" : @"speaker.wave.2.fill";
  NSImage *audioImage = [NSImage imageWithSystemSymbolName:audioSymbol
                                       accessibilityDescription:nil];
  _audioView.image = [audioImage imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:12.0
                                                       weight:NSFontWeightMedium]];
  _audioView.hidden = !tab.audioMuted && !tab.audible;
  _audioView.toolTip = _audioView.hidden ? @"" : audioLabel;
  _moreButton.identifier = tab.identifier;
  _moreButton.hidden = hideTabCloseButton;
  _moreButton.toolTip = hideTabCloseButton ? @"" : closeLabel;
  _moreButton.accessibilityLabel = hideTabCloseButton ? @"" : closeLabel;
  _moreButton.accessibilityElement = !hideTabCloseButton;
  self.toolTip = tab.tooltip.length > 0 ? tab.tooltip : tab.name;
  self.accessibilityLabel = _audioView.hidden
      ? tab.name
      : [NSString stringWithFormat:@"%@, %@", tab.name, audioLabel];
  self.accessibilityValue = @(tab.active);

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

  CGFloat trailingX = width - kRionTabTrailingPadding;
  CGFloat audioX = 0;
  if (_hideTabCloseButton) {
    _moreButton.frame = NSZeroRect;
    audioX = trailingX - kRionTabAudioIconSize;
  } else {
    CGFloat moreX = MAX(x, trailingX - kRionTabMoreButtonWidth);
    _moreButton.frame =
        NSMakeRect(moreX, 0, kRionTabMoreButtonWidth, kRionTabHeight);
    audioX = moreX - kRionTabAccessorySpacing - kRionTabAudioIconSize;
  }
  _audioView.frame =
      NSMakeRect(audioX, (kRionTabHeight - kRionTabAudioIconSize) / 2.0,
                 kRionTabAudioIconSize, kRionTabAudioIconSize);
  CGFloat titleEnd = audioX - kRionTabAccessorySpacing;
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
  CGFloat moreAlpha = _hideTabCloseButton
                          ? 0.0
                          : self.activeTab ? 0.46 : _hovered ? 0.76 : 0.0;
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

- (nullable NSView *)hitTest:(NSPoint)point {
  NSView *hit = [super hitTest:point];
  if (hit == _moreButton && !_hideTabCloseButton &&
      _moreButton.alphaValue > 0.05) return hit;
  return hit ? self : nil;
}

- (void)mouseDown:(NSEvent *)event {
  _pointerDownLocation = event.locationInWindow;
  _pointerDownInTab = [self convertPoint:event.locationInWindow fromView:nil];
  _pointerTracking = YES;
  _dragStarted = NO;
}

- (void)mouseDragged:(NSEvent *)event {
  if (!_pointerTracking || _dragStarted) return;
  NSPoint current = event.locationInWindow;
  if (std::hypot(current.x - _pointerDownLocation.x,
                 current.y - _pointerDownLocation.y) >= 3.0) {
    _dragStarted = YES;
    [self.tabsController beginTabDrag:self event:event];
  }
}

- (void)mouseUp:(NSEvent *)event {
  (void)event;
  BOOL shouldActivate = _pointerTracking && !_dragStarted;
  _pointerTracking = NO;
  _dragStarted = NO;
  if (shouldActivate) [NSApp sendAction:self.action to:self.target from:self];
}

- (void)rightMouseDown:(NSEvent *)event {
  (void)event;
  [self.tabsController performSelector:@selector(showTabMenu:)
                             withObject:self.tabIdentifier];
}

- (void)closePressed:(id)sender {
  (void)sender;
  [self.tabsController performSelector:@selector(closeTab:)
                             withObject:self.tabIdentifier];
}

- (void)applyDragPreviewYLock {
  if (!_dragPreviewYLocked || !_activeDraggingSession) return;
  CGFloat lockedScreenY = _dragPreviewLockedScreenY;
  [_activeDraggingSession
      enumerateDraggingItemsWithOptions:0
                                forView:nil
                                classes:@[ NSPasteboardItem.class ]
                          searchOptions:@{}
                             usingBlock:^(NSDraggingItem *draggingItem,
                                          NSInteger index, BOOL *stop) {
    (void)index;
    (void)stop;
    draggingItem.draggingFrame = RionRuntimeDragFrameWithLockedY(
        draggingItem.draggingFrame, lockedScreenY);
  }];
}

- (void)beginDragPreviewSession:(NSDraggingSession *)session
                  lockedScreenY:(CGFloat)screenY {
  _activeDraggingSession = session;
  _lastDragMoveDispatchTime = 0;
  [self lockDragPreviewToScreenY:screenY];
}

- (void)lockDragPreviewToScreenY:(CGFloat)screenY {
  if (!std::isfinite(screenY)) return;
  _dragPreviewYLocked = YES;
  _dragPreviewLockedScreenY = screenY;
  [self applyDragPreviewYLock];
}

- (void)clearDragPreviewYLock {
  _dragPreviewYLocked = NO;
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

- (void)draggingSession:(NSDraggingSession *)session
          movedToPoint:(NSPoint)screenPoint {
  _activeDraggingSession = session;
  [self applyDragPreviewYLock];
  NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  if (_lastDragMoveDispatchTime > 0 &&
      now - _lastDragMoveDispatchTime < (1.0 / 120.0)) {
    return;
  }
  _lastDragMoveDispatchTime = now;
  if (self.dragSessionID.length > 0) {
    [self.tabsController moveTabDrag:self atScreenPoint:screenPoint];
  }
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation {
  (void)session;
  [self clearDragPreviewYLock];
  _activeDraggingSession = nil;
  _lastDragMoveDispatchTime = 0;
  NSEvent *event = NSApp.currentEvent;
  BOOL cancelledWithEscape =
      event.type == NSEventTypeKeyDown && event.keyCode == 53;
  if (operation != NSDragOperationNone) {
    self.dragSessionID = @"";
    return;
  }
  [self.tabsController endTabDrag:self
                      screenPoint:screenPoint
                        cancelled:cancelledWithEscape];
}

- (NSPoint)grabRatio {
  CGFloat width = MAX(1.0, self.bounds.size.width);
  CGFloat height = MAX(1.0, self.bounds.size.height);
  return NSMakePoint(MIN(1.0, MAX(0.0, _pointerDownInTab.x / width)),
                     MIN(1.0, MAX(0.0, _pointerDownInTab.y / height)));
}

NS_ASSUME_NONNULL_END
