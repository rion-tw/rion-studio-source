- (nullable NSString *)stableTabIdentifierBeforePoint:(NSPoint)point
                                               inView:(NSView *)view
                                 draggedTabIdentifier:(NSString *)tabIdentifier
                                            sessionID:(NSString *)sessionID
                                           grabRatioX:(CGFloat)grabRatioX
                                       sourceTabWidth:(CGFloat)sourceTabWidth {
  NSPoint canvasPoint = [_tabCanvas convertPoint:point fromView:view];
  RionRuntimeTabItemView *draggedItem = _tabItemsByIdentifier[tabIdentifier];
  CGFloat draggedWidth = draggedItem
      ? draggedItem.preferredWidth
      : sourceTabWidth;
  // Always use the source session's grab ratio. A tab item materialized in a
  // different window has never received mouseDown: and therefore cannot
  // reconstruct the original pointer-to-tab anchor.
  CGFloat draggedMinimumX = canvasPoint.x - grabRatioX * draggedWidth;
  CGFloat draggedMaximumX = draggedMinimumX + draggedWidth;
  CGFloat draggedCenterX = RionRuntimeTabInsertionProbeX(
      canvasPoint.x, draggedWidth, grabRatioX);
  NSMutableArray<RionRuntimeTabItemView *> *candidates = [NSMutableArray array];
  NSMutableArray<NSNumber *> *midpoints = [NSMutableArray array];
  NSMutableArray<NSNumber *> *widths = [NSMutableArray array];
  NSUInteger inferredIndex = NSNotFound;
  CGFloat layoutX = 0;
  for (RionRuntimeTabItemView *item in _tabItems) {
    CGFloat width = item.preferredWidth;
    if ([item.tabIdentifier isEqualToString:tabIdentifier]) {
      inferredIndex = candidates.count;
    } else {
      [candidates addObject:item];
      [midpoints addObject:@(layoutX + width / 2.0)];
      [widths addObject:@(width)];
    }
    layoutX += width + kRionTabSpacing;
  }
  if (candidates.count == 0) {
    _dragInsertionSessionIdentifier = [sessionID copy];
    _dragInsertionBeforeIdentifier = nil;
    _dragInsertionVisualCenterX = draggedCenterX;
    return nil;
  }

  NSUInteger rawIndex = candidates.count;
  for (NSUInteger index = 0; index < midpoints.count; ++index) {
    if (draggedCenterX < midpoints[index].doubleValue) {
      rawIndex = index;
      break;
    }
  }
  BOOL sameSession =
      [_dragInsertionSessionIdentifier isEqualToString:sessionID];
  NSUInteger currentIndex = rawIndex;
  if (sameSession) {
    if (_dragInsertionBeforeIdentifier.length == 0) {
      currentIndex = candidates.count;
    } else {
      NSUInteger rememberedIndex = [candidates indexOfObjectPassingTest:
          ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
        (void)index;
        BOOL matches = [item.tabIdentifier
            isEqualToString:self->_dragInsertionBeforeIdentifier];
        if (matches) *stop = YES;
        return matches;
      }];
      if (rememberedIndex != NSNotFound) currentIndex = rememberedIndex;
      else if (inferredIndex != NSNotFound) currentIndex = inferredIndex;
    }
  } else if (inferredIndex != NSNotFound) {
    currentIndex = inferredIndex;
  }

  CGFloat insertionProbeX = draggedCenterX;
  BOOL shouldResolveInsertion = YES;
  if (sameSession) {
    CGFloat delta = draggedCenterX - _dragInsertionVisualCenterX;
    // Moving right uses the trailing edge; moving left uses the leading edge.
    // The slot therefore changes when the tab frame crosses an adjacent tab's
    // midpoint, independent of where inside the tab the cursor was grabbed.
    insertionProbeX = RionRuntimeDirectionalInsertionProbeX(
        draggedMinimumX, draggedMaximumX, draggedCenterX, delta,
        &shouldResolveInsertion);
  }
  NSUInteger stableIndex = shouldResolveInsertion
      ? RionRuntimeStableInsertionIndex(insertionProbeX, midpoints, widths,
                                        currentIndex)
      : currentIndex;
  NSString *beforeIdentifier = stableIndex < candidates.count
      ? candidates[stableIndex].tabIdentifier
      : nil;
  _dragInsertionSessionIdentifier = [sessionID copy];
  _dragInsertionBeforeIdentifier = [beforeIdentifier copy];
  _dragInsertionVisualCenterX = draggedCenterX;
  return beforeIdentifier;
}

- (void)previewDragTabIdentifier:(NSString *)tabIdentifier
                beforeIdentifier:(nullable NSString *)beforeIdentifier {
  RionRuntimeTabItemView *draggedItem = _tabItemsByIdentifier[tabIdentifier];
  if (!draggedItem || _tabItems.count < 2) return;
  NSMutableArray<NSString *> *order =
      [NSMutableArray arrayWithCapacity:_tabItems.count];
  for (RionRuntimeTabItemView *item in _tabItems) {
    if (![item.tabIdentifier isEqualToString:tabIdentifier]) {
      [order addObject:item.tabIdentifier];
    }
  }
  NSUInteger insertionIndex = order.count;
  if (beforeIdentifier.length > 0) {
    NSUInteger candidate = [order indexOfObject:beforeIdentifier];
    if (candidate != NSNotFound) insertionIndex = candidate;
  }
  [order insertObject:tabIdentifier atIndex:insertionIndex];
  [self reorderTabIdentifiers:order];
}

- (void)positionDragSurfaceForTabIdentifier:(NSString *)tabIdentifier
                                    atPoint:(NSPoint)point
                                     inView:(NSView *)view
                                 grabRatioX:(CGFloat)grabRatioX {
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tabIdentifier];
  RionRuntimeSurfaceView *surface = item.surfaceView;
  if (!item || !surface) return;
  if (![_dragPlaceholderTabIdentifier isEqualToString:tabIdentifier]) {
    [self setDragPlaceholderIdentifier:tabIdentifier];
  }
  NSPoint canvasPoint = [_tabCanvas convertPoint:point fromView:view];
  _dragSurfaceCanvasX =
      canvasPoint.x - grabRatioX * item.preferredWidth;
  _dragSurfaceOverlayActive = YES;
  _dragSurfaceVisible = YES;
  surface.alphaValue = 1.0;
  surface.frame = NSMakeRect(_dragSurfaceCanvasX, 0, item.preferredWidth,
                             kRionTabHeight);
  [_tabCanvas addSubview:surface positioned:NSWindowAbove relativeTo:nil];
}

- (void)hideDragSurfaceForTabIdentifier:(NSString *)tabIdentifier {
  if (![_dragPlaceholderTabIdentifier isEqualToString:tabIdentifier]) return;
  _dragSurfaceVisible = NO;
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tabIdentifier];
  item.surfaceView.alphaValue = 0.0;
}

- (void)resetTabDragInsertionState {
  _dragInsertionSessionIdentifier = nil;
  _dragInsertionBeforeIdentifier = nil;
  _dragInsertionVisualCenterX = 0;
}

- (void)scrollTabStripForDragPoint:(NSPoint)point inView:(NSView *)view {
  if (_tabScrollView.bounds.size.width <= 0) return;
  NSPoint rootPoint = [_accessoryController.view convertPoint:point fromView:view];
  _dragScrollRootX = rootPoint.x;
  [self applyTabDragEdgeScroll];
}

- (void)applyTabDragEdgeScroll {
  if (_destroyed || _tabScrollView.bounds.size.width <= 0) {
    [self stopTabDragEdgeScroll];
    return;
  }
  NSRect frame = _tabScrollView.frame;
  CGFloat edgeWidth = MIN(36.0, frame.size.width / 4.0);
  CGFloat delta = RionRuntimeDragScrollDelta(
      _dragScrollRootX, NSMinX(frame), NSMaxX(frame), edgeWidth);
  if (delta == 0) {
    [self stopTabDragEdgeScroll];
    return;
  }
  NSClipView *clipView = _tabScrollView.contentView;
  CGFloat maximumOrigin =
      MAX(0, _tabCanvas.frame.size.width - clipView.bounds.size.width);
  CGFloat previousOriginX = clipView.bounds.origin.x;
  CGFloat originX = MIN(
      maximumOrigin,
      MAX(0, clipView.bounds.origin.x + delta));
  if (fabs(originX - previousOriginX) < 0.5) {
    [self stopTabDragEdgeScroll];
    return;
  }
  [clipView scrollToPoint:NSMakePoint(originX, 0)];
  [_tabScrollView reflectScrolledClipView:clipView];
  [self updateTabScrollButtonState];
  if (_dragScrollTimer) return;
  __weak RionRuntimeTabsController *weakSelf = self;
  _dragScrollTimer = [NSTimer timerWithTimeInterval:(1.0 / 60.0)
                                            repeats:YES
                                              block:^(__unused NSTimer *timer) {
    [weakSelf applyTabDragEdgeScroll];
  }];
  [NSRunLoop.mainRunLoop addTimer:_dragScrollTimer forMode:NSRunLoopCommonModes];
}

- (void)stopTabDragEdgeScroll {
  [_dragScrollTimer invalidate];
  _dragScrollTimer = nil;
}

- (void)setDragPlaceholderIdentifier:(nullable NSString *)identifier {
  if ((_dragPlaceholderTabIdentifier == identifier) ||
      [_dragPlaceholderTabIdentifier isEqualToString:identifier]) {
    [self updateDragPlaceholderAppearance];
    return;
  }
  RionRuntimeTabItemView *previousItem =
      _tabItemsByIdentifier[_dragPlaceholderTabIdentifier];
  previousItem.surfaceView.alphaValue = 1.0;
  _dragPlaceholderTabIdentifier = [identifier copy];
  _dragSurfaceOverlayActive = NO;
  _dragSurfaceVisible = NO;
  RionRuntimeTabItemView *nextItem = _tabItemsByIdentifier[identifier];
  if (nextItem.surfaceView) {
    _dragSurfaceCanvasX = NSMinX(nextItem.surfaceView.frame);
    _dragSurfaceOverlayActive = YES;
    _dragSurfaceVisible = YES;
  }
  if (identifier.length == 0) {
    [self layoutTitlebarContent];
  }
  [self updateDragPlaceholderAppearance];
}

- (void)updateDragPlaceholderAppearance {
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    BOOL placeholder = _dragPlaceholderTabIdentifier.length > 0 &&
        [_tabItems[index].tabIdentifier
            isEqualToString:_dragPlaceholderTabIdentifier];
    _tabSurfaces[index].alphaValue =
        placeholder && !_dragSurfaceVisible ? 0.0 : 1.0;
  }
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
                     sourceWindowID:(NSString *)sourceWindowID
                          sessionID:(NSString *)sessionID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier
                        screenPoint:(NSPoint)screenPoint {
  if (!_actionHandler || tabIdentifier.length == 0 || sessionID.length == 0) return;
  NSMutableDictionary<NSString *, id> *action = [@{
    @"type" : @"tabDragDrop",
    @"sessionId" : sessionID,
    @"tabId" : tabIdentifier,
    @"sourceWindowId" : sourceWindowID,
    @"windowId" : _windowID,
    @"screenX" : @(RionTopLeftScreenPoint(screenPoint).x),
    @"screenY" : @(RionTopLeftScreenPoint(screenPoint).y)
  } mutableCopy];
  if (beforeIdentifier.length > 0) action[@"beforeTabId"] = beforeIdentifier;
  _actionHandler(action);
}

- (void)handleHoverWithTabIdentifier:(NSString *)tabIdentifier
                      sourceWindowID:(NSString *)sourceWindowID
                           sessionID:(NSString *)sessionID
                    beforeIdentifier:(nullable NSString *)beforeIdentifier
                         screenPoint:(NSPoint)screenPoint {
  if (!_actionHandler || tabIdentifier.length == 0 || sessionID.length == 0) return;
  NSPoint point = RionTopLeftScreenPoint(screenPoint);
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tabIdentifier];
  NSMutableDictionary<NSString *, id> *action = [@{
    @"type" : @"tabDragHover",
    @"sessionId" : sessionID,
    @"tabId" : tabIdentifier,
    @"sourceWindowId" : sourceWindowID,
    @"windowId" : _windowID,
    @"screenX" : @(point.x),
    @"screenY" : @(point.y),
    @"tabWidth" : @(item ? item.preferredWidth : kRionTabMinimumWidth),
    @"tabHeight" : @(kRionTabHeight)
  } mutableCopy];
  if (beforeIdentifier.length > 0) action[@"beforeTabId"] = beforeIdentifier;
  _actionHandler(action);
}

- (void)moveTabDrag:(RionRuntimeTabItemView *)item
      atScreenPoint:(NSPoint)screenPoint {
  if (!_actionHandler || item.dragSessionID.length == 0) return;
  NSPoint point = RionTopLeftScreenPoint(screenPoint);
  _actionHandler(@{
    @"type" : @"tabDragMove",
    @"sessionId" : item.dragSessionID,
    @"sourceWindowId" : item.sourceWindowID,
    @"screenX" : @(point.x),
    @"screenY" : @(point.y)
  });
}

- (void)endTabDrag:(RionRuntimeTabItemView *)item
       screenPoint:(NSPoint)screenPoint
         cancelled:(BOOL)cancelled {
  if (!_actionHandler || item.dragSessionID.length == 0) return;
  NSPoint point = RionTopLeftScreenPoint(screenPoint);
  _actionHandler(@{
    @"type" : @"tabDragEnd",
    @"sessionId" : item.dragSessionID,
    @"sourceWindowId" : item.sourceWindowID,
    @"screenX" : @(point.x),
    @"screenY" : @(point.y),
    @"cancelled" : @(cancelled)
  });
  item.dragSessionID = @"";
  [self setDragPlaceholderIdentifier:nil];
  [self resetTabDragInsertionState];
  [self stopTabDragEdgeScroll];
}

- (BOOL)controlRowContainsTopLeftScreenPoint:(NSPoint)point {
  if (_destroyed || !_window || !_accessoryController.view.window) return NO;
  NSView *root = _accessoryController.view;
  NSRect windowRect = [root convertRect:root.bounds toView:nil];
  NSRect screenRect = [root.window convertRectToScreen:windowRect];
  NSPoint topLeft =
      RionTopLeftScreenPoint(NSMakePoint(NSMinX(screenRect), NSMaxY(screenRect)));
  NSRect topLeftRect = NSMakeRect(topLeft.x, topLeft.y,
                                 screenRect.size.width, screenRect.size.height);
  return RionRuntimePointInHalfOpenRect(point, topLeftRect);
}

- (BOOL)dragAnchorForTabIdentifier:(NSString *)tabIdentifier
                       grabRatioX:(CGFloat)grabRatioX
                       grabRatioY:(CGFloat)grabRatioY
                     windowOffset:(NSPoint *)windowOffset {
  if (_destroyed || !_window || !windowOffset || tabIdentifier.length == 0) return NO;
  RionRuntimeTabItemView *item = _tabItemsByIdentifier[tabIdentifier];
  if (!item || !item.window) return NO;
  NSUInteger index = [_tabItems indexOfObjectIdenticalTo:item];
  if (index == NSNotFound || index >= _tabSurfaces.count) return NO;
  RionRuntimeSurfaceView *surface = _tabSurfaces[index];
  NSRect tabWindowRect = [surface convertRect:surface.bounds toView:nil];
  NSRect tabScreenRect = [surface.window convertRectToScreen:tabWindowRect];
  NSRect windowScreenRect = _window.frame;
  NSPoint tabTopLeft = RionTopLeftScreenPoint(
      NSMakePoint(NSMinX(tabScreenRect), NSMaxY(tabScreenRect)));
  NSPoint windowTopLeft = RionTopLeftScreenPoint(
      NSMakePoint(NSMinX(windowScreenRect), NSMaxY(windowScreenRect)));
  CGFloat ratioX = MIN(1.0, MAX(0.0, grabRatioX));
  CGFloat ratioY = MIN(1.0, MAX(0.0, grabRatioY));
  *windowOffset = NSMakePoint(
      tabTopLeft.x - windowTopLeft.x + tabScreenRect.size.width * ratioX,
      tabTopLeft.y - windowTopLeft.y + tabScreenRect.size.height * ratioY);
  return YES;
}

- (void)ensureFullscreenPresentationOptionsHook {
  if (_destroyed || !_window) return;
  // The window host may replace its delegate while rebuilding the native window
  // frame during a fullscreen transition. The class bridge is idempotent, so
  // checking the current delegate at every policy boundary is safe.
  RionInstallFullscreenPresentationOptionsHook(_window);
}

- (void)updateFullscreenToolbarPresentationPolicy {
  if (_destroyed || !_window) {
    RionSetFullscreenToolbarPresentationRequest((__bridge const void *)self,
                                                NO, YES);
    return;
  }

  [self ensureFullscreenPresentationOptionsHook];
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  BOOL active = fullScreen;
  BOOL autoHide = !self.alwaysShowInFullScreen && !self.revealLocked;
  // Keep the marker armed while always-show is selected even in windowed mode:
  // AppKit can ask the delegate for fullscreen presentation options before it
  // emits NSWindowWillEnterFullScreenNotification. The marker is consulted
  // only by that fullscreen callback, so it has no windowed behavior.
  RionSetFullscreenPresentationPolicyMarker(
      _window, self.alwaysShowInFullScreen || self.revealLocked, !autoHide);
  RionSetFullscreenToolbarPresentationRequest((__bridge const void *)self,
                                              active, autoHide);
}

- (void)setAlwaysShowInFullScreen:(BOOL)alwaysShow {
  _alwaysShowInFullScreen = alwaysShow;
  [self updateFullscreenToolbarPresentationPolicy];
  [self applyFullScreenPolicy];
  if (alwaysShow && _window && _fullscreenHostReady) {
    [self scheduleFullscreenHostRefresh];
  }
}

- (void)prepareForFullscreenTransition:(BOOL)fullScreen {
  if (_destroyed || !_window) return;
  [self ensureTitlebarHeightOverride];

  if (fullScreen) {
    // AppKit snapshots the toolbar and titlebar accessory geometry while the
    // fullscreen transition is starting. Install the already-created empty
    // toolbar synchronously before the host calls -setFullScreen: so native
    // auto-hide owns one stable host for the entire transition.
    _fullscreenTransitionActive = YES;
    _fullscreenHostReady = NO;
    [self updateFullscreenToolbarPresentationPolicy];
    [self installPreparedToolbarForFullScreen];
    [self configureAccessoryForTitlebar];
    [self attachAccessoryController];
    [self applyLiquidGlassTitlebarAppearance];
    [self layoutTitlebarContent];
    _accessoryController.hidden = NO;
    _accessoryController.view.hidden = NO;
    _accessoryController.view.alphaValue = 1.0;

    // Snapshot the final single-row state before the window host begins the
    // transition. Always-show enters with the native host fully laid out and
    // visible; auto-hide keeps the same trailing accessory in AppKit's
    // top-edge reveal host without resizing the full-size content.
    _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    BOOL pinned = self.alwaysShowInFullScreen || self.revealLocked;
    _toolbar.visible = pinned;
    if (pinned) [self displayTitlebarHostIfNeeded];
    [self removeTrafficLightObservationRestoringState:NO];
    [self scheduleContentLayoutNotification];
    return;
  }

  // A normal fullscreen exit keeps the fullscreen toolbar installed until
  // DidExitFullScreen. If entry failed before AppKit changed the style mask,
  // restore the settled windowed host immediately.
  if ((_window.styleMask & NSWindowStyleMaskFullScreen) != 0) return;
  _fullscreenTransitionActive = NO;
  _fullscreenHostReady = NO;
  [self updateFullscreenToolbarPresentationPolicy];
  [self detachTitlebarWidgetInsetOverrides];
  [self restoreWindowedTitlebarHost];
  [self installFreshToolbarForWindowedMode];
  [self applyLiquidGlassTitlebarAppearance];
  [self applyFullScreenPolicy];
}

- (void)setRevealLocked:(BOOL)locked {
  _revealLocked = locked;
  [self updateFullscreenToolbarPresentationPolicy];
  [self applyFullScreenPolicy];
  if (_window && _fullscreenHostReady) {
    [self scheduleFullscreenHostRefresh];
  }
}

- (RionRuntimeContentLayout)contentLayout {
  RionRuntimeContentLayout emptyLayout = {0, 0, NO};
  if (_destroyed || !_window) return emptyLayout;

  NSView *contentView = _window.contentView;
  if (!contentView) return emptyLayout;
  [contentView.superview layoutSubtreeIfNeeded];
  [contentView layoutSubtreeIfNeeded];

  // contentLayoutRect is AppKit's authoritative unobscured content region in
  // window coordinates. Convert it into the contentView coordinates so
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

- (void)scheduleFullscreenHostRefresh {
  if (_destroyed || !_window || _pendingFullscreenHostRefresh) return;

  __weak RionRuntimeTabsController *weakSelf = self;
  dispatch_block_t refresh = dispatch_block_create(
      (dispatch_block_flags_t)0, ^{
        RionRuntimeTabsController *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf->_pendingFullscreenHostRefresh = nil;
        if (strongSelf->_destroyed || !strongSelf->_window ||
            !strongSelf->_fullscreenHostReady) {
          return;
        }

        // NSTitlebarAccessoryViewController owns fullscreen rehosting. Once
        // its view appears, refresh only the settled host; detaching here would
        // discard AppKit's clip view and recreate the blank-row failure.
        [strongSelf updateFullscreenToolbarPresentationPolicy];
        [strongSelf configureAccessoryForTitlebar];
        strongSelf->_accessoryController.hidden = NO;
        strongSelf->_accessoryController.view.hidden = NO;
        strongSelf->_accessoryController.view.alphaValue = 1.0;
        [strongSelf layoutTitlebarContent];
        [strongSelf displayTitlebarHostIfNeeded];
        [strongSelf synchronizeFullScreenTitlebarGeometry];

        if (strongSelf.alwaysShowInFullScreen) {
          [strongSelf removeTrafficLightObservationRestoringState:NO];
          [strongSelf refreshFullscreenTrafficLightVisibility];
        }
        [strongSelf scheduleContentLayoutNotification];
      });
  _pendingFullscreenHostRefresh = refresh;
  dispatch_async(dispatch_get_main_queue(), refresh);
}

- (void)applyFullScreenPolicy {
  if (_destroyed || !_window) return;
  [self ensureTitlebarHeightOverride];
  BOOL fullScreen = _fullscreenTransitionActive ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  [self updateFullscreenToolbarPresentationPolicy];
  BOOL shouldShow = !fullScreen || self.alwaysShowInFullScreen ||
      self.revealLocked;

  if (fullScreen) {
    if (_window.toolbar != _toolbar) _window.toolbar = _toolbar;
    [self attachAccessoryController];
    [self configureAccessoryForTitlebar];
    [self applyLiquidGlassTitlebarAppearance];
    [self layoutTitlebarContent];
    _accessoryController.hidden = NO;
    _accessoryController.view.hidden = NO;
    _accessoryController.view.alphaValue = 1.0;

    if (self.alwaysShowInFullScreen) {
      // Keep the root content full-size for both fullscreen policies.
      // BrowserManager follows AppKit's contentLayoutRect for the static-safe
      // child View area while this row remains visible.
      _window.styleMask |= NSWindowStyleMaskFullSizeContentView;
      [self revealToolbarAndOrderBelowAccessory];
      [self synchronizeFullScreenTitlebarGeometry];
      [self updateTrafficLightObservation];
      [self scheduleContentLayoutNotification];
      return;
    }

    // Auto-hide keeps the same trailing accessory in AppKit's native
    // top-edge reveal animation. Full-size content leaves the game viewport
    // unchanged while the single titlebar row overlays it.
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
