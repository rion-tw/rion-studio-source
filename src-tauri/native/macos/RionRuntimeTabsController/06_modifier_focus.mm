NS_ASSUME_NONNULL_BEGIN

static NSEventModifierFlags RionRuntimeMomentaryModifierMask(void) {
  return NSEventModifierFlagShift | NSEventModifierFlagControl |
      NSEventModifierFlagOption | NSEventModifierFlagCommand;
}

static NSEventModifierFlags RionRuntimePhysicalModifierFlagForKeyCode(
    unsigned short keyCode) {
  switch (keyCode) {
    case 54:  // Right Command
    case 55:  // Left Command
      return NSEventModifierFlagCommand;
    case 56:  // Left Shift
    case 60:  // Right Shift
      return NSEventModifierFlagShift;
    case 58:  // Left Option
    case 61:  // Right Option
      return NSEventModifierFlagOption;
    case 59:  // Left Control
    case 62:  // Right Control
      return NSEventModifierFlagControl;
    default:
      return 0;
  }
}

static NSEventModifierFlags RionRuntimeModifierFlagsForCodes(
    NSArray<NSNumber *> *codes) {
  NSEventModifierFlags flags = 0;
  for (NSNumber *code in codes) {
    flags |= RionRuntimePhysicalModifierFlagForKeyCode(
        code.unsignedShortValue);
  }
  return flags;
}

static NSEvent *RionRuntimeModifierEvent(
    unsigned short keyCode, NSEventModifierFlags flags,
    NSInteger windowNumber) {
  return [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                         location:NSZeroPoint
                    modifierFlags:flags
                        timestamp:NSProcessInfo.processInfo.systemUptime
                     windowNumber:windowNumber
                          context:nil
                       characters:@""
      charactersIgnoringModifiers:@""
                        isARepeat:NO
                          keyCode:keyCode];
}

static NSArray<NSNumber *> *RionRuntimeDispatchModifierReleases(
    NSArray<NSNumber *> *order,
    NSMapTable<NSNumber *, NSResponder *> *responders,
    NSEventModifierFlags preservedFlags, NSInteger windowNumber) {
  NSMutableArray<NSNumber *> *remaining = [order mutableCopy];
  NSMutableArray<NSNumber *> *deliveredReverse = [NSMutableArray array];
  for (NSNumber *code in order.reverseObjectEnumerator) {
    [remaining removeObject:code];
    NSResponder *responder = [responders objectForKey:code];
    if (!responder) continue;
    NSEvent *release = RionRuntimeModifierEvent(
        code.unsignedShortValue,
        preservedFlags | RionRuntimeModifierFlagsForCodes(remaining),
        windowNumber);
    if (!release) continue;
    [responder flagsChanged:release];
    [deliveredReverse addObject:code];
  }
  return [[deliveredReverse reverseObjectEnumerator] allObjects];
}

static NSArray<NSNumber *> *RionRuntimeHeldModifierCodes(
    NSArray<NSNumber *> *codes, BOOL (^isPressed)(unsigned short keyCode)) {
  NSMutableArray<NSNumber *> *held = [NSMutableArray array];
  for (NSNumber *code in codes) {
    if (isPressed(code.unsignedShortValue)) [held addObject:code];
  }
  return held;
}

- (void)trackPhysicalModifierEvent:(NSEvent *)event {
  NSEventModifierFlags flag =
      RionRuntimePhysicalModifierFlagForKeyCode(event.keyCode);
  if (_destroyed || flag == 0) return;
  NSNumber *code = @(event.keyCode);
  BOOL alreadyPressed = [_physicalModifierOrder containsObject:code];
  if (alreadyPressed) {
    [_physicalModifierOrder removeObject:code];
    [_physicalModifierResponders removeObjectForKey:code];
    return;
  }
  // The local monitor observes flagsChanged before the combined-session CG
  // state has necessarily caught up. For an untracked side, its family flag
  // identifies the press; a tracked side's next flagsChanged is its release.
  // Exact CG side state remains authoritative when focus is regained.
  if ((event.modifierFlags & flag) == 0) return;
  NSResponder *responder = _window.firstResponder;
  if (!responder) return;
  [_physicalModifierOrder addObject:code];
  [_physicalModifierResponders setObject:responder forKey:code];
}

- (void)emitModifierFocusAction:(NSString *)actionType
                  modifierCount:(NSUInteger)modifierCount {
  if (!_actionHandler || actionType.length == 0) return;
  NSMutableDictionary<NSString *, id> *action = [@{
    @"type" : actionType,
    @"sourceWindowId" : _windowID ?: @"",
    @"modifierCount" : @(modifierCount)
  } mutableCopy];
  if (_activeTabItem.tabIdentifier.length > 0) {
    action[@"tabId"] = _activeTabItem.tabIdentifier;
  }
  _actionHandler(action);
}

- (NSUInteger)neutralizePhysicalModifiersSavingFocusHandoff:(BOOL)saveHandoff {
  if (_destroyed || !_window) return 0;
  NSArray<NSNumber *> *order = [_physicalModifierOrder copy];
  NSEventModifierFlags preserved = NSEvent.modifierFlags &
      NSEventModifierFlagDeviceIndependentFlagsMask &
      ~RionRuntimeMomentaryModifierMask();
  NSArray<NSNumber *> *delivered = RionRuntimeDispatchModifierReleases(
      order, _physicalModifierResponders, preserved, _window.windowNumber);
  [_physicalModifierOrder removeAllObjects];
  [_physicalModifierResponders removeAllObjects];

  if (saveHandoff) {
    _modifierFocusGeneration += 1;
    _neutralizedModifierGeneration = _modifierFocusGeneration;
    _neutralizedModifierOrder = delivered;
  }
  return delivered.count;
}

- (void)neutralizePhysicalModifiersForFocusLoss {
  NSUInteger count =
      [self neutralizePhysicalModifiersSavingFocusHandoff:YES];
  [self finishTabShortcutModifierHandoffWithAction:
            @"modifierHandoffAbandoned"];
  if (count > 0) {
    [self emitModifierFocusAction:@"modifierFocusNeutralized"
                    modifierCount:count];
  }
}

- (void)reassertPhysicalModifiersAfterFocusGain {
  NSArray<NSNumber *> *snapshot = _neutralizedModifierOrder;
  NSUInteger generation = _neutralizedModifierGeneration;
  _neutralizedModifierOrder = nil;
  _neutralizedModifierGeneration = 0;
  if (snapshot.count == 0 || generation != _modifierFocusGeneration ||
      _destroyed || !_window) {
    return;
  }
  NSResponder *responder = _window.firstResponder;
  if (!responder) return;

  NSArray<NSNumber *> *held = RionRuntimeHeldModifierCodes(
      snapshot, ^BOOL(unsigned short keyCode) {
        return CGEventSourceKeyState(
            kCGEventSourceStateCombinedSessionState, (CGKeyCode)keyCode);
      });
  NSEventModifierFlags preserved = NSEvent.modifierFlags &
      NSEventModifierFlagDeviceIndependentFlagsMask &
      ~RionRuntimeMomentaryModifierMask();
  for (NSNumber *code in held) {
    [_physicalModifierOrder addObject:code];
    [_physicalModifierResponders setObject:responder forKey:code];
    NSEvent *press = RionRuntimeModifierEvent(
        code.unsignedShortValue,
        preserved | RionRuntimeModifierFlagsForCodes(_physicalModifierOrder),
        _window.windowNumber);
    if (press) [responder flagsChanged:press];
  }
  [self emitModifierFocusAction:@"modifierFocusReasserted"
                  modifierCount:held.count];
}

- (void)discardPhysicalModifierFocusHandoff {
  _modifierFocusGeneration += 1;
  _neutralizedModifierGeneration = 0;
  _neutralizedModifierOrder = nil;
  [_physicalModifierOrder removeAllObjects];
  [_physicalModifierResponders removeAllObjects];
}

bool rion_runtime_tabs_modifier_focus_self_test(void) {
  @autoreleasepool {
    NSArray<NSNumber *> *allCodes = @[ @55, @54, @56, @60, @58, @61, @59, @62 ];
    RionRuntimeShortcutResponderProbe *probe =
        [[RionRuntimeShortcutResponderProbe alloc] init];
    NSMapTable<NSNumber *, NSResponder *> *responders =
        [NSMapTable strongToWeakObjectsMapTable];
    for (NSNumber *code in allCodes) [responders setObject:probe forKey:code];
    NSArray<NSNumber *> *released = RionRuntimeDispatchModifierReleases(
        allCodes, responders, 0, 0);
    NSArray<NSNumber *> *held = RionRuntimeHeldModifierCodes(
        allCodes, ^BOOL(unsigned short keyCode) {
          return keyCode == 55 || keyCode == 60 || keyCode == 62;
        });
    NSSet<NSNumber *> *uniqueReleased = [NSSet setWithArray:probe.keyCodes];
    return
        RionRuntimePhysicalModifierFlagForKeyCode(55) == NSEventModifierFlagCommand &&
        RionRuntimePhysicalModifierFlagForKeyCode(54) == NSEventModifierFlagCommand &&
        RionRuntimePhysicalModifierFlagForKeyCode(56) == NSEventModifierFlagShift &&
        RionRuntimePhysicalModifierFlagForKeyCode(60) == NSEventModifierFlagShift &&
        RionRuntimePhysicalModifierFlagForKeyCode(58) == NSEventModifierFlagOption &&
        RionRuntimePhysicalModifierFlagForKeyCode(61) == NSEventModifierFlagOption &&
        RionRuntimePhysicalModifierFlagForKeyCode(59) == NSEventModifierFlagControl &&
        RionRuntimePhysicalModifierFlagForKeyCode(62) == NSEventModifierFlagControl &&
        RionRuntimePhysicalModifierFlagForKeyCode(57) == 0 &&
        [released isEqualToArray:allCodes] &&
        [probe.keyCodes isEqualToArray:[[allCodes reverseObjectEnumerator] allObjects]] &&
        uniqueReleased.count == allCodes.count &&
        [held isEqualToArray:@[ @55, @60, @62 ]] &&
        (probe.modifierFlags.lastObject.unsignedLongValue &
         RionRuntimeMomentaryModifierMask()) == 0;
  }
}

NS_ASSUME_NONNULL_END
