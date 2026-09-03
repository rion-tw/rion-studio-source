NS_ASSUME_NONNULL_BEGIN

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
    RionRevealViewHierarchyInHost(button, button.window);
  }
  _enforcingTrafficLightVisibility = NO;
}

- (void)refreshFullscreenTrafficLightVisibility {
  if (_destroyed || !_window || !self.alwaysShowInFullScreen ||
      !_fullscreenHostReady) {
    return;
  }

  // Rebind before changing visibility so the original AppKit state is still
  // captured for the later auto-hide/fullscreen-exit restore pass.
  [self updateTrafficLightObservation];

  // Keep this explicit in addition to KVO enforcement. AppKit can install a
  // fresh set of standard buttons while moving the titlebar into its
  // fullscreen host, so the controls must be made visible immediately after
  // that replacement rather than waiting for a property-change notification.
  for (NSNumber *buttonType in @[
         @(NSWindowCloseButton),
         @(NSWindowMiniaturizeButton),
         @(NSWindowZoomButton)
       ]) {
    NSButton *button =
        [_window standardWindowButton:(NSWindowButton)buttonType.integerValue];
    if (!button) continue;
    button.hidden = NO;
    button.alphaValue = 1.0;
    RionRevealViewHierarchyInHost(button, button.window);
    button.needsDisplay = YES;
    button.superview.needsLayout = YES;
    button.superview.needsDisplay = YES;
  }
  [self enforceTrafficLightVisibility];
  NSButton *closeButton = [_window standardWindowButton:NSWindowCloseButton];
  [closeButton.superview layoutSubtreeIfNeeded];
  [closeButton.superview displayIfNeeded];
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

- (void)observeValueForKeyPath:(nullable NSString *)keyPath
                      ofObject:(nullable id)object
                        change:(nullable NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(nullable void *)context {
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

- (nullable NSEvent *)routeWorkspaceDividerEvent:(NSEvent *)event {
  if (_destroyed || !_window || event.window != _window ||
      !_workspaceDividerOverlay || _workspaceDividerOverlay.hidden) {
    return event;
  }
  if (event.type == NSEventTypeLeftMouseDown) {
    if (_activeWorkspaceDivider) {
      [_activeWorkspaceDivider cancelActiveGesture];
      _activeWorkspaceDivider = nil;
    }
    NSPoint point = [_workspaceDividerOverlay
        convertPoint:event.locationInWindow
           fromView:nil];
    for (RionRuntimeWorkspaceDividerView *divider in
             _workspaceDividerViews.allValues.reverseObjectEnumerator) {
      if (!divider.hidden && NSPointInRect(point, divider.frame)) {
        _activeWorkspaceDivider = divider;
        [divider mouseDown:event];
        return nil;
      }
    }
    return event;
  }
  RionRuntimeWorkspaceDividerView *active = _activeWorkspaceDivider;
  if (!active) return event;
  if (event.type == NSEventTypeLeftMouseDragged) {
    [active mouseDragged:event];
    return nil;
  }
  if (event.type == NSEventTypeLeftMouseUp) {
    [active mouseUp:event];
    _activeWorkspaceDivider = nil;
    return nil;
  }
  return event;
}

- (void)installWorkspaceDividerEventMonitorIfNeeded {
  if (_workspaceDividerEventMonitor || _destroyed) return;
  __weak RionRuntimeTabsController *weakSelf = self;
  _workspaceDividerEventMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:
          NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged |
          NSEventMaskLeftMouseUp
                               handler:^NSEvent * _Nullable(NSEvent *event) {
    RionRuntimeTabsController *strongSelf = weakSelf;
    return strongSelf ? [strongSelf routeWorkspaceDividerEvent:event] : event;
  }];
}

- (void)removeWorkspaceDividerEventMonitor {
  if (_workspaceDividerEventMonitor) {
    [NSEvent removeMonitor:_workspaceDividerEventMonitor];
    _workspaceDividerEventMonitor = nil;
  }
  if (_activeWorkspaceDivider) {
    [_activeWorkspaceDivider cancelActiveGesture];
    _activeWorkspaceDivider = nil;
  }
}

- (BOOL)applyWorkspaceDividerProjection:
    (NSDictionary<NSString *, id> *)rawProjection {
  if (_destroyed || !_window || !_window.contentView || !_actionHandler) return NO;
  NSDictionary<NSString *, id> *projection =
      RionRuntimeValidatedWorkspaceDividerProjection(rawProjection);
  if (!projection) return NO;
  NSDictionary<NSString *, NSNumber *> *contentBounds =
      projection[@"contentBounds"];
  NSArray<NSDictionary<NSString *, id> *> *dividers = projection[@"dividers"];
  NSRect overlayFrame = NSMakeRect(
      contentBounds[@"x"].doubleValue,
      contentBounds[@"y"].doubleValue,
      contentBounds[@"width"].doubleValue,
      contentBounds[@"height"].doubleValue);
  if (!_workspaceDividerOverlay) {
    _workspaceDividerOverlay =
        [[RionRuntimeWorkspaceDividerOverlayView alloc] initWithFrame:overlayFrame];
    _workspaceDividerOverlay.autoresizingMask = NSViewNotSizable;
  }
  _workspaceDividerOverlay.frame = overlayFrame;
  _workspaceDividerOverlay.hidden = dividers.count == 0;
  if (dividers.count > 0) {
    [self installWorkspaceDividerEventMonitorIfNeeded];
  } else {
    [self removeWorkspaceDividerEventMonitor];
  }
  NSView *contentView = _window.contentView;
  if (_workspaceDividerOverlay.superview != contentView) {
    [_workspaceDividerOverlay removeFromSuperview];
    [contentView addSubview:_workspaceDividerOverlay
                 positioned:NSWindowAbove
                 relativeTo:nil];
  } else {
    [contentView addSubview:_workspaceDividerOverlay
                 positioned:NSWindowAbove
                 relativeTo:nil];
  }

  NSMutableSet<NSString *> *nextKeys = [NSMutableSet set];
  NSMutableArray<RionRuntimeWorkspaceDividerView *> *accessibilityDividers =
      [NSMutableArray array];
  __weak RionRuntimeTabsController *weakSelf = self;
  for (NSDictionary<NSString *, id> *dividerProjection in dividers) {
    NSString *key =
        RionRuntimeWorkspaceDividerProjectionKey(dividerProjection);
    [nextKeys addObject:key];
    RionRuntimeWorkspaceDividerView *divider = _workspaceDividerViews[key];
    if (!divider) {
      divider = [[RionRuntimeWorkspaceDividerView alloc]
          initWithProjectionKey:key
                       windowID:_windowID
                   actionHandler:^(NSDictionary<NSString *, id> *action) {
                     RionRuntimeTabsController *strongSelf = weakSelf;
                     if (!strongSelf || strongSelf->_destroyed ||
                         !strongSelf->_actionHandler) {
                       return;
                     }
                     strongSelf->_actionHandler(action);
                   }];
      _workspaceDividerViews[key] = divider;
      [_workspaceDividerOverlay addSubview:divider];
    }
    NSDictionary<NSString *, NSNumber *> *bounds = dividerProjection[@"bounds"];
    NSRect localFrame = NSMakeRect(
        bounds[@"x"].doubleValue - NSMinX(overlayFrame),
        bounds[@"y"].doubleValue - NSMinY(overlayFrame),
        bounds[@"width"].doubleValue,
        bounds[@"height"].doubleValue);
    [divider applyProjection:dividerProjection localFrame:localFrame];
    if (!divider.hidden) [accessibilityDividers addObject:divider];
  }
  for (NSString *staleKey in _workspaceDividerViews.allKeys.copy) {
    if ([nextKeys containsObject:staleKey]) continue;
    RionRuntimeWorkspaceDividerView *stale = _workspaceDividerViews[staleKey];
    if (_activeWorkspaceDivider == stale) _activeWorkspaceDivider = nil;
    [stale cancelActiveGesture];
    stale.workspaceDividerAccessibilityParent = nil;
    [stale removeFromSuperview];
    [_workspaceDividerViews removeObjectForKey:staleKey];
  }
  RionRuntimeTabsRootView *root =
      [_accessoryController.view isKindOfClass:RionRuntimeTabsRootView.class]
      ? (RionRuntimeTabsRootView *)_accessoryController.view
      : nil;
  for (RionRuntimeWorkspaceDividerView *divider in accessibilityDividers) {
    divider.workspaceDividerAccessibilityParent = root;
  }
  root.workspaceDividerAccessibilityChildren = accessibilityDividers;
  if (root) {
    NSAccessibilityPostNotification(
        root, NSAccessibilityLayoutChangedNotification);
  }
  _workspaceDividerProjection = projection;
  return [self matchesWorkspaceDividerProjection:projection];
}

- (BOOL)matchesWorkspaceDividerProjection:
    (NSDictionary<NSString *, id> *)rawProjection {
  NSDictionary<NSString *, id> *projection =
      RionRuntimeValidatedWorkspaceDividerProjection(rawProjection);
  if (!projection || ![_workspaceDividerProjection isEqualToDictionary:projection]) {
    return NO;
  }
  NSDictionary<NSString *, NSNumber *> *contentBounds =
      projection[@"contentBounds"];
  NSArray<NSDictionary<NSString *, id> *> *dividers = projection[@"dividers"];
  NSRect expectedOverlayFrame = NSMakeRect(
      contentBounds[@"x"].doubleValue,
      contentBounds[@"y"].doubleValue,
      contentBounds[@"width"].doubleValue,
      contentBounds[@"height"].doubleValue);
  if (!_workspaceDividerOverlay ||
      !_window.contentView ||
      _workspaceDividerOverlay.superview != _window.contentView ||
      !NSEqualRects(_workspaceDividerOverlay.frame, expectedOverlayFrame) ||
      _workspaceDividerOverlay.hidden != (dividers.count == 0) ||
      _workspaceDividerViews.count != dividers.count) {
    return NO;
  }
  for (NSDictionary<NSString *, id> *dividerProjection in dividers) {
    NSString *key =
        RionRuntimeWorkspaceDividerProjectionKey(dividerProjection);
    RionRuntimeWorkspaceDividerView *divider = _workspaceDividerViews[key];
    NSDictionary<NSString *, NSNumber *> *bounds = dividerProjection[@"bounds"];
    NSRect expected = NSMakeRect(
        bounds[@"x"].doubleValue - NSMinX(expectedOverlayFrame),
        bounds[@"y"].doubleValue - NSMinY(expectedOverlayFrame),
        bounds[@"width"].doubleValue,
        bounds[@"height"].doubleValue);
    if (!divider || divider.superview != _workspaceDividerOverlay ||
        !NSEqualRects(divider.frame, expected) ||
        divider.hidden != ![dividerProjection[@"visible"] boolValue]) {
      return NO;
    }
  }
  return YES;
}

- (void)destroy {
  if (_destroyed) return;
  [self removeWorkspaceDividerEventMonitor];
  RionRuntimeTabsRootView *root =
      [_accessoryController.view isKindOfClass:RionRuntimeTabsRootView.class]
      ? (RionRuntimeTabsRootView *)_accessoryController.view
      : nil;
  root.workspaceDividerAccessibilityChildren = @[];
  for (RionRuntimeWorkspaceDividerView *divider in
           _workspaceDividerViews.allValues) {
    [divider cancelActiveGesture];
    divider.workspaceDividerAccessibilityParent = nil;
    [divider removeFromSuperview];
  }
  [_workspaceDividerViews removeAllObjects];
  [_workspaceDividerOverlay removeFromSuperview];
  _workspaceDividerOverlay = nil;
  _workspaceDividerProjection = nil;
  [self hideStatus];
  [_statusBackdrop removeFromSuperview];
  _statusBackdrop = nil;
  _statusLoadingProgress = nil;
  _failureStack = nil;
  RionSetFullscreenPresentationPolicyMarker(_window, NO, NO);
  [self flushTabShortcutModifierHandoffWithAction:
            @"modifierHandoffAbandoned"];
  [self discardPhysicalModifierFocusHandoff];
  _destroyed = YES;
  [self stopTabDragEdgeScroll];
  if (_tabShortcutMonitor) {
    [NSEvent removeMonitor:_tabShortcutMonitor];
    _tabShortcutMonitor = nil;
  }
  if (_fullscreenToolbarPointerMonitor) {
    [NSEvent removeMonitor:_fullscreenToolbarPointerMonitor];
    _fullscreenToolbarPointerMonitor = nil;
  }
  // Remove this controller before tearing down its AppKit hosts so a pending
  // fullscreen policy cannot keep AutoHideToolbar overridden after destroy.
  RionSetFullscreenToolbarPresentationRequest((__bridge const void *)self,
                                              nil, NO, YES);
  if (_pendingContentLayoutNotification) {
    dispatch_block_cancel(_pendingContentLayoutNotification);
    _pendingContentLayoutNotification = nil;
  }
  if (_pendingFullscreenHostRefresh) {
    dispatch_block_cancel(_pendingFullscreenHostRefresh);
    _pendingFullscreenHostRefresh = nil;
  }
  _accessoryController.appearanceHandler = nil;
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
    _window.accessibilityIdentifier = _previousWindowAccessibilityIdentifier;
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

NS_ASSUME_NONNULL_END
