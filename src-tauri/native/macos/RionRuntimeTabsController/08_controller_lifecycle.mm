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
  [self hideFailureStatus];
  [_failureBackdrop removeFromSuperview];
  _failureBackdrop = nil;
  RionSetFullscreenPresentationPolicyMarker(_window, NO, NO);
  [self flushTabShortcutModifierHandoffWithAction:
            @"modifierHandoffAbandoned"];
  _destroyed = YES;
  [self stopTabDragEdgeScroll];
  if (_tabShortcutMonitor) {
    [NSEvent removeMonitor:_tabShortcutMonitor];
    _tabShortcutMonitor = nil;
  }
  // Remove this controller before tearing down its AppKit hosts so a pending
  // fullscreen policy cannot keep AutoHideToolbar overridden after destroy.
  RionSetFullscreenToolbarPresentationRequest((__bridge const void *)self,
                                              NO, YES);
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
