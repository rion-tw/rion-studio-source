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
- (BOOL)moveTabIdentifier:(NSString *)tabIdentifier
    byAccessibilityOffset:(NSInteger)offset;
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
                                 grabRatioX:(CGFloat)grabRatioX
                              sourceTabWidth:(CGFloat)sourceTabWidth;
- (void)positionAddSurfaceAfterVisibleDragTail;
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
- (NSView *)tabSurfaceOverlayHost;
- (void)beginTabShortcutModifierHandoff:(NSEventModifierFlags)flags;
- (void)finishTabShortcutModifierHandoffWithAction:(NSString *)actionType;
- (void)flushTabShortcutModifierHandoffWithAction:(NSString *)actionType;
- (void)handleTabShortcutModifierEvent:(NSEvent *)event;
- (void)notifyTabShortcutModifierHandoff:(NSString *)actionType;
- (CGFloat)dragPreviewScreenOriginY;
- (void)updateTabScrollButtonState;
- (void)updateTabEdgeFadeMasks;
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
  NSView *_contentHostView;
  NSRect _edgeEffectVisibleRect;
  CAShapeLayer *_edgeShapeMask;
  NSView *_effectView;
  BOOL _hasEdgeEffectVisibleRect;
  BOOL _hovered;
  BOOL _usesLiquidGlass;
  BOOL _windowActive;
}

- (instancetype)initWithContentView:(NSView *)contentView
                       cornerRadius:(CGFloat)cornerRadius {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;

  _contentView = contentView;
  // NSGlassEffectView owns the frame of its direct content view. Keep the tab
  // itself one level deeper so cropping the glass near a scroll arrow never
  // changes the tab's layout width (and therefore never reflows its title,
  // icon, or close button).
  _contentHostView = [[NSView alloc] initWithFrame:NSZeroRect];
  _contentHostView.clipsToBounds = YES;
  [_contentHostView addSubview:contentView];
  _cornerRadius = cornerRadius;
  self.wantsLayer = YES;

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    NSGlassEffectView *glass = [[NSGlassEffectView alloc] initWithFrame:NSZeroRect];
    glass.cornerRadius = cornerRadius;
    glass.style = NSGlassEffectViewStyleRegular;
    glass.contentView = _contentHostView;
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
    [material addSubview:_contentHostView];
    _effectView = material;
  }

  _effectView.clipsToBounds = YES;
  [self addSubview:_effectView];
  [self updateActive:NO hovered:NO windowActive:YES animate:NO];
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (void)setEdgeFadeMask:(nullable CAGradientLayer *)mask
       effectVisibleRect:(NSRect)effectVisibleRect {
  _contentView.wantsLayer = YES;
  // The content view remains inside AppKit's promoted glass hierarchy, so its
  // own layer mask fades tab labels and controls even though a mask on the
  // outer surface cannot shape NSGlassEffectView itself.
  _contentView.layer.mask = mask;
  NSRect boundedVisibleRect = NSIntersectionRect(self.bounds, effectVisibleRect);
  BOOL geometryChanged = !_hasEdgeEffectVisibleRect ||
      !NSEqualRects(_edgeEffectVisibleRect, boundedVisibleRect);
  _edgeEffectVisibleRect = boundedVisibleRect;
  _hasEdgeEffectVisibleRect = YES;
  if (geometryChanged) {
    self.needsLayout = YES;
    [self layoutSubtreeIfNeeded];
  }
}

- (void)layout {
  [super layout];
  NSRect visibleRect = _hasEdgeEffectVisibleRect
      ? NSIntersectionRect(self.bounds, _edgeEffectVisibleRect)
      : self.bounds;
  if (NSEqualRects(visibleRect, self.bounds)) {
    if (self.layer.mask == _edgeShapeMask) self.layer.mask = nil;
  } else {
    if (!_edgeShapeMask) {
      _edgeShapeMask = [CAShapeLayer layer];
      _edgeShapeMask.fillColor = NSColor.whiteColor.CGColor;
    }
    _edgeShapeMask.frame = self.bounds;
    CGFloat visibleCornerRadius = MIN(
        _cornerRadius,
        MAX(0, MIN(NSWidth(visibleRect), NSHeight(visibleRect)) / 2.0));
    CGPathRef visiblePath = CGPathCreateWithRoundedRect(
        NSRectToCGRect(visibleRect), visibleCornerRadius, visibleCornerRadius,
        nil);
    _edgeShapeMask.path = visiblePath;
    CGPathRelease(visiblePath);
    // The outer surface carries the active/hover fill and border. Shape it to
    // the same cropped geometry as the glass so it cannot square off the
    // fixed arrow's exposed outer corners during Liquid Glass merging.
    self.layer.mask = _edgeShapeMask;
  }
  // NSGlassEffectView is promoted outside the normal CALayer hierarchy, so a
  // layer mask cannot shape the glass. Give the promoted view the actual
  // visible geometry instead; its rounded edge then meets the fixed arrow.
  _effectView.frame = visibleRect;
  [_effectView layoutSubtreeIfNeeded];
  _contentHostView.frame = _effectView.bounds;
  _contentView.frame = NSMakeRect(-NSMinX(visibleRect), -NSMinY(visibleRect),
                                  NSWidth(self.bounds), NSHeight(self.bounds));
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
  NSView *_phaseAccessory;
  NSImageView *_phaseImageView;
  NSProgressIndicator *_phaseProgress;
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
  self.accessibilityElement = YES;
  self.accessibilityRole = NSAccessibilityRadioButtonRole;

  _iconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _iconView.imageAlignment = NSImageAlignCenter;
  _iconView.imageScaling = NSImageScaleProportionallyDown;
  _iconView.accessibilityElement = NO;
  _iconView.wantsLayer = YES;
  _iconView.layer.cornerRadius = 4.0;
  _iconView.layer.masksToBounds = YES;

  _audioView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _audioView.imageAlignment = NSImageAlignCenter;
  _audioView.imageScaling = NSImageScaleProportionallyDown;
  _audioView.accessibilityElement = NO;
  _audioView.contentTintColor = NSColor.secondaryLabelColor;
  _audioView.toolTip = @"";

  _phaseAccessory = [[NSView alloc] initWithFrame:NSZeroRect];
  _phaseAccessory.accessibilityElement = NO;
  _phaseImageView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _phaseImageView.imageAlignment = NSImageAlignCenter;
  _phaseImageView.imageScaling = NSImageScaleProportionallyDown;
  _phaseImageView.accessibilityElement = NO;
  _phaseProgress = [[NSProgressIndicator alloc] initWithFrame:NSZeroRect];
  _phaseProgress.style = NSProgressIndicatorStyleSpinning;
  _phaseProgress.controlSize = NSControlSizeSmall;
  _phaseProgress.displayedWhenStopped = NO;
  _phaseProgress.indeterminate = YES;
  _phaseProgress.accessibilityElement = NO;
  [_phaseAccessory addSubview:_phaseImageView];
  [_phaseAccessory addSubview:_phaseProgress];

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
  _titleField.accessibilityElement = NO;
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
  [self addSubview:_phaseAccessory];
  [self addSubview:_audioView];
  [self addSubview:_moreButton];
  return self;
}

- (BOOL)accessibilityPerformPress {
  return [NSApp sendAction:self.action to:self.target from:self];
}

- (BOOL)accessibilityPerformShowMenu {
  if (self.tabIdentifier.length == 0) return NO;
  [self.tabsController performSelector:@selector(showTabMenu:)
                             withObject:self.tabIdentifier];
  return YES;
}

- (BOOL)accessibilityPerformIncrement {
  return [self.tabsController moveTabIdentifier:self.tabIdentifier
                          byAccessibilityOffset:1];
}

- (BOOL)accessibilityPerformDecrement {
  return [self.tabsController moveTabIdentifier:self.tabIdentifier
                          byAccessibilityOffset:-1];
}

- (NSArray<NSAccessibilityActionName> *)accessibilityActionNames {
  NSMutableArray<NSAccessibilityActionName> *actions =
      [[super accessibilityActionNames] mutableCopy];
  if (!actions) actions = [NSMutableArray array];
  for (NSAccessibilityActionName action in @[
         NSAccessibilityShowMenuAction,
         NSAccessibilityIncrementAction,
         NSAccessibilityDecrementAction
       ]) {
    if (![actions containsObject:action]) [actions addObject:action];
  }
  return actions;
}

- (void)accessibilityPerformAction:(NSAccessibilityActionName)action {
  if ([action isEqualToString:NSAccessibilityShowMenuAction]) {
    [self accessibilityPerformShowMenu];
    return;
  }
  if ([action isEqualToString:NSAccessibilityIncrementAction]) {
    [self accessibilityPerformIncrement];
    return;
  }
  if ([action isEqualToString:NSAccessibilityDecrementAction]) {
    [self accessibilityPerformDecrement];
    return;
  }
  [super accessibilityPerformAction:action];
}

- (BOOL)accessibilityShowMenuCustomAction {
  return [self accessibilityPerformShowMenu];
}

- (BOOL)accessibilityIncrementCustomAction {
  return [self accessibilityPerformIncrement];
}

- (BOOL)accessibilityDecrementCustomAction {
  return [self accessibilityPerformDecrement];
}

- (nullable NSArray<NSAccessibilityCustomAction *> *)accessibilityCustomActions {
  if (self.tabIdentifier.length == 0) return @[];
  return @[
    [[NSAccessibilityCustomAction alloc]
        initWithName:NSAccessibilityActionDescription(
                         NSAccessibilityShowMenuAction)
              target:self
            selector:@selector(accessibilityShowMenuCustomAction)],
    [[NSAccessibilityCustomAction alloc]
        initWithName:NSAccessibilityActionDescription(
                         NSAccessibilityIncrementAction)
              target:self
            selector:@selector(accessibilityIncrementCustomAction)],
    [[NSAccessibilityCustomAction alloc]
        initWithName:NSAccessibilityActionDescription(
                         NSAccessibilityDecrementAction)
              target:self
            selector:@selector(accessibilityDecrementCustomAction)]
  ];
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
  NSString *phase = tab.phase.length > 0 ? tab.phase : @"ready";
  BOOL ready = [phase isEqualToString:@"ready"];
  BOOL progressing = [phase isEqualToString:@"activating"] ||
      [phase isEqualToString:@"attaching"] ||
      [phase isEqualToString:@"loading"];
  BOOL wasHidden = _phaseAccessory.hidden;
  _phaseAccessory.hidden = ready;
  _phaseImageView.hidden = ready || progressing;
  _phaseProgress.hidden = !progressing;
  if (progressing) {
    [_phaseProgress startAnimation:nil];
  } else {
    [_phaseProgress stopAnimation:nil];
  }
  if (!ready && !progressing) {
    NSString *symbol = [phase isEqualToString:@"dormant"]
        ? @"circle.dashed"
        : [phase isEqualToString:@"degraded"]
            ? @"exclamationmark.triangle.fill"
            : @"exclamationmark.circle.fill";
    NSColor *color = [phase isEqualToString:@"dormant"]
        ? NSColor.secondaryLabelColor
        : [phase isEqualToString:@"degraded"]
            ? NSColor.systemOrangeColor
            : NSColor.systemRedColor;
    NSImage *image = [NSImage imageWithSystemSymbolName:symbol
                               accessibilityDescription:nil];
    _phaseImageView.image = [image imageWithSymbolConfiguration:
        [NSImageSymbolConfiguration configurationWithPointSize:11.0
                                                         weight:NSFontWeightMedium]];
    _phaseImageView.contentTintColor = color;
  }
  if (!ready && wasHidden &&
      !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
    _phaseAccessory.alphaValue = 0.0;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.12;
      self->_phaseAccessory.animator.alphaValue = 1.0;
    } completionHandler:nil];
  } else {
    _phaseAccessory.alphaValue = ready ? 0.0 : 1.0;
  }
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
      ? self.toolTip
      : [NSString stringWithFormat:@"%@, %@", self.toolTip, audioLabel];
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
  if (!_phaseAccessory.hidden) {
    CGFloat phaseX = titleEnd - 12.0;
    _phaseAccessory.frame = NSMakeRect(
        phaseX, (kRionTabHeight - 12.0) / 2.0, 12.0, 12.0);
    _phaseImageView.frame = _phaseAccessory.bounds;
    _phaseProgress.frame = _phaseAccessory.bounds;
    titleEnd = phaseX - kRionTabAccessorySpacing;
  } else {
    _phaseAccessory.frame = NSZeroRect;
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
  (void)operation;
  [self clearDragPreviewYLock];
  _activeDraggingSession = nil;
  _lastDragMoveDispatchTime = 0;
  NSEvent *event = NSApp.currentEvent;
  BOOL cancelledWithEscape =
      event.type == NSEventTypeKeyDown && event.keyCode == 53;
  if (self.tabDropHandled) {
    self.tabDropHandled = NO;
    self.dragSessionID = @"";
    return;
  }
  self.tabDropHandled = NO;
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
