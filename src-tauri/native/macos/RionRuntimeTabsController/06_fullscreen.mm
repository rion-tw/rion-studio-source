NS_ASSUME_NONNULL_BEGIN

- (void)updateTabMetadata:(RionRuntimeTabModel *)tab
       hideTabCloseButton:(BOOL)hideTabCloseButton
                 addLabel:(NSString *)addLabel
               closeLabel:(NSString *)closeLabel
        audioPlayingLabel:(NSString *)audioPlayingLabel
           audioMutedLabel:(NSString *)audioMutedLabel
          scrollLeftLabel:(NSString *)scrollLeftLabel
         scrollRightLabel:(NSString *)scrollRightLabel {
  if (_destroyed || tab.identifier.length == 0) return;
  _addButton.toolTip = addLabel;
  _addButton.accessibilityLabel = addLabel;
  _scrollLeftButton.toolTip = scrollLeftLabel;
  _scrollLeftButton.accessibilityLabel = scrollLeftLabel;
  _scrollRightButton.toolTip = scrollRightLabel;
  _scrollRightButton.accessibilityLabel = scrollRightLabel;
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tab.identifier];
  if (!item) return;
  tab.active = item == _activeTabItem;
  [item configureWithTab:tab
                   image:[self imageForTab:tab]
      hideTabCloseButton:hideTabCloseButton
              closeLabel:closeLabel
       audioPlayingLabel:audioPlayingLabel
          audioMutedLabel:audioMutedLabel
             windowActive:_window.isKeyWindow];
  if (tab.active && [tab.phase isEqualToString:@"failed"] &&
      tab.statusIdentity.count > 0) {
    [self showFailureStatusForTab:tab];
  } else if (tab.active) {
    [self hideFailureStatus];
  }
}

- (void)showFailureStatusForTab:(RionRuntimeTabModel *)tab {
  if (_destroyed || !_window.contentView || tab.statusIdentity.count == 0) return;
  if (!_failureBackdrop) {
    _failureBackdrop = [[RionRuntimeFailureBackdropView alloc]
        initWithFrame:_window.contentView.bounds];
    _failureBackdrop.accessibilityElement = YES;
    _failureBackdrop.accessibilityRole = NSAccessibilityGroupRole;

    NSStackView *stack = [[NSStackView alloc] initWithFrame:NSZeroRect];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeCenterX;
    stack.spacing = 10.0;
    stack.translatesAutoresizingMaskIntoConstraints = NO;

    _failureImageView = [[NSImageView alloc] initWithFrame:NSZeroRect];
    NSImage *image = [NSImage imageWithSystemSymbolName:@"exclamationmark.circle.fill"
                               accessibilityDescription:nil];
    _failureImageView.image = [image imageWithSymbolConfiguration:
        [NSImageSymbolConfiguration configurationWithPointSize:32.0
                                                         weight:NSFontWeightRegular]];
    _failureImageView.contentTintColor = NSColor.systemRedColor;
    _failureImageView.accessibilityElement = NO;

    _failureTitleField = [NSTextField labelWithString:@""];
    _failureTitleField.font = [NSFont systemFontOfSize:17.0
                                               weight:NSFontWeightSemibold];
    _failureTitleField.alignment = NSTextAlignmentCenter;
    _failureTitleField.maximumNumberOfLines = 2;
    _failureTitleField.lineBreakMode = NSLineBreakByWordWrapping;

    _failureBodyField = [NSTextField wrappingLabelWithString:@""];
    _failureBodyField.textColor = NSColor.secondaryLabelColor;
    _failureBodyField.alignment = NSTextAlignmentCenter;
    _failureBodyField.maximumNumberOfLines = 3;

    _failureRetryButton = [NSButton buttonWithTitle:@""
                                             target:self
                                             action:@selector(retryFailedTab:)];
    _failureRetryButton.bezelStyle = NSBezelStyleRounded;
    _failureRetryButton.keyEquivalent = @"";

    [stack addArrangedSubview:_failureImageView];
    [stack addArrangedSubview:_failureTitleField];
    [stack addArrangedSubview:_failureBodyField];
    [stack setCustomSpacing:16.0 afterView:_failureBodyField];
    [stack addArrangedSubview:_failureRetryButton];
    [_failureBackdrop addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
      [stack.centerXAnchor constraintEqualToAnchor:_failureBackdrop.centerXAnchor],
      [stack.centerYAnchor constraintEqualToAnchor:_failureBackdrop.centerYAnchor],
      [stack.leadingAnchor constraintGreaterThanOrEqualToAnchor:_failureBackdrop.leadingAnchor
                                                       constant:24.0],
      [stack.trailingAnchor constraintLessThanOrEqualToAnchor:_failureBackdrop.trailingAnchor
                                                      constant:-24.0],
      [_failureTitleField.widthAnchor constraintLessThanOrEqualToConstant:480.0],
      [_failureBodyField.widthAnchor constraintLessThanOrEqualToConstant:440.0],
      [_failureImageView.widthAnchor constraintEqualToConstant:36.0],
      [_failureImageView.heightAnchor constraintEqualToConstant:36.0]
    ]];
    [_window.contentView addSubview:_failureBackdrop
                         positioned:NSWindowAbove
                         relativeTo:nil];
  }
  _failureStatusIdentity = [tab.statusIdentity copy];
  _failureTitleField.stringValue = tab.failureTitle ?: @"";
  _failureBodyField.stringValue = tab.failureBody ?: @"";
  _failureRetryButton.title = tab.retryLabel ?: @"";
  _failureRetryButton.accessibilityLabel = tab.retryLabel ?: @"";
  _failureBackdrop.accessibilityLabel = tab.failureTitle ?: @"";
  _failureBackdrop.frame = _window.contentView.bounds;
  _failureBackdrop.hidden = NO;
}

- (void)hideFailureStatus {
  _failureStatusIdentity = nil;
  _failureBackdrop.hidden = YES;
}

- (void)retryFailedTab:(id)sender {
  (void)sender;
  NSDictionary<NSString *, id> *identity = _failureStatusIdentity;
  NSString *tabIdentifier = identity[@"tabId"];
  [self hideFailureStatus];
  if (_actionHandler && identity.count > 0 && tabIdentifier.length > 0) {
    _actionHandler(@{ @"type" : @"retryFailed",
                      @"tabId" : tabIdentifier,
                      @"sourceWindowId" : _windowID,
                      @"statusIdentity" : identity });
  }
}

- (NSImage *)imageForTab:(RionRuntimeTabModel *)tab {
  NSString *symbol = [tab.type isEqualToString:@"workspace"]
                         ? [self symbolForWorkspaceTemplate:tab.workspaceTemplate]
                         : @"gamecontroller";
  NSString *cacheKey = tab.iconDataURL.length > 0
                           ? tab.iconDataURL
                           : [@"symbol:" stringByAppendingString:symbol];
  if ([_tabIconCacheKeys[tab.identifier] isEqualToString:cacheKey]) {
    NSImage *cached = _tabIconCache[tab.identifier];
    if (cached) return cached;
  }
  NSImage *resolvedImage = nil;
  if (tab.iconDataURL.length > 0) {
    NSRange comma = [tab.iconDataURL rangeOfString:@","];
    if (comma.location != NSNotFound) {
      NSString *encoded = [tab.iconDataURL substringFromIndex:comma.location + 1];
      NSData *data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
      NSImage *image = data ? [[NSImage alloc] initWithData:data] : nil;
      if (image) {
        image.size = NSMakeSize(16.0, 16.0);
        resolvedImage = image;
      }
    }
  }
  if (!resolvedImage) {
    NSImage *image = [NSImage imageWithSystemSymbolName:symbol
                              accessibilityDescription:nil];
    resolvedImage = [image imageWithSymbolConfiguration:
                     [NSImageSymbolConfiguration configurationWithPointSize:12.0
                                                                    weight:NSFontWeightMedium]];
    resolvedImage.size = NSMakeSize(16.0, 16.0);
  }
  if (resolvedImage) {
    _tabIconCache[tab.identifier] = resolvedImage;
    _tabIconCacheKeys[tab.identifier] = cacheKey;
  }
  return resolvedImage;
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
  [_scrollLeftSurface updateActive:NO hovered:NO windowActive:windowActive animate:YES];
  [_scrollRightSurface updateActive:NO hovered:NO windowActive:windowActive animate:YES];
}

- (void)scrollActiveTabIntoView {
  if (_tabScrollView.bounds.size.width <= 0) return;
  RionRuntimeTabItemView *activeItem = _activeTabItem;
  RionRuntimeSurfaceView *activeSurface = activeItem.surfaceView;
  if (!activeItem || !activeSurface) return;
  NSRect activeFrame = activeSurface.frame;
  NSRect visible = _tabScrollView.contentView.bounds;
  CGFloat edgeInset = _scrollLeftSurface.hidden ? 0 : kRionTabScrollFusionInset;
  CGFloat originX = RionRuntimeInsetRevealScrollOrigin(
      NSMinX(activeFrame), NSMaxX(activeFrame), visible.origin.x,
      visible.size.width, _tabCanvas.frame.size.width, edgeInset);
  if (fabs(originX - visible.origin.x) < 0.5) return;
  [_tabScrollView.contentView scrollToPoint:NSMakePoint(originX, 0)];
  [_tabScrollView reflectScrolledClipView:_tabScrollView.contentView];
}

- (void)updateTabScrollButtonState {
  if (_destroyed) return;
  NSClipView *clipView = _tabScrollView.contentView;
  CGFloat maximumOrigin =
      MAX(0, _tabCanvas.frame.size.width - clipView.bounds.size.width);
  BOOL overflowing =
      RionRuntimeTabsOverflow(_tabCanvas.frame.size.width,
                              clipView.bounds.size.width);
  _scrollLeftButton.enabled =
      overflowing && clipView.bounds.origin.x > 1.0;
  _scrollRightButton.enabled =
      overflowing && clipView.bounds.origin.x < maximumOrigin - 1.0;
  _scrollLeftButton.contentTintColor = _scrollLeftButton.enabled
      ? NSColor.secondaryLabelColor
      : NSColor.tertiaryLabelColor;
  _scrollRightButton.contentTintColor = _scrollRightButton.enabled
      ? NSColor.secondaryLabelColor
      : NSColor.tertiaryLabelColor;
  if (!overflowing && clipView.bounds.origin.x != 0) {
    [clipView scrollToPoint:NSMakePoint(0, 0)];
    [_tabScrollView reflectScrolledClipView:clipView];
  }
}

- (void)updateTabEdgeFadeMasks {
  if (_destroyed) return;
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    NSRect visible = _tabScrollView.contentView.bounds;
    CGFloat viewportWidth = visible.size.width;
    CGFloat edgeInset =
        _scrollLeftSurface.hidden ? 0 : kRionTabScrollFusionInset;
    CGFloat arrowCenterInset = kRionTabScrollButtonWidth / 2.0;
    CGFloat fadeInset = MAX(0, edgeInset - arrowCenterInset);
    CGFloat fadeViewportWidth = MAX(0, viewportWidth - 2.0 * arrowCenterInset);
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (RionRuntimeSurfaceView *surface in _tabSurfaces) {
      if (surface.superview != _tabCanvas || edgeInset <= 0 ||
          viewportWidth <= 0) {
        [surface setEdgeFadeMask:nil effectVisibleRect:surface.bounds];
        continue;
      }
      CGFloat surfaceWidth = NSWidth(surface.bounds);
      if (surfaceWidth <= 0) {
        [surface setEdgeFadeMask:nil effectVisibleRect:surface.bounds];
        continue;
      }
      CGFloat viewportMinimumX = NSMinX(surface.frame) - visible.origin.x;
      CGFloat viewportMaximumX = viewportMinimumX + surfaceWidth;
      if (viewportMinimumX >= edgeInset &&
          viewportMaximumX <= viewportWidth - edgeInset) {
        [surface setEdgeFadeMask:nil effectVisibleRect:surface.bounds];
        continue;
      }

      NSRect effectVisibleRect = RionRuntimeTabEdgeEffectVisibleRect(
          surfaceWidth, NSHeight(surface.bounds), viewportMinimumX,
          viewportWidth, arrowCenterInset);

      NSMutableArray<NSNumber *> *positions =
          [NSMutableArray arrayWithObjects:@0, @(surfaceWidth), nil];
      for (NSNumber *fractionValue in @[@0, @0.25, @0.5, @0.75, @1]) {
        CGFloat fadeOffset = fadeInset * fractionValue.doubleValue;
        for (NSNumber *boundary in @[
               @(arrowCenterInset + fadeOffset - viewportMinimumX),
               @(viewportWidth - arrowCenterInset - fadeOffset -
                 viewportMinimumX)
             ]) {
          CGFloat position = boundary.doubleValue;
          if (position > 0 && position < surfaceWidth) {
            [positions addObject:@(position)];
          }
        }
      }
      [positions sortUsingComparator:^NSComparisonResult(NSNumber *left,
                                                          NSNumber *right) {
        return [left compare:right];
      }];

      NSMutableArray *colors = [NSMutableArray arrayWithCapacity:positions.count];
      NSMutableArray<NSNumber *> *locations =
          [NSMutableArray arrayWithCapacity:positions.count];
      CGFloat previousPosition = -CGFLOAT_MAX;
      for (NSNumber *positionValue in positions) {
        CGFloat position = positionValue.doubleValue;
        if (fabs(position - previousPosition) < 0.01) continue;
        previousPosition = position;
        CGFloat alpha = RionRuntimeTabEdgeFadeAlpha(
            viewportMinimumX + position - arrowCenterInset,
            fadeViewportWidth, fadeInset);
        CGColorRef color =
            [NSColor colorWithCalibratedWhite:1.0 alpha:alpha].CGColor;
        [colors addObject:(__bridge id)color];
        [locations addObject:@(position / surfaceWidth)];
      }
      CAGradientLayer *mask = [CAGradientLayer layer];
      mask.frame = surface.bounds;
      mask.startPoint = CGPointMake(0, 0.5);
      mask.endPoint = CGPointMake(1, 0.5);
      mask.colors = colors;
      mask.locations = locations;
      [surface setEdgeFadeMask:mask effectVisibleRect:effectVisibleRect];
    }
    [CATransaction commit];
    return;
  }
#endif
  for (RionRuntimeSurfaceView *surface in _tabSurfaces) {
    [surface setEdgeFadeMask:nil effectVisibleRect:surface.bounds];
  }
}

- (void)scrollTabsLeft:(id)sender {
  (void)sender;
  NSRect visible = _tabScrollView.contentView.bounds;
  CGFloat edgeInset = _scrollLeftSurface.hidden ? 0 : kRionTabScrollFusionInset;
  CGFloat targetX = 0;
  for (NSView *surface in _tabSurfaces) {
    if (NSMinX(surface.frame) < NSMinX(visible) + edgeInset - 1.0) {
      targetX = NSMinX(surface.frame) - edgeInset;
    } else {
      break;
    }
  }
  [_tabScrollView.contentView scrollToPoint:NSMakePoint(targetX, 0)];
  [_tabScrollView reflectScrolledClipView:_tabScrollView.contentView];
  [self updateTabScrollButtonState];
}

- (void)scrollTabsRight:(id)sender {
  (void)sender;
  NSRect visible = _tabScrollView.contentView.bounds;
  CGFloat edgeInset = _scrollRightSurface.hidden ? 0 : kRionTabScrollFusionInset;
  CGFloat maximumOrigin =
      MAX(0, _tabCanvas.frame.size.width - visible.size.width);
  CGFloat targetX = maximumOrigin;
  for (NSView *surface in _tabSurfaces) {
    if (NSMaxX(surface.frame) > NSMaxX(visible) - edgeInset + 1.0) {
      targetX = NSMaxX(surface.frame) - visible.size.width + edgeInset;
      break;
    }
  }
  targetX = MIN(maximumOrigin, MAX(0, targetX));
  [_tabScrollView.contentView scrollToPoint:NSMakePoint(targetX, 0)];
  [_tabScrollView reflectScrolledClipView:_tabScrollView.contentView];
  [self updateTabScrollButtonState];
}

- (void)notifyTabShortcutModifierHandoff:(NSString *)actionType {
  if (!_actionHandler || actionType.length == 0) return;
  NSMutableDictionary<NSString *, id> *action = [@{
    @"type" : actionType,
    @"sourceWindowId" : _windowID ?: @""
  } mutableCopy];
  if (_tabShortcutOriginTabIdentifier.length > 0) {
    action[@"tabId"] = _tabShortcutOriginTabIdentifier;
  }
  _actionHandler(action);
}

- (void)beginTabShortcutModifierHandoff:(NSEventModifierFlags)flags {
  if (_tabShortcutPendingModifiers != 0) return;
  NSEventModifierFlags modifiers = flags &
      (NSEventModifierFlagControl | NSEventModifierFlagShift);
  if ((modifiers & NSEventModifierFlagControl) == 0) return;
  _tabShortcutOriginResponder = _window.firstResponder;
  _tabShortcutOriginTabIdentifier = [_activeTabItem.tabIdentifier copy];
  _tabShortcutPendingModifiers = modifiers;
  [self notifyTabShortcutModifierHandoff:@"modifierHandoffStarted"];
}

- (void)finishTabShortcutModifierHandoffWithAction:(NSString *)actionType {
  if (_tabShortcutPendingModifiers == 0 &&
      _tabShortcutOriginTabIdentifier.length == 0) {
    return;
  }
  [self notifyTabShortcutModifierHandoff:actionType];
  _tabShortcutPendingModifiers = 0;
  _tabShortcutOriginResponder = nil;
  _tabShortcutOriginTabIdentifier = nil;
}

- (void)handleTabShortcutModifierEvent:(NSEvent *)event {
  NSEventModifierFlags changed =
      RionRuntimeShortcutModifierFlagForKeyCode(event.keyCode);
  if (_tabShortcutPendingModifiers == 0 ||
      (_tabShortcutPendingModifiers & changed) == 0) {
    return;
  }
  RionRuntimeRelayShortcutModifierEvent(
      _tabShortcutOriginResponder, _window.firstResponder,
      _tabShortcutPendingModifiers, event);
  _tabShortcutPendingModifiers =
      RionRuntimePendingShortcutModifiersAfterEvent(
          _tabShortcutPendingModifiers, event);
  if (_tabShortcutPendingModifiers == 0) {
    [self finishTabShortcutModifierHandoffWithAction:
              @"modifierHandoffCompleted"];
  }
}

- (void)flushTabShortcutModifierHandoffWithAction:(NSString *)actionType {
  if (_tabShortcutPendingModifiers == 0) return;
  NSResponder *origin = _tabShortcutOriginResponder;
  if (origin) {
    NSEventModifierFlags preserved = NSEvent.modifierFlags &
        NSEventModifierFlagDeviceIndependentFlagsMask &
        ~(NSEventModifierFlagControl | NSEventModifierFlagShift);
    if ((_tabShortcutPendingModifiers & NSEventModifierFlagShift) != 0) {
      NSEventModifierFlags flags = preserved |
          (_tabShortcutPendingModifiers & NSEventModifierFlagControl);
      for (NSNumber *keyCode in @[ @56, @60 ]) {
        NSEvent *release = [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                                           location:NSZeroPoint
                                      modifierFlags:flags
                                          timestamp:NSProcessInfo.processInfo.systemUptime
                                       windowNumber:_window.windowNumber
                                            context:nil
                                         characters:@""
                        charactersIgnoringModifiers:@""
                                          isARepeat:NO
                                            keyCode:keyCode.unsignedShortValue];
        [origin flagsChanged:release];
      }
    }
    if ((_tabShortcutPendingModifiers & NSEventModifierFlagControl) != 0) {
      for (NSNumber *keyCode in @[ @59, @62 ]) {
        NSEvent *release = [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                                           location:NSZeroPoint
                                      modifierFlags:preserved
                                          timestamp:NSProcessInfo.processInfo.systemUptime
                                       windowNumber:_window.windowNumber
                                            context:nil
                                         characters:@""
                        charactersIgnoringModifiers:@""
                                          isARepeat:NO
                                            keyCode:keyCode.unsignedShortValue];
        [origin flagsChanged:release];
      }
    }
  }
  [self finishTabShortcutModifierHandoffWithAction:actionType];
}

- (void)tabPressed:(RionRuntimeTabItemView *)sender {
  [self activateTab:sender.tabIdentifier];
}

- (void)activateTab:(NSString *)tabIdentifier {
  if (_actionHandler && tabIdentifier.length > 0) {
    // Selection is a reversible UI/native-surface intent. Paint it before the
    // asynchronous core transaction so fast clicks and keyboard cycling never
    // leave the highlight one action behind.
    [self setActiveTabIdentifier:tabIdentifier];
    _actionHandler(@{ @"type" : @"activate", @"tabId" : tabIdentifier,
                      @"sourceWindowId" : _windowID });
  }
}

- (BOOL)performAccessibilityPressForTabIdentifier:(NSString *)tabIdentifier {
  if (_destroyed || tabIdentifier.length == 0) return NO;
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tabIdentifier];
  if (!item || item.hidden || item.window != _window) return NO;
  return [item accessibilityPerformPress];
}

- (void)setActiveTabIdentifier:(nullable NSString *)tabIdentifier {
  if (_destroyed) return;
  [self hideFailureStatus];
  RionRuntimeTabItemView *nextItem = tabIdentifier.length > 0
      ? _tabItemsByIdentifier[tabIdentifier]
      : nil;
  RionRuntimeTabItemView *previousItem = _activeTabItem;
  if (previousItem != nextItem) {
    if (previousItem) {
      previousItem.activeTab = NO;
      previousItem.accessibilityValue = @NO;
      [previousItem updateVisualStateAnimated:NO];
    }
    if (nextItem) {
      nextItem.activeTab = YES;
      nextItem.accessibilityValue = @YES;
      [nextItem updateVisualStateAnimated:NO];
    }
    _activeTabItem = nextItem;
  }
  [self scrollActiveTabIntoView];
}

- (void)ensureTabIdentifier:(NSString *)tabIdentifier
                       name:(NSString *)name
                       type:(NSString *)type
          workspaceTemplate:(nullable NSString *)workspaceTemplate
           windowIdentifier:(NSString *)windowIdentifier {
  if (_destroyed || tabIdentifier.length == 0) return;
  _windowID = windowIdentifier;
  NSUInteger existingIndex = [_tabItems indexOfObjectPassingTest:
      ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
    (void)index;
    if ([item.tabIdentifier isEqualToString:tabIdentifier]) *stop = YES;
    return [item.tabIdentifier isEqualToString:tabIdentifier];
  }];
  if (existingIndex == NSNotFound) {
    BOOL promotesExternalDragGhost =
        [_externalDragGhostTabIdentifier isEqualToString:tabIdentifier];
    BOOL hasCurrentDragPosition =
        [_dragSurfacePositionTabIdentifier isEqualToString:tabIdentifier];
    NSUInteger insertionIndex = _tabItems.count;
    CGFloat promotedCanvasX = _tabSurfaces.count > 0
        ? NSMaxX(_tabSurfaces.lastObject.frame) + kRionTabSpacing
        : 0;
    if (promotesExternalDragGhost &&
        _externalDragGhostBeforeIdentifier.length > 0) {
      NSUInteger candidate = [_tabItems indexOfObjectPassingTest:
          ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
        (void)index;
        BOOL matches = [item.tabIdentifier
            isEqualToString:self->_externalDragGhostBeforeIdentifier];
        if (matches) *stop = YES;
        return matches;
      }];
      if (candidate != NSNotFound) {
        insertionIndex = candidate;
        promotedCanvasX = NSMinX(_tabSurfaces[candidate].frame);
      }
    }
    if (promotesExternalDragGhost) {
      _externalDragGhostBeforeIdentifier = nil;
      _externalDragGhostTabIdentifier = nil;
      _externalDragGhostWidth = 0;
    }
    RionRuntimeTabModel *tab = [[RionRuntimeTabModel alloc] init];
    tab.active = NO;
    tab.audible = NO;
    tab.audioMuted = NO;
    tab.identifier = tabIdentifier;
    tab.name = name.length > 0 ? name : tabIdentifier;
    tab.phase = @"activating";
    tab.tooltip = tab.name;
    tab.type = type.length > 0 ? type : @"role";
    tab.workspaceTemplate = workspaceTemplate;
    RionRuntimeTabItemView *item =
        [[RionRuntimeTabItemView alloc] initWithFrame:NSZeroRect];
    item.tabsController = self;
    item.target = self;
    item.action = @selector(tabPressed:);
    item.sourceWindowID = _windowID;
    RionRuntimeSurfaceView *surface =
        [[RionRuntimeSurfaceView alloc] initWithContentView:item cornerRadius:14.0];
    item.surfaceView = surface;
    [item configureWithTab:tab
                     image:[self imageForTab:tab]
        hideTabCloseButton:NO
                closeLabel:@"Stop and close tab"
         audioPlayingLabel:@"Playing audio"
            audioMutedLabel:@"Tab muted"
               windowActive:_window.isKeyWindow];
    [_tabItems insertObject:item atIndex:insertionIndex];
    [_tabSurfaces insertObject:surface atIndex:insertionIndex];
    [_tabCanvas addSubview:surface];
    _tabItemsByIdentifier[tabIdentifier] = item;
    if (promotesExternalDragGhost) {
      _dragPlaceholderTabIdentifier = [tabIdentifier copy];
      if (!hasCurrentDragPosition) _dragSurfaceCanvasX = promotedCanvasX;
      _dragSurfaceOverlayActive = _tabItems.count >= 2;
      _dragSurfaceVisible = YES;
      surface.alphaValue = 1.0;
    }
  }
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tabIdentifier];
  item.sourceWindowID = _windowID;
  [self layoutTitlebarContent];
  [self updateDragPlaceholderAppearance];
}

- (void)reserveTabIdentifier:(NSString *)tabIdentifier
                        name:(NSString *)name
                        type:(NSString *)type
           workspaceTemplate:(nullable NSString *)workspaceTemplate
            windowIdentifier:(NSString *)windowIdentifier {
  [self ensureTabIdentifier:tabIdentifier
                       name:name
                       type:type
          workspaceTemplate:workspaceTemplate
           windowIdentifier:windowIdentifier];
  [self setActiveTabIdentifier:tabIdentifier];
}

- (void)removeTabIdentifier:(NSString *)tabIdentifier
         activeTabIdentifier:(nullable NSString *)activeTabIdentifier {
  if (_destroyed || tabIdentifier.length == 0) return;
  NSUInteger index = [_tabItems indexOfObjectPassingTest:
      ^BOOL(RionRuntimeTabItemView *item, NSUInteger candidate, BOOL *stop) {
    (void)candidate;
    if ([item.tabIdentifier isEqualToString:tabIdentifier]) *stop = YES;
    return [item.tabIdentifier isEqualToString:tabIdentifier];
  }];
  if (index != NSNotFound) {
    RionRuntimeTabItemView *removedItem = _tabItems[index];
    BOOL removedDragSurface = [_dragPlaceholderTabIdentifier
        isEqualToString:removedItem.tabIdentifier];
    if (_activeTabItem == removedItem) _activeTabItem = nil;
    [_tabSurfaces[index] removeFromSuperview];
    [_tabItems removeObjectAtIndex:index];
    [_tabSurfaces removeObjectAtIndex:index];
    [_tabIconCache removeObjectForKey:tabIdentifier];
    [_tabIconCacheKeys removeObjectForKey:tabIdentifier];
    [_tabItemsByIdentifier removeObjectForKey:tabIdentifier];
    if (removedDragSurface) {
      _dragPlaceholderTabIdentifier = nil;
      _dragSurfaceOverlayActive = NO;
      _dragSurfaceVisible = NO;
    }
  }
  [self setActiveTabIdentifier:activeTabIdentifier];
  [self layoutTitlebarContent];
  [self updateDragPlaceholderAppearance];
}

- (void)reorderTabIdentifiers:(NSArray<NSString *> *)tabIdentifiers {
  if (_destroyed || _tabItems.count < 2 || tabIdentifiers.count == 0) return;
  NSMutableArray<RionRuntimeTabItemView *> *orderedItems =
      [NSMutableArray arrayWithCapacity:_tabItems.count];
  NSMutableArray<RionRuntimeSurfaceView *> *orderedSurfaces =
      [NSMutableArray arrayWithCapacity:_tabSurfaces.count];
  NSMutableSet<NSString *> *retained = [NSMutableSet set];
  for (NSString *identifier in tabIdentifiers) {
    RionRuntimeTabItemView *item = _tabItemsByIdentifier[identifier];
    if (!item || [retained containsObject:identifier]) continue;
    NSUInteger index = [_tabItems indexOfObjectIdenticalTo:item];
    if (index == NSNotFound || index >= _tabSurfaces.count) continue;
    [retained addObject:identifier];
    [orderedItems addObject:item];
    [orderedSurfaces addObject:_tabSurfaces[index]];
  }
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    RionRuntimeTabItemView *item = _tabItems[index];
    if ([retained containsObject:item.tabIdentifier]) continue;
    [orderedItems addObject:item];
    [orderedSurfaces addObject:_tabSurfaces[index]];
  }
  if ([orderedItems isEqualToArray:_tabItems]) return;
  NSMutableDictionary<NSString *, NSValue *> *previousFrames =
      [NSMutableDictionary dictionaryWithCapacity:_tabItems.count];
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    RionRuntimeSurfaceView *surface = _tabSurfaces[index];
    CALayer *presentationLayer = (CALayer *)surface.layer.presentationLayer;
    NSRect visibleFrame = presentationLayer
        ? NSRectFromCGRect(presentationLayer.frame)
        : surface.frame;
    [surface.layer removeAllAnimations];
    surface.frame = visibleFrame;
    previousFrames[_tabItems[index].tabIdentifier] =
        [NSValue valueWithRect:visibleFrame];
  }
  [_tabItems setArray:orderedItems];
  [_tabSurfaces setArray:orderedSurfaces];
  [_addSurface.layer removeAllAnimations];
  [self layoutTitlebarContent];
  [self updateDragPlaceholderAppearance];
  if (NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return;
  NSRect targetAddFrame = _addSurface.frame;
  NSMutableArray<NSValue *> *targetFrames =
      [NSMutableArray arrayWithCapacity:_tabSurfaces.count];
  BOOL hasMovement = NO;
  for (NSUInteger index = 0; index < _tabSurfaces.count; ++index) {
    NSRect targetFrame = _tabSurfaces[index].frame;
    [targetFrames addObject:[NSValue valueWithRect:targetFrame]];
    NSValue *previous = previousFrames[_tabItems[index].tabIdentifier];
    BOOL lifted = [_dragPlaceholderTabIdentifier
        isEqualToString:_tabItems[index].tabIdentifier];
    if (!lifted && previous &&
        fabs(previous.rectValue.origin.x - targetFrame.origin.x) >= 0.5) {
      _tabSurfaces[index].frame = previous.rectValue;
      hasMovement = YES;
    }
  }
  BOOL animateAddSurface = NO;
  NSUInteger lastIndex = _tabItems.count - 1;
  RionRuntimeTabItemView *lastItem = _tabItems[lastIndex];
  NSValue *previousLastFrame = previousFrames[lastItem.tabIdentifier];
  NSRect targetLastFrame = targetFrames[lastIndex].rectValue;
  BOOL lastItemLifted = [_dragPlaceholderTabIdentifier
      isEqualToString:lastItem.tabIdentifier];
  BOOL followsLastTabPresentation = _scrollRightSurface.hidden &&
      !lastItemLifted && previousLastFrame &&
      fabs(previousLastFrame.rectValue.origin.x - targetLastFrame.origin.x) >=
          0.5;
  if (followsLastTabPresentation) {
    NSRect previousLastRootFrame = [_accessoryController.view
        convertRect:previousLastFrame.rectValue
          fromView:_tabCanvas];
    CGFloat addOriginX = RionRuntimeTrailingControlOriginX(
        targetAddFrame.origin.x, previousLastRootFrame, YES);
    _addSurface.frame = NSMakeRect(addOriginX, targetAddFrame.origin.y,
                                   targetAddFrame.size.width,
                                   targetAddFrame.size.height);
    animateAddSurface =
        fabs(addOriginX - targetAddFrame.origin.x) >= 0.5;
    hasMovement = hasMovement || animateAddSurface;
  }
  if (!hasMovement) return;
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
    context.duration = 0.12;
    for (NSUInteger index = 0; index < self->_tabSurfaces.count; ++index) {
      self->_tabSurfaces[index].animator.frame = targetFrames[index].rectValue;
    }
    if (animateAddSurface) {
      self->_addSurface.animator.frame = targetAddFrame;
    }
  } completionHandler:nil];
}

- (BOOL)moveTabIdentifier:(NSString *)tabIdentifier
    byAccessibilityOffset:(NSInteger)offset {
  if (tabIdentifier.length == 0 || offset == 0 || !_actionHandler) return NO;
  NSUInteger currentIndex = [_tabItems indexOfObjectPassingTest:
      ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
    (void)index;
    BOOL matches = [item.tabIdentifier isEqualToString:tabIdentifier];
    if (matches) *stop = YES;
    return matches;
  }];
  if (currentIndex == NSNotFound) return NO;
  NSInteger targetIndex = (NSInteger)currentIndex + offset;
  if (targetIndex < 0 || targetIndex >= (NSInteger)_tabItems.count) return NO;

  NSMutableArray<NSString *> *withoutTab =
      [NSMutableArray arrayWithCapacity:_tabItems.count - 1];
  for (RionRuntimeTabItemView *item in _tabItems) {
    if (![item.tabIdentifier isEqualToString:tabIdentifier]) {
      [withoutTab addObject:item.tabIdentifier];
    }
  }
  NSUInteger insertionIndex = MIN((NSUInteger)targetIndex, withoutTab.count);
  NSString *beforeIdentifier = insertionIndex < withoutTab.count
      ? withoutTab[insertionIndex]
      : nil;
  NSMutableArray<NSString *> *orderedTabIDs = [withoutTab mutableCopy];
  [orderedTabIDs insertObject:tabIdentifier atIndex:insertionIndex];
  [self reorderTabIdentifiers:orderedTabIDs];

  NSMutableDictionary<NSString *, id> *action = [@{
    @"type" : @"reorder",
    @"tabId" : tabIdentifier,
    @"sourceWindowId" : _windowID
  } mutableCopy];
  if (beforeIdentifier.length > 0) action[@"beforeTabId"] = beforeIdentifier;
  _actionHandler(action);
  return YES;
}

- (void)closeTab:(NSString *)tabIdentifier {
  if (_actionHandler && tabIdentifier.length > 0) {
    NSUInteger index = [_tabItems indexOfObjectPassingTest:
        ^BOOL(RionRuntimeTabItemView *item, NSUInteger candidateIndex,
              BOOL *stop) {
      (void)candidateIndex;
      if ([item.tabIdentifier isEqualToString:tabIdentifier]) *stop = YES;
      return [item.tabIdentifier isEqualToString:tabIdentifier];
    }];
    if (index != NSNotFound) {
      BOOL wasActive = _tabItems[index].activeTab;
      [_tabItemsByIdentifier removeObjectForKey:tabIdentifier];
      if (_activeTabItem == _tabItems[index]) _activeTabItem = nil;
      [_tabSurfaces[index] removeFromSuperview];
      [_tabItems removeObjectAtIndex:index];
      [_tabSurfaces removeObjectAtIndex:index];
      if (wasActive && _tabItems.count > 0) {
        NSUInteger successorIndex = MIN(index, _tabItems.count - 1);
        [self setActiveTabIdentifier:_tabItems[successorIndex].tabIdentifier];
      }
      [self layoutTitlebarContent];
    }
    NSMutableArray<NSString *> *orderedTabIDs = [NSMutableArray array];
    for (RionRuntimeTabItemView *item in _tabItems) {
      if (item.tabIdentifier.length > 0) {
        [orderedTabIDs addObject:item.tabIdentifier];
      }
    }
    _actionHandler(@{ @"type" : @"stop", @"tabId" : tabIdentifier,
                      @"sourceWindowId" : _windowID,
                      @"orderedTabIds" : orderedTabIDs });
  }
}

- (void)showTabMenu:(NSString *)tabIdentifier {
  if (_actionHandler && tabIdentifier.length > 0) {
    _actionHandler(@{ @"type" : @"openTabMenu", @"tabId" : tabIdentifier,
                      @"sourceWindowId" : _windowID });
  }
}

- (void)openLauncher:(id)sender {
  (void)sender;
  if (_actionHandler) {
    _actionHandler(@{ @"type" : @"openLauncher",
                      @"sourceWindowId" : _windowID });
  }
}

- (void)beginTabDrag:(RionRuntimeTabItemView *)item event:(NSEvent *)event {
  [self hideInsertionIndicator];
  [self hideExternalDragGhost];
  [self resetTabDragInsertionState];
  NSString *sessionID = NSUUID.UUID.UUIDString;
  item.dragSessionID = sessionID;
  item.tabDropHandled = NO;
  [self setActiveTabIdentifier:item.tabIdentifier];
  NSPoint screenPoint =
      RionTopLeftScreenPoint([item.window convertPointToScreen:event.locationInWindow]);
  NSPoint grabRatio = item.grabRatio;
  if (_actionHandler) {
    _actionHandler(@{
      @"type" : @"tabDragStart",
      @"sessionId" : sessionID,
      @"tabId" : item.tabIdentifier,
      @"sourceWindowId" : item.sourceWindowID,
      @"screenX" : @(screenPoint.x),
      @"screenY" : @(screenPoint.y),
      @"grabRatioX" : @(grabRatio.x),
      @"grabRatioY" : @(grabRatio.y),
      @"tabWidth" : @(item.bounds.size.width),
      @"tabHeight" : @(item.bounds.size.height)
    });
  }
  NSPasteboardItem *pasteboardItem = [[NSPasteboardItem alloc] init];
  [pasteboardItem
      setString:RionRuntimeTabDragPayload(item.sourceWindowID,
                                          item.tabIdentifier, sessionID,
                                          grabRatio, item.bounds.size)
        forType:RionRuntimeTabPasteboardType];
  NSDraggingItem *draggingItem =
      [[NSDraggingItem alloc] initWithPasteboardWriter:pasteboardItem];
  [draggingItem setDraggingFrame:item.bounds
                        contents:RionRuntimeTransparentDragImage()];
  NSDraggingSession *draggingSession =
      [item beginDraggingSessionWithItems:@[ draggingItem ] event:event source:item];
  draggingSession.draggingFormation = NSDraggingFormationNone;
  // The AppKit drag item is only an input carrier. The live tab strip/window has
  // already followed the pointer, so a failed-drop return animation would retain
  // the native dragging session after mouse-up and block an immediate next drag.
  draggingSession.animatesToStartingPositionsOnCancelOrFail = NO;
  [item beginDragPreviewSession:draggingSession
                 lockedScreenY:[self dragPreviewScreenOriginY]];
  [self setDragPlaceholderIdentifier:item.tabIdentifier];
}

- (CGFloat)dragPreviewScreenOriginY {
  if (_destroyed || !_tabScrollView.window) return NAN;
  NSRect windowRect =
      [_tabScrollView convertRect:_tabScrollView.bounds toView:nil];
  NSRect screenRect = [_tabScrollView.window convertRectToScreen:windowRect];
  return NSMinY(screenRect);
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

NS_ASSUME_NONNULL_END
