NS_ASSUME_NONNULL_BEGIN

- (BOOL)applyWorkspaceSlotLoads:(NSDictionary<NSString *, id> *)projection {
  if (_destroyed || !_window.contentView) return NO;
  NSString *tabID = projection[@"tabId"];
  NSArray *slots = projection[@"slots"];
  if (![tabID isKindOfClass:NSString.class] || ![slots isKindOfClass:NSArray.class]) return NO;
  if (!_workspaceSlotLoads) _workspaceSlotLoads = [NSMutableDictionary dictionary];
  _workspaceSlotLoads[tabID] = slots;
  [self updateWorkspaceSlotLoads];
  return YES;
}

- (void)updateWorkspaceSlotLoads {
  for (NSView *view in _workspaceSlotStatusViews) [view removeFromSuperview];
  _workspaceSlotStatusViews = [NSMutableArray array];
  if (_destroyed || !_window.contentView) return;
  for (NSString *tabID in _workspaceSlotLoads.allKeys.copy) {
    if (!_tabModelsByIdentifier[tabID]) [_workspaceSlotLoads removeObjectForKey:tabID];
  }
  RionRuntimeTabsRootView *root = [_accessoryController.view isKindOfClass:RionRuntimeTabsRootView.class]
      ? (RionRuntimeTabsRootView *)_accessoryController.view : nil;
  for (NSDictionary *slot in _workspaceSlotLoads[_activeTabItem.tabIdentifier]) {
    NSDictionary *record = slot[@"record"];
    if ([record[@"phase"] isEqualToString:@"ready"]) continue;
    NSDictionary *bounds = slot[@"bounds"];
    CGFloat x = [bounds[@"x"] doubleValue], y = [bounds[@"y"] doubleValue];
    CGFloat width = [bounds[@"width"] doubleValue], height = [bounds[@"height"] doubleValue];
    if (!_window.contentView.isFlipped) y = NSHeight(_window.contentView.bounds) - y - height;
    RionRuntimeStatusBackdropView *view = [[RionRuntimeStatusBackdropView alloc]
        initWithFrame:NSMakeRect(x, y, width, height)];
    view.autoresizingMask = NSViewNotSizable;
    view.clipsToBounds = YES;
    view.accessibilityParent = root;
    view.accessibilityElement = YES;
    view.accessibilityRole = NSAccessibilityGroupRole;
    view.accessibilityValue = record[@"phase"];
    view.accessibilityIdentifier = [@"workspace-slot-status:" stringByAppendingString:record[@"slotId"]];
    NSStackView *stack = [[NSStackView alloc] initWithFrame:NSZeroRect];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeCenterX;
    stack.spacing = 12;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    if ([record[@"phase"] isEqualToString:@"loading"]) {
      NSProgressIndicator *progress = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(0, 0, 24, 24)];
      progress.style = NSProgressIndicatorStyleSpinning;
      progress.indeterminate = YES;
      [progress startAnimation:nil];
      view.accessibilityLabel = record[@"loadingLabel"] ?: @"Loading";
      [stack addArrangedSubview:progress];
    } else {
      NSString *label = record[@"failureLabel"] ?: @"Unable to load this section";
      view.accessibilityLabel = label;
      NSTextField *title = [NSTextField wrappingLabelWithString:label];
      title.alignment = NSTextAlignmentCenter;
      [stack addArrangedSubview:title];
      if ([record[@"retryable"] boolValue]) {
        NSButton *button = [NSButton buttonWithTitle:record[@"retryLabel"] ?: @"Retry"
            target:self action:@selector(retryWorkspaceSlot:)];
        button.identifier = record[@"slotId"];
        [stack addArrangedSubview:button];
      }
    }
    [view addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
      [stack.centerXAnchor constraintEqualToAnchor:view.centerXAnchor],
      [stack.centerYAnchor constraintEqualToAnchor:view.centerYAnchor],
      [stack.widthAnchor constraintLessThanOrEqualToAnchor:view.widthAnchor constant:-24]
    ]];
    [_window.contentView addSubview:view positioned:NSWindowAbove relativeTo:nil];
    [_workspaceSlotStatusViews addObject:view];
  }
  root.workspaceSlotAccessibilityChildren = _workspaceSlotStatusViews;
  if (root) NSAccessibilityPostNotification(root, NSAccessibilityLayoutChangedNotification);
}

- (void)retryWorkspaceSlot:(NSButton *)sender {
  for (NSDictionary *slot in _workspaceSlotLoads[_activeTabItem.tabIdentifier]) {
    NSDictionary *record = slot[@"record"];
    if ([record[@"slotId"] isEqualToString:sender.identifier] && [record[@"retryable"] boolValue] && _actionHandler) {
      sender.enabled = NO;
      _actionHandler(@{ @"type": @"retryWorkspaceSlot", @"sourceWindowId": _windowID, @"record": record });
      return;
    }
  }
}

NS_ASSUME_NONNULL_END
