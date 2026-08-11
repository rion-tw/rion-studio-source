NS_ASSUME_NONNULL_BEGIN

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

- (nullable NSToolbarItem *)toolbar:(NSToolbar *)toolbar
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

- (void)emitWindowPlacementObservation {
  if (_destroyed || !_actionHandler || _windowID.length == 0) return;
  _actionHandler(@{
    @"type" : @"windowPlacementChanged",
    @"sourceWindowId" : _windowID
  });
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
    NSWindowDidMoveNotification,
    NSWindowDidEndLiveResizeNotification,
    NSWindowDidChangeBackingPropertiesNotification,
    NSWindowDidChangeScreenNotification,
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
      if ([notification.name isEqualToString:NSWindowDidResizeNotification] ||
          [notification.name
              isEqualToString:NSWindowDidChangeBackingPropertiesNotification] ||
          [notification.name isEqualToString:NSWindowDidChangeScreenNotification]) {
        [strongSelf layoutTitlebarContent];
        if ([notification.name isEqualToString:NSWindowDidResizeNotification]) {
          [strongSelf scheduleContentLayoutNotification];
          BOOL zoomed = strongSelf->_window.isZoomed;
          if (!strongSelf->_fullscreenTransitionActive &&
              !strongSelf->_window.inLiveResize &&
              zoomed != strongSelf->_placementZoomed) {
            strongSelf->_placementZoomed = zoomed;
            [strongSelf emitWindowPlacementObservation];
          }
        } else {
          [strongSelf emitWindowPlacementObservation];
        }
      } else if ([notification.name isEqualToString:NSWindowDidMoveNotification] ||
                 [notification.name
                     isEqualToString:NSWindowDidEndLiveResizeNotification]) {
        if (!strongSelf->_fullscreenTransitionActive) {
          strongSelf->_placementZoomed = strongSelf->_window.isZoomed;
          [strongSelf emitWindowPlacementObservation];
        }
      } else if ([notification.name isEqualToString:NSWindowDidBecomeKeyNotification] ||
                 [notification.name isEqualToString:NSWindowDidResignKeyNotification]) {
        if ([notification.name isEqualToString:NSWindowDidResignKeyNotification]) {
          [strongSelf flushTabShortcutModifierHandoffWithAction:
                          @"modifierHandoffAbandoned"];
        }
        if ([notification.name isEqualToString:NSWindowDidBecomeKeyNotification] &&
            !strongSelf->_fullscreenTransitionActive &&
            (strongSelf->_window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
          [strongSelf captureWindowedTrafficLightFrames];
          [strongSelf hideResidualFullScreenTrafficLightOverlay];
        }
        [strongSelf updateWindowActiveState];
      } else if ([notification.name
                     isEqualToString:NSWindowWillEnterFullScreenNotification]) {
        // The runtime normally prepares the empty toolbar before asking the
        // native window to enter fullscreen. Keep this notification as a fallback
        // for native traffic-light initiated transitions.
        [strongSelf prepareForFullscreenTransition:YES];
      } else if ([notification.name
                     isEqualToString:NSWindowDidEnterFullScreenNotification]) {
        strongSelf->_fullscreenTransitionActive = YES;
        strongSelf->_fullscreenHostReady = YES;
        strongSelf->_placementZoomed = strongSelf->_window.isZoomed;
        [strongSelf updateFullscreenToolbarPresentationPolicy];
        // AppKit has already built NSToolbarFullScreenWindow. Never replace its
        // toolbar here; apply the final native visibility and frame geometry.
        [strongSelf attachAccessoryController];
        [strongSelf applyFullScreenPolicy];
        [strongSelf scheduleLiquidGlassTitlebarRehost];
        [strongSelf scheduleFullscreenHostRefresh];
        [strongSelf emitWindowPlacementObservation];
      } else if ([notification.name
                     isEqualToString:NSWindowWillExitFullScreenNotification]) {
        strongSelf->_fullscreenHostReady = NO;
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
        strongSelf->_fullscreenHostReady = NO;
        strongSelf->_placementZoomed = strongSelf->_window.isZoomed;
        [strongSelf updateFullscreenToolbarPresentationPolicy];
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
        [strongSelf emitWindowPlacementObservation];
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
  RionDisableToolbarBaselineSeparator(toolbar);
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
  // Force AppKit to move the accessory out of NSToolbarFullScreenWindow.
  // Merely checking the browser window's controller array can leave the view
  // parented by the transition host even after DidExitFullScreen.
  [self detachAccessoryController];
  [self configureAccessoryForTitlebar];
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
  RionDisableToolbarBaselineSeparator(_toolbar);

  _titlebarBackdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  _titlebarBackdrop.material = NSVisualEffectMaterialHeaderView;
  _titlebarBackdrop.state = NSVisualEffectStateFollowsWindowActiveState;
  [self updateWindowActiveState];
}

- (void)configureAccessoryForTitlebar {
  if (_destroyed || !_window || !_accessoryController) return;

  // A trailing accessory shares the unified titlebar row with AppKit's window
  // controls. Bottom is intentionally avoided because it creates a second row;
  // fullscreen visibility is owned by NSToolbar and presentation options.
  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _accessoryController.fullScreenMinHeight = 0;
}

- (void)scheduleLiquidGlassTitlebarRehost {
  __weak RionRuntimeTabsController *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    RionRuntimeTabsController *strongSelf = weakSelf;
    if (!strongSelf || strongSelf->_destroyed || !strongSelf->_window) return;

    // The WebView host can finish its own fullscreen transition after AppKit's
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

- (void)displayTitlebarHostIfNeeded {
  if (_destroyed || !_window || !_toolbar || !_accessoryController) return;

  [_toolbar validateVisibleItems];
  if (_toolbar.visible) [self orderToolbarBelowAccessory];
  NSView *toolbarView = [self toolbarHostView];
  [toolbarView.superview layoutSubtreeIfNeeded];
  [_accessoryController.view layoutSubtreeIfNeeded];
  [_window.contentView.superview layoutSubtreeIfNeeded];
  [toolbarView displayIfNeeded];
  [_accessoryController.view displayIfNeeded];
  [_window displayIfNeeded];
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
    BOOL fullScreen = _fullscreenTransitionActive ||
        (_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
    if (!fullScreen) {
      // Re-adding is safe in the settled windowed host. In fullscreen AppKit
      // owns a clip view for bottom accessories, so never detach it merely to
      // repair z-order; viewDidAppear schedules a non-destructive refresh.
      [self detachAccessoryController];
      [self attachAccessoryController];
    }
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

- (NSView *)tabSurfaceOverlayHost {
  return _clusterContent;
}

- (void)setWindowName:(nullable NSString *)windowName {
  if (_destroyed) return;
  NSString *name = [windowName stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  _windowNameField.stringValue = name ?: @"";
  _windowNameField.toolTip = name.length > 0 ? name : nil;
  _windowNameField.accessibilityLabel = name.length > 0 ? name : nil;
  _windowNameField.hidden = name.length == 0;
  [self layoutTitlebarContent];
}

- (void)layoutTitlebarContent {
  if (_destroyed || !_window) return;
  NSView *root = _accessoryController.view;
  CGFloat rootWidth = MAX(1.0, _window.frame.size.width);
  CGFloat rootHeight = kRionTitlebarHeight;
  root.frame = NSMakeRect(0, 0, rootWidth, rootHeight);
  _titlebarBackdrop.frame = root.bounds;

  CGFloat leadingInset = [self trafficLightReserveWidth] + kRionRootLeadingInset;
  CGFloat windowNameWidth = 0;
  if (!_windowNameField.hidden) {
    windowNameWidth = RionRuntimeWindowNameWidth(
        _windowNameField.intrinsicContentSize.width);
    _windowNameField.frame = NSMakeRect(
        leadingInset, MAX(0, (rootHeight - kRionTabHeight) / 2.0),
        windowNameWidth, kRionTabHeight);
    leadingInset += windowNameWidth + kRionWindowNameTrailingSpacing;
  } else {
    _windowNameField.frame = NSZeroRect;
  }
  CGFloat availableWithoutScrollControls = MAX(
      0,
      rootWidth - leadingInset - kRionRootTrailingDraggableWidth -
          kRionTabHeight - kRionAddButtonSpacing);
  std::vector<CGFloat> preferredSlotWidths;
  std::vector<NSInteger> slotTabIndexes;
  BOOL insertedGhost = NO;
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    RionRuntimeTabItemView *item = _tabItems[index];
    if (_externalDragGhostWidth > 0 && !insertedGhost &&
        [_externalDragGhostBeforeIdentifier
            isEqualToString:item.tabIdentifier]) {
      preferredSlotWidths.push_back(_externalDragGhostWidth);
      slotTabIndexes.push_back(-1);
      insertedGhost = YES;
    }
    preferredSlotWidths.push_back(item.preferredWidth);
    slotTabIndexes.push_back((NSInteger)index);
  }
  if (_externalDragGhostWidth > 0 && !insertedGhost) {
    preferredSlotWidths.push_back(_externalDragGhostWidth);
    slotTabIndexes.push_back(-1);
  }
  RionRuntimeTabWidthLayout widthLayout = RionRuntimeResolveTabWidths(
      preferredSlotWidths, availableWithoutScrollControls,
      _window.backingScaleFactor);
  std::vector<CGFloat> resolvedTabWidths(
      _tabItems.count, kRionTabCompactMinimumWidth);
  CGFloat resolvedGhostWidth = 0;
  for (size_t slot = 0; slot < slotTabIndexes.size(); ++slot) {
    NSInteger tabIndex = slotTabIndexes[slot];
    if (tabIndex < 0) {
      resolvedGhostWidth = widthLayout.widths[slot];
    } else {
      resolvedTabWidths[(NSUInteger)tabIndex] = widthLayout.widths[slot];
    }
  }
  _externalDragGhostLayoutWidth = resolvedGhostWidth;
  CGFloat tabsWidth = widthLayout.contentWidth;
  BOOL overflowing = widthLayout.overflowing;
  CGFloat fusionInset = overflowing ? kRionTabScrollFusionInset : 0;
  CGFloat canvasWidth = tabsWidth + 2.0 * fusionInset;
  CGFloat viewportWidth = MIN(canvasWidth, availableWithoutScrollControls);
  CGFloat verticalInset = MAX(0, (rootHeight - kRionTabHeight) / 2.0);
  _clusterContainer.frame = NSMakeRect(
      leadingInset, verticalInset, viewportWidth, kRionTabHeight);
  _clusterContent.frame = _clusterContainer.bounds;
  _scrollLeftSurface.hidden = !overflowing;
  _scrollRightSurface.hidden = !overflowing;
  if (overflowing) {
    _scrollLeftSurface.frame =
        NSMakeRect(0, 0, kRionTabScrollButtonWidth, kRionTabHeight);
    _scrollLeftButton.frame = _scrollLeftSurface.bounds;
    _scrollRightSurface.frame =
        NSMakeRect(MAX(0, viewportWidth - kRionTabScrollButtonWidth), 0,
                   kRionTabScrollButtonWidth, kRionTabHeight);
    _scrollRightButton.frame = _scrollRightSurface.bounds;
  } else {
    _scrollLeftSurface.frame = NSZeroRect;
    _scrollRightSurface.frame = NSZeroRect;
  }
  _tabScrollView.frame = _clusterContent.bounds;
  _tabCanvas.frame = NSMakeRect(0, 0, MAX(canvasWidth, viewportWidth),
                                kRionTabHeight);

  CGFloat x = fusionInset;
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    RionRuntimeTabItemView *item = _tabItems[index];
    RionRuntimeSurfaceView *surface = _tabSurfaces[index];
    CGFloat width = resolvedTabWidths[index];
    item.layoutWidth = width;
    if (_externalDragGhostWidth > 0 &&
        [_externalDragGhostBeforeIdentifier
            isEqualToString:item.tabIdentifier]) {
      x += resolvedGhostWidth + kRionTabSpacing;
    }
    BOOL lifted = _dragSurfaceOverlayActive &&
        [_dragPlaceholderTabIdentifier isEqualToString:item.tabIdentifier];
    NSRect canvasFrame = NSMakeRect(lifted ? _dragSurfaceCanvasX : x, 0,
                                    width, kRionTabHeight);
    if (lifted) {
      NSView *overlayHost = [self tabSurfaceOverlayHost];
      NSRect overlayFrame = [overlayHost convertRect:canvasFrame
                                            fromView:_tabCanvas];
      [overlayHost addSubview:surface
                   positioned:NSWindowAbove
                   relativeTo:nil];
      surface.frame = overlayFrame;
    } else {
      [_tabCanvas addSubview:surface positioned:NSWindowAbove relativeTo:nil];
      surface.frame = canvasFrame;
    }
    // RionRuntimeSurfaceView owns the item's frame because edge cropping moves
    // the full-width tab inside a smaller glass host. Do not reset it here or
    // AppKit will re-layout the title and accessories at the cropped width.
    [surface layoutSubtreeIfNeeded];
    [item layoutSubtreeIfNeeded];
    x += width + kRionTabSpacing;
  }
  CGFloat tabsEndX = leadingInset + viewportWidth;
  _addSurface.frame = NSMakeRect(tabsEndX + kRionAddButtonSpacing,
                                 verticalInset, kRionTabHeight, kRionTabHeight);
  _addButton.frame = _addSurface.bounds;

  if (!_dragSurfaceOverlayActive) {
    [self scrollActiveTabIntoView];
  }
  [self updateTabScrollButtonState];
  [self updateTabEdgeFadeMasks];
}

NS_ASSUME_NONNULL_END
