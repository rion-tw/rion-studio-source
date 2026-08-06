NS_ASSUME_NONNULL_BEGIN

static BOOL RionInstallTitlebarWidgetInsetHook(NSView * _Nullable frameView) {
  if (!frameView) return NO;
  // AppKit's auxiliary fullscreen windows do not consistently expose this
  // private metric. Their native inset is the supported fallback, so skip an
  // incompatible frame without treating it as a runtime failure.
  SEL selector = NSSelectorFromString(@"_minXTitlebarWidgetInset");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    return NO;
  }

  Class targetClass = object_getClass(frameView);
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarWidgetInsetHookMutex);
  if (RionRuntimeOriginalTitlebarWidgetInsetIMPs.find(targetClass) !=
      RionRuntimeOriginalTitlebarWidgetInsetIMPs.end()) {
    return YES;
  }

  Method inheritedMethod = class_getInstanceMethod(targetClass, selector);
  if (!inheritedMethod) {
    return NO;
  }
  IMP original = method_getImplementation(inheritedMethod);
  if (original == (IMP)RionRuntimeTitlebarWidgetInset) return YES;
  const char *types = method_getTypeEncoding(inheritedMethod);
  RionRuntimeOriginalTitlebarWidgetInsetIMPs.emplace(targetClass, original);

  Method directMethod = RionDirectInstanceMethod(targetClass, selector);
  if (directMethod) {
    method_setImplementation(directMethod,
                             (IMP)RionRuntimeTitlebarWidgetInset);
    return YES;
  }
  if (class_addMethod(targetClass, selector,
                      (IMP)RionRuntimeTitlebarWidgetInset, types)) {
    return YES;
  }

  RionRuntimeOriginalTitlebarWidgetInsetIMPs.erase(targetClass);
  return NO;
}

@class RionRuntimeTabsController;
@class RionRuntimeSurfaceView;

@interface RionRuntimeDraggableView : NSView
@end

static NSString * _Nullable RionStringFromUTF8(
    const char * _Nullable value) {
  if (!value) return nil;
  return [NSString stringWithUTF8String:value];
}

static NSPoint RionTopLeftScreenPoint(NSPoint screenPoint) {
  CGFloat desktopTop = 0;
  for (NSScreen *screen in NSScreen.screens) {
    desktopTop = MAX(desktopTop, NSMaxY(screen.frame));
  }
  return NSMakePoint(screenPoint.x, desktopTop - screenPoint.y);
}

static void RionForwardRuntimeTabsAction(
    NSDictionary<NSString *, id> *action, void *context,
    RionRuntimeTabsCActionHandler actionHandler) {
  NSString *type = action[@"type"];
  NSString *sessionID = action[@"sessionId"];
  NSString *tabID = action[@"tabId"];
  NSString *beforeTabID = action[@"beforeTabId"];
  NSArray<NSString *> *orderedTabIDs = action[@"orderedTabIds"];
  NSString *orderedTabIDsJSON = nil;
  if ([orderedTabIDs isKindOfClass:NSArray.class]) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:orderedTabIDs
                                                   options:0
                                                     error:&error];
    if (data && !error) {
      orderedTabIDsJSON = [[NSString alloc] initWithData:data
                                                 encoding:NSUTF8StringEncoding];
    }
  }
  NSString *sourceWindowID = action[@"sourceWindowId"];
  NSString *targetWindowID = action[@"windowId"];
  NSNumber *screenX = action[@"screenX"];
  NSNumber *screenY = action[@"screenY"];
  NSNumber *grabRatioX = action[@"grabRatioX"];
  NSNumber *grabRatioY = action[@"grabRatioY"];
  NSNumber *tabWidth = action[@"tabWidth"];
  NSNumber *tabHeight = action[@"tabHeight"];
  NSNumber *cancelled = action[@"cancelled"];
  actionHandler(context, type.UTF8String, sessionID.UTF8String, tabID.UTF8String,
                sourceWindowID.UTF8String, targetWindowID.UTF8String,
                beforeTabID.UTF8String, orderedTabIDsJSON.UTF8String,
                screenX ? screenX.doubleValue : NAN,
                screenY ? screenY.doubleValue : NAN,
                grabRatioX ? grabRatioX.doubleValue : NAN,
                grabRatioY ? grabRatioY.doubleValue : NAN,
                tabWidth ? tabWidth.doubleValue : NAN,
                tabHeight ? tabHeight.doubleValue : NAN,
                cancelled ? cancelled.boolValue : false);
}

void * _Nullable rion_runtime_tabs_create(
    void *rawWindow, const char *rawWindowIdentifier, void *context,
    RionRuntimeTabsCActionHandler actionHandler,
    RionRuntimeTabsCLayoutHandler layoutHandler) {
  @autoreleasepool {
    if (!rawWindow || !rawWindowIdentifier || !actionHandler || !layoutHandler) {
      return nullptr;
    }
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    NSString *windowIdentifier = RionStringFromUTF8(rawWindowIdentifier);
    if (windowIdentifier.length == 0) return nullptr;
    RionRuntimeTabsController *controller =
        [[RionRuntimeTabsController alloc]
            initWithWindow:window
            windowIdentifier:windowIdentifier
            actionHandler:^(NSDictionary<NSString *, id> *action) {
              RionForwardRuntimeTabsAction(action, context, actionHandler);
            }
            contentLayoutHandler:^(RionRuntimeContentLayout layout) {
              layoutHandler(context, layout.heightInset, layout.yOffset,
                            layout.valid);
            }];
    return (__bridge_retained void *)controller;
  }
}

void rion_runtime_tabs_destroy(void * _Nullable rawController) {
  @autoreleasepool {
    if (!rawController) return;
    RionRuntimeTabsController *controller =
        (__bridge_transfer RionRuntimeTabsController *)rawController;
    [controller destroy];
  }
}

void rion_runtime_tabs_prepare_fullscreen(
    void * _Nullable rawController, bool fullscreen) {
  if (rawController) {
    [(__bridge RionRuntimeTabsController *)rawController
        prepareForFullscreenTransition:fullscreen];
  }
}

void rion_runtime_tabs_set_fullscreen_policy(
    void * _Nullable rawController, bool alwaysShow) {
  if (rawController) {
    [(__bridge RionRuntimeTabsController *)rawController
        setAlwaysShowInFullScreen:alwaysShow];
  }
}

bool rion_runtime_tabs_is_main_thread(void) {
  return [NSThread isMainThread];
}

bool rion_runtime_tabs_set_window_interaction(
    void * _Nullable rawWindow, bool pointerPassthrough, bool focusWindow) {
  @autoreleasepool {
    if (!rawWindow || !NSThread.isMainThread) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    window.ignoresMouseEvents = pointerPassthrough;
    if (!pointerPassthrough && focusWindow) {
      [NSApp activateIgnoringOtherApps:YES];
      [window makeKeyAndOrderFront:nil];
    }
    return window.ignoresMouseEvents == pointerPassthrough;
  }
}

void rion_runtime_tabs_set_reveal_locked(
    void * _Nullable rawController, bool locked) {
  if (rawController) {
    [(__bridge RionRuntimeTabsController *)rawController setRevealLocked:locked];
  }
}

void rion_runtime_tabs_set_window_name(
    void * _Nullable rawController, const char * _Nullable windowName) {
  @autoreleasepool {
    if (!rawController) return;
    [(__bridge RionRuntimeTabsController *)rawController
        setWindowName:RionStringFromUTF8(windowName)];
  }
}

void rion_runtime_tabs_set_active(
    void * _Nullable rawController,
    const char * _Nullable tabIdentifier) {
  @autoreleasepool {
    if (!rawController) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller setActiveTabIdentifier:RionStringFromUTF8(tabIdentifier)];
  }
}

void rion_runtime_tabs_ensure(void * _Nullable rawController,
                              const char *tabIdentifier,
                              const char *name, const char *type,
                              const char * _Nullable workspaceTemplate,
                              const char *windowIdentifier) {
  @autoreleasepool {
    if (!rawController || !tabIdentifier || !name || !type ||
        !windowIdentifier) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller ensureTabIdentifier:RionStringFromUTF8(tabIdentifier)
                               name:RionStringFromUTF8(name)
                               type:RionStringFromUTF8(type)
                  workspaceTemplate:RionStringFromUTF8(workspaceTemplate)
                   windowIdentifier:RionStringFromUTF8(windowIdentifier)];
  }
}

void rion_runtime_tabs_reserve(void * _Nullable rawController,
                               const char *tabIdentifier,
                               const char *name, const char *type,
                               const char * _Nullable workspaceTemplate,
                               const char *windowIdentifier) {
  @autoreleasepool {
    if (!rawController || !tabIdentifier || !name || !type ||
        !windowIdentifier) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller reserveTabIdentifier:RionStringFromUTF8(tabIdentifier)
                                name:RionStringFromUTF8(name)
                                type:RionStringFromUTF8(type)
                   workspaceTemplate:RionStringFromUTF8(workspaceTemplate)
                    windowIdentifier:RionStringFromUTF8(windowIdentifier)];
  }
}

void rion_runtime_tabs_replace(void * _Nullable rawController,
                               const char *provisionalIdentifier,
                               const char *tabIdentifier, const char *name,
                               const char *type,
                               const char * _Nullable workspaceTemplate,
                               const char * _Nullable activeTabIdentifier) {
  @autoreleasepool {
    if (!rawController || !provisionalIdentifier || !tabIdentifier || !name ||
        !type) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller
        replaceTabIdentifier:RionStringFromUTF8(provisionalIdentifier)
              withIdentifier:RionStringFromUTF8(tabIdentifier)
                        name:RionStringFromUTF8(name)
                        type:RionStringFromUTF8(type)
           workspaceTemplate:RionStringFromUTF8(workspaceTemplate)
         activeTabIdentifier:RionStringFromUTF8(activeTabIdentifier)];
  }
}

void rion_runtime_tabs_remove(
    void * _Nullable rawController, const char *tabIdentifier,
    const char * _Nullable activeTabIdentifier) {
  @autoreleasepool {
    if (!rawController || !tabIdentifier) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller removeTabIdentifier:RionStringFromUTF8(tabIdentifier)
                activeTabIdentifier:RionStringFromUTF8(activeTabIdentifier)];
  }
}

void rion_runtime_tabs_reorder(void * _Nullable rawController,
                               const char *tabIdentifiersJSON) {
  @autoreleasepool {
    if (!rawController || !tabIdentifiersJSON) return;
    NSString *json = RionStringFromUTF8(tabIdentifiersJSON);
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    id value = data ? [NSJSONSerialization JSONObjectWithData:data
                                                       options:0
                                                         error:nil]
                    : nil;
    if (![value isKindOfClass:[NSArray class]]) return;
    NSMutableArray<NSString *> *identifiers = [NSMutableArray array];
    for (id identifier in (NSArray *)value) {
      if ([identifier isKindOfClass:[NSString class]]) {
        [identifiers addObject:identifier];
      }
    }
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller reorderTabIdentifiers:identifiers];
  }
}

void rion_runtime_tabs_update_metadata(
    void * _Nullable rawController, const RionRuntimeTabInput *input,
    bool alwaysHideTabCloseButton, const char *audioMutedLabel,
    const char *audioPlayingLabel, const char *closeLabel,
    const char *addLabel, const char *scrollLeftLabel,
    const char *scrollRightLabel) {
  @autoreleasepool {
    if (!rawController || !input || !input->identifier) return;
    RionRuntimeTabModel *tab = [[RionRuntimeTabModel alloc] init];
    tab.active = input->active;
    tab.audible = input->audible;
    tab.audioMuted = input->audioMuted;
    tab.identifier = RionStringFromUTF8(input->identifier) ?: @"";
    tab.name = RionStringFromUTF8(input->name) ?: tab.identifier;
    tab.tooltip = RionStringFromUTF8(input->tooltip) ?: tab.name;
    tab.type = RionStringFromUTF8(input->type) ?: @"role";
    tab.iconDataURL = RionStringFromUTF8(input->iconDataURL);
    tab.workspaceTemplate = RionStringFromUTF8(input->workspaceTemplate);
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller
          updateTabMetadata:tab
         hideTabCloseButton:alwaysHideTabCloseButton
                   addLabel:RionStringFromUTF8(addLabel) ?:
                                @"Open role or workspace"
                 closeLabel:RionStringFromUTF8(closeLabel) ?:
                                @"Stop and close tab"
          audioPlayingLabel:RionStringFromUTF8(audioPlayingLabel) ?:
                                @"Playing audio"
             audioMutedLabel:RionStringFromUTF8(audioMutedLabel) ?: @"Tab muted"
            scrollLeftLabel:RionStringFromUTF8(scrollLeftLabel) ?:
                                @"Scroll tabs left"
           scrollRightLabel:RionStringFromUTF8(scrollRightLabel) ?:
                                @"Scroll tabs right"];
  }
}

RionRuntimeContentLayout rion_runtime_tabs_content_layout(
    void * _Nullable rawController) {
  if (!rawController) return (RionRuntimeContentLayout){0, 0, NO};
  return [(__bridge RionRuntimeTabsController *)rawController contentLayout];
}

@interface RionRuntimeTabsController (RionDragGeometry)
- (BOOL)controlRowContainsTopLeftScreenPoint:(NSPoint)point;
- (BOOL)dragAnchorForTabIdentifier:(NSString *)tabIdentifier
                        grabRatioX:(double)grabRatioX
                        grabRatioY:(double)grabRatioY
                      windowOffset:(NSPoint *)windowOffset;
@end

bool rion_runtime_tabs_control_row_contains(void * _Nullable rawController,
                                            double screenX,
                                            double screenY) {
  if (!rawController || !std::isfinite(screenX) || !std::isfinite(screenY)) {
    return false;
  }
  return [(__bridge RionRuntimeTabsController *)rawController
      controlRowContainsTopLeftScreenPoint:NSMakePoint(screenX, screenY)];
}

bool rion_runtime_tabs_drag_anchor(void * _Nullable rawController,
                                   const char *tabIdentifier,
                                   double grabRatioX,
                                   double grabRatioY,
                                   double *windowOffsetX,
                                   double *windowOffsetY) {
  if (!rawController || !tabIdentifier || !windowOffsetX || !windowOffsetY ||
      !std::isfinite(grabRatioX) || !std::isfinite(grabRatioY)) {
    return false;
  }
  NSPoint offset = NSZeroPoint;
  BOOL available = [(__bridge RionRuntimeTabsController *)rawController
      dragAnchorForTabIdentifier:RionStringFromUTF8(tabIdentifier)
                     grabRatioX:grabRatioX
                     grabRatioY:grabRatioY
                   windowOffset:&offset];
  if (!available) return false;
  *windowOffsetX = offset.x;
  *windowOffsetY = offset.y;
  return true;
}

struct RionRuntimeTabsActionScopeProbe {
  std::string sourceWindowID;
  std::string targetWindowID;
  bool called;
};

static void RionRuntimeTabsActionScopeProbeCallback(
    void *context, const char *type, const char *sessionIdentifier,
    const char *tabIdentifier,
    const char *sourceWindowID, const char *targetWindowID,
    const char *beforeTabIdentifier, const char *orderedTabIdentifiersJSON,
    double screenX, double screenY,
    double grabRatioX, double grabRatioY, double tabWidth, double tabHeight,
    bool cancelled) {
  (void)sessionIdentifier;
  (void)tabIdentifier;
  (void)beforeTabIdentifier;
  (void)orderedTabIdentifiersJSON;
  (void)screenX;
  (void)screenY;
  (void)grabRatioX;
  (void)grabRatioY;
  (void)tabWidth;
  (void)tabHeight;
  (void)cancelled;
  RionRuntimeTabsActionScopeProbe *probe =
      static_cast<RionRuntimeTabsActionScopeProbe *>(context);
  probe->called = type && (strcmp(type, "openLauncher") == 0 ||
                           strcmp(type, "move") == 0);
  probe->sourceWindowID = sourceWindowID ?: "";
  probe->targetWindowID = targetWindowID ?: "";
}

bool rion_runtime_tabs_action_scope_self_test(void) {
  @autoreleasepool {
    RionRuntimeTabsActionScopeProbe launcherProbe = {"", "", false};
    RionForwardRuntimeTabsAction(
        @{ @"type" : @"openLauncher", @"sourceWindowId" : @"window-a" },
        &launcherProbe, RionRuntimeTabsActionScopeProbeCallback);
    RionRuntimeTabsActionScopeProbe moveProbe = {"", "", false};
    RionForwardRuntimeTabsAction(
        @{ @"type" : @"move",
           @"sourceWindowId" : @"window-a",
           @"windowId" : @"window-b" },
        &moveProbe, RionRuntimeTabsActionScopeProbeCallback);
    return launcherProbe.called && launcherProbe.sourceWindowID == "window-a" &&
           launcherProbe.targetWindowID.empty() && moveProbe.called &&
           moveProbe.sourceWindowID == "window-a" &&
           moveProbe.targetWindowID == "window-b";
  }
}

bool rion_runtime_tabs_overflow_layout_self_test(void) {
  @autoreleasepool {
    CGFloat visibleWidth = RionRuntimePreferredTabWidth(160.0, NO);
    CGFloat hiddenWidth = RionRuntimePreferredTabWidth(160.0, YES);
    CGFloat ghostWidth =
        RionRuntimeTabsWidthWithExternalGhost(400.0, 3, 144.0);
    CGFloat trailingControlOrigin = RionRuntimeTrailingControlOriginX(
        640.0, NSMakeRect(180.0, 0.0, 144.0, kRionTabHeight), YES);
    CGFloat shortWindowNameWidth = RionRuntimeWindowNameWidth(96.0);
    CGFloat longWindowNameWidth = RionRuntimeWindowNameWidth(420.0);
    CGFloat minimumWindowTabsWidth =
        640.0 - kRionTrafficLightFallbackWidth - kRionRootLeadingInset -
        longWindowNameWidth - kRionWindowNameTrailingSpacing -
        kRionRootTrailingDraggableWidth - kRionTabHeight -
        kRionAddButtonSpacing;
    NSRect controlRow = NSMakeRect(-120.0, 80.0, 640.0, kRionTitlebarHeight);
    return !RionRuntimeTabsOverflow(400.5, 400.0) &&
           RionRuntimeTabsOverflow(402.0, 400.0) &&
           RionRuntimeClampScrollOrigin(-20.0, 900.0, 400.0) == 0.0 &&
           RionRuntimeClampScrollOrigin(700.0, 900.0, 400.0) == 500.0 &&
           RionRuntimeRevealScrollOrigin(620.0, 760.0, 100.0, 400.0,
                                         900.0) == 360.0 &&
           hiddenWidth < visibleWidth &&
           ghostWidth == 550.0 &&
           trailingControlOrigin == 332.0 &&
           RionRuntimeTrailingControlOriginX(
               640.0, NSMakeRect(180.0, 0.0, 144.0, kRionTabHeight), NO) ==
               640.0 &&
           shortWindowNameWidth == kRionWindowNameMinimumWidth &&
           longWindowNameWidth == kRionWindowNameMaximumWidth &&
           minimumWindowTabsWidth > kRionTabMinimumWidth &&
           kRionTitlebarHeight == 40.0 &&
           RionRuntimePointInHalfOpenRect(NSMakePoint(-120.0, 80.0),
                                          controlRow) &&
           RionRuntimePointInHalfOpenRect(NSMakePoint(519.99, 119.99),
                                          controlRow) &&
           !RionRuntimePointInHalfOpenRect(NSMakePoint(-120.01, 80.0),
                                           controlRow) &&
           !RionRuntimePointInHalfOpenRect(NSMakePoint(520.0, 80.0),
                                           controlRow) &&
           !RionRuntimePointInHalfOpenRect(NSMakePoint(-120.0, 79.99),
                                           controlRow) &&
           !RionRuntimePointInHalfOpenRect(NSMakePoint(-120.0, 120.0),
                                           controlRow) &&
           RionRuntimeDragScrollDelta(50.0, 0.0, 200.0, 36.0) == 0.0 &&
           RionRuntimeDragScrollDelta(1.0, 0.0, 200.0, 36.0) == -16.0 &&
           RionRuntimeDragScrollDelta(199.0, 0.0, 200.0, 36.0) == 16.0;
  }
}

bool rion_runtime_tabs_drag_hysteresis_self_test(void) {
  @autoreleasepool {
    NSArray<NSNumber *> *midpoints = @[ @50.0, @150.0, @250.0 ];
    NSArray<NSNumber *> *widths = @[ @100.0, @100.0, @100.0 ];
    NSRect originalFrame = NSMakeRect(-140.0, 480.0, 180.0, 28.0);
    NSRect sourceLockedFrame =
        RionRuntimeDragFrameWithLockedY(originalFrame, 720.0);
    NSRect targetLockedFrame =
        RionRuntimeDragFrameWithLockedY(sourceLockedFrame, 220.0);
    NSImage *dragImage = RionRuntimeTransparentDragImage();
    NSBitmapImageRep *dragRepresentation =
        (NSBitmapImageRep *)dragImage.representations.firstObject;
    NSColor *dragPixel = [dragRepresentation colorAtX:0 y:0];
    NSArray<NSString *> *payloadParts = RionRuntimeTabDragPayloadParts(
        RionRuntimeTabDragPayload(@"window-a", @"tab-a", @"session-a",
                                  NSMakePoint(0.5, 0.5),
                                  NSMakeSize(180.0, 28.0)));
    BOOL resolvesRight = NO;
    BOOL resolvesLeft = NO;
    BOOL resolvesStationary = YES;
    CGFloat rightProbe = RionRuntimeDirectionalInsertionProbeX(
        10.0, 110.0, 60.0, 1.0, &resolvesRight);
    CGFloat leftProbe = RionRuntimeDirectionalInsertionProbeX(
        10.0, 110.0, 60.0, -1.0, &resolvesLeft);
    CGFloat stationaryProbe = RionRuntimeDirectionalInsertionProbeX(
        10.0, 110.0, 60.0, 0.0, &resolvesStationary);
    return RionRuntimeTabReorderHysteresis(100.0) == 3.0 &&
           RionRuntimeTabReorderHysteresis(280.0) == 5.0 &&
           RionRuntimeTabInsertionProbeX(80.0, 100.0, 0.2) == 110.0 &&
           RionRuntimeTabInsertionProbeX(110.0, 100.0, 0.5) == 110.0 &&
           RionRuntimeTabInsertionProbeX(140.0, 100.0, 0.8) == 110.0 &&
           resolvesRight && rightProbe == 110.0 &&
           resolvesLeft && leftProbe == 10.0 &&
           !resolvesStationary && stationaryProbe == 60.0 &&
           payloadParts.count == 7 &&
           [payloadParts[3] isEqualToString:@"0.5"] &&
           [payloadParts[4] isEqualToString:@"0.5"] &&
           [payloadParts[5] isEqualToString:@"180"] &&
           [payloadParts[6] isEqualToString:@"28"] &&
           RionRuntimeStableInsertionIndex(52.0, midpoints, widths, 0) == 0 &&
           RionRuntimeStableInsertionIndex(54.0, midpoints, widths, 0) == 1 &&
           RionRuntimeStableInsertionIndex(48.0, midpoints, widths, 1) == 1 &&
           RionRuntimeStableInsertionIndex(46.0, midpoints, widths, 1) == 0 &&
           RionRuntimeStableInsertionIndex(300.0, midpoints, widths, 0) == 3 &&
           sourceLockedFrame.origin.x == originalFrame.origin.x &&
           sourceLockedFrame.origin.y == 720.0 &&
           NSEqualSizes(sourceLockedFrame.size, originalFrame.size) &&
           targetLockedFrame.origin.x == originalFrame.origin.x &&
           targetLockedFrame.origin.y == 220.0 &&
           NSEqualSizes(targetLockedFrame.size, originalFrame.size) &&
           NSEqualSizes(dragImage.size, NSMakeSize(1.0, 1.0)) &&
           [dragRepresentation isKindOfClass:NSBitmapImageRep.class] &&
           dragPixel.alphaComponent == 0.0;
  }
}

static NSEventModifierFlags RionRuntimeShortcutModifierFlagForKeyCode(
    unsigned short keyCode) {
  switch (keyCode) {
    case 56:  // Left Shift
    case 60:  // Right Shift
      return NSEventModifierFlagShift;
    case 59:  // Left Control
    case 62:  // Right Control
      return NSEventModifierFlagControl;
    default:
      return 0;
  }
}

static NSEventModifierFlags RionRuntimePendingShortcutModifiersAfterEvent(
    NSEventModifierFlags pending, NSEvent *event) {
  NSEventModifierFlags changed =
      RionRuntimeShortcutModifierFlagForKeyCode(event.keyCode);
  if ((pending & changed) == 0) return pending;
  NSEventModifierFlags active = event.modifierFlags &
      (NSEventModifierFlagControl | NSEventModifierFlagShift);
  return pending & active;
}

static BOOL RionRuntimeRelayShortcutModifierEvent(
    NSResponder *origin, NSResponder *current, NSEventModifierFlags pending,
    NSEvent *event) {
  NSEventModifierFlags changed =
      RionRuntimeShortcutModifierFlagForKeyCode(event.keyCode);
  if ((pending & changed) == 0 || !origin || origin == current) return NO;
  [origin flagsChanged:event];
  return YES;
}

@interface RionRuntimeShortcutResponderProbe : NSResponder

@property(nonatomic) NSUInteger flagsChangedCount;
@property(nonatomic) unsigned short lastKeyCode;

@end


@implementation RionRuntimeShortcutResponderProbe

- (void)flagsChanged:(NSEvent *)event {
  self.flagsChangedCount += 1;
  self.lastKeyCode = event.keyCode;
}

@end


bool rion_runtime_tabs_shortcut_self_test(void) {
  @autoreleasepool {
    NSEventModifierFlags control = NSEventModifierFlagControl;
    NSEventModifierFlags shift = NSEventModifierFlagShift;
    NSEventModifierFlags command = NSEventModifierFlagCommand;
    NSEventModifierFlags option = NSEventModifierFlagOption;
    NSEventModifierFlags mask = NSEventModifierFlagDeviceIndependentFlagsMask;
    auto accepts = ^BOOL(unsigned short keyCode, NSEventModifierFlags flags) {
      flags &= mask;
      return keyCode == 48 && (flags & control) != 0 &&
          (flags & (command | option | NSEventModifierFlagFunction)) == 0;
    };
    NSEvent *shiftRelease = [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                                            location:NSZeroPoint
                                       modifierFlags:control
                                           timestamp:0
                                        windowNumber:0
                                             context:nil
                                          characters:@""
                         charactersIgnoringModifiers:@""
                                           isARepeat:NO
                                             keyCode:60];
    NSEvent *controlRelease = [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                                              location:NSZeroPoint
                                         modifierFlags:0
                                             timestamp:0
                                          windowNumber:0
                                               context:nil
                                            characters:@""
                           charactersIgnoringModifiers:@""
                                             isARepeat:NO
                                               keyCode:62];
    RionRuntimeShortcutResponderProbe *probe =
        [[RionRuntimeShortcutResponderProbe alloc] init];
    RionRuntimeShortcutResponderProbe *current =
        [[RionRuntimeShortcutResponderProbe alloc] init];
    BOOL relayed = RionRuntimeRelayShortcutModifierEvent(
        probe, current, control | shift, shiftRelease);
    BOOL duplicate = RionRuntimeRelayShortcutModifierEvent(
        probe, probe, control | shift, controlRelease);
    NSEventModifierFlags pending =
        RionRuntimePendingShortcutModifiersAfterEvent(control | shift,
                                                       shiftRelease);
    pending = RionRuntimePendingShortcutModifiersAfterEvent(
        pending, controlRelease);
    return accepts(48, control) && accepts(48, control | shift) &&
        !accepts(48, command) && !accepts(48, control | option) &&
        !accepts(49, control) &&
        RionRuntimeShortcutModifierFlagForKeyCode(59) == control &&
        RionRuntimeShortcutModifierFlagForKeyCode(62) == control &&
        RionRuntimeShortcutModifierFlagForKeyCode(56) == shift &&
        RionRuntimeShortcutModifierFlagForKeyCode(60) == shift &&
        RionRuntimeShortcutModifierFlagForKeyCode(58) == 0 &&
        relayed && !duplicate && probe.flagsChangedCount == 1 &&
        probe.lastKeyCode == 60 &&
        pending == 0;
  }
}

@interface RionRuntimeBackdropView : NSVisualEffectView
@end

@interface RionRuntimeVerticallyCenteredTextFieldCell : NSTextFieldCell
@end

@interface RionRuntimeHorizontalScrollView : NSScrollView
@end

@interface RionRuntimeWindowNameField : NSTextField
@end

@interface RionRuntimeSurfaceView : NSView

@property(nonatomic, strong, readonly) NSView *contentView;

- (instancetype)initWithContentView:(NSView *)contentView
                       cornerRadius:(CGFloat)cornerRadius;
- (void)updateActive:(BOOL)active
             hovered:(BOOL)hovered
        windowActive:(BOOL)windowActive
             animate:(BOOL)animate;

@end

@interface RionRuntimeTabItemView : NSControl <NSDraggingSource>

@property(nonatomic) BOOL activeTab;
@property(nonatomic) BOOL tabDropHandled;
@property(nonatomic, copy) NSString *dragSessionID;
@property(nonatomic, copy) NSString *sourceWindowID;
@property(nonatomic, weak) RionRuntimeSurfaceView *surfaceView;
@property(nonatomic, weak) RionRuntimeTabsController *tabsController;
@property(nonatomic, copy) NSString *tabIdentifier;
@property(nonatomic, readonly) CGFloat preferredWidth;
@property(nonatomic, readonly) NSPoint grabRatio;

- (void)configureWithTab:(RionRuntimeTabModel *)tab
                    image:(NSImage *)image
      hideTabCloseButton:(BOOL)hideTabCloseButton
               closeLabel:(NSString *)closeLabel
        audioPlayingLabel:(NSString *)audioPlayingLabel
           audioMutedLabel:(NSString *)audioMutedLabel
             windowActive:(BOOL)windowActive;
- (void)updateWindowActive:(BOOL)windowActive;
- (void)updateVisualStateAnimated:(BOOL)animate;
- (void)beginDragPreviewSession:(NSDraggingSession *)session
                  lockedScreenY:(CGFloat)screenY;
- (void)lockDragPreviewToScreenY:(CGFloat)screenY;
- (void)clearDragPreviewYLock;

@end

@interface RionRuntimeAddButton : NSButton

@property(nonatomic, weak) RionRuntimeSurfaceView *surfaceView;

@end

@interface RionRuntimeTabsRootView : RionRuntimeDraggableView
    <NSDraggingDestination>

@property(nonatomic, weak) RionRuntimeTabsController *tabsController;

@end

@interface RionRuntimeTitlebarAccessoryViewController
    : NSTitlebarAccessoryViewController

@property(nonatomic, copy, nullable) dispatch_block_t appearanceHandler;

@end

@interface RionRuntimeTabsController () <NSToolbarDelegate>

@property(nonatomic, readwrite) BOOL alwaysShowInFullScreen;
@property(nonatomic, readwrite) BOOL revealLocked;

- (void)activateTab:(NSString *)tabIdentifier;
- (void)closeTab:(NSString *)tabIdentifier;
- (void)applyLiquidGlassTitlebarAppearance;
- (void)attachAccessoryController;
- (void)beginTabDrag:(RionRuntimeTabItemView *)item event:(NSEvent *)event;

NS_ASSUME_NONNULL_END
