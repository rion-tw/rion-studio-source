#include <algorithm>
#include <cmath>
#include <cstring>

#import <Carbon/Carbon.h>

static void RionAppendNativeViewTreeNode(
    NSView *view, uintptr_t parentAddress, uint32_t depth,
    RionAppKitNativeViewTreeNode *nodes, uintptr_t capacity,
    uintptr_t *visited) {
  if (!view || !visited || *visited > capacity) return;
  uintptr_t index = *visited;
  *visited = index + 1;
  if (index >= capacity) return;
  if (index < capacity && nodes) {
    RionAppKitNativeViewTreeNode *node = &nodes[index];
    std::memset(node, 0, sizeof(*node));
    node->address = reinterpret_cast<uintptr_t>((__bridge void *)view);
    node->parentAddress = parentAddress;
    node->depth = depth;
    node->hidden = view.hidden ? 1 : 0;
    node->acceptsFirstResponder = view.acceptsFirstResponder ? 1 : 0;
    node->attachedToWindow = view.window ? 1 : 0;
    NSRect frame = view.frame;
    node->x = frame.origin.x;
    node->y = frame.origin.y;
    node->width = frame.size.width;
    node->height = frame.size.height;
    const char *className = NSStringFromClass(view.class).UTF8String;
    if (className) {
      std::strncpy(node->className, className,
                   RION_APPKIT_VIEW_CLASS_NAME_CAPACITY - 1);
      node->className[RION_APPKIT_VIEW_CLASS_NAME_CAPACITY - 1] = '\0';
    }
  }
  // A Chromium surface tree is shallow. Refuse unbounded native recursion even
  // if a future embedder produces a malformed or adversarial hierarchy.
  if (depth >= 64) {
    *visited = capacity + 1;
    return;
  }
  uintptr_t address = reinterpret_cast<uintptr_t>((__bridge void *)view);
  for (NSView *child in view.subviews) {
    RionAppendNativeViewTreeNode(child, address, depth + 1, nodes, capacity,
                                 visited);
    if (*visited > capacity) break;
  }
}

extern "C" int32_t rion_appkit_snapshot_native_view_tree(
    void *nativeView, RionAppKitNativeViewTreeNode *nodes, uintptr_t capacity,
    uintptr_t *count, bool *truncated) {
  if (count) *count = 0;
  if (truncated) *truncated = false;
  if (!nativeView || !count || !truncated || (capacity > 0 && !nodes)) return 1;
  if (!NSThread.isMainThread) return 2;
  NSView *root = (__bridge NSView *)nativeView;
  if (!root.window) return 3;
  uintptr_t visited = 0;
  RionAppendNativeViewTreeNode(root, 0, 0, nodes, capacity, &visited);
  *count = std::min(visited, capacity);
  *truncated = visited > capacity;
  return 0;
}

static NSView *RionFindNativeViewWithAddressBounded(
    NSView *root, uintptr_t targetAddress, uint32_t depth,
    uintptr_t *visited) {
  if (!root || targetAddress == 0 || !visited || *visited >= 512 || depth > 64)
    return nil;
  *visited += 1;
  if (reinterpret_cast<uintptr_t>((__bridge void *)root) == targetAddress) {
    return root;
  }
  for (NSView *child in root.subviews) {
    NSView *match = RionFindNativeViewWithAddressBounded(
        child, targetAddress, depth + 1, visited);
    if (match) return match;
  }
  return nil;
}

static NSView *RionFindNativeViewWithAddress(NSView *root,
                                             uintptr_t targetAddress) {
  uintptr_t visited = 0;
  return RionFindNativeViewWithAddressBounded(
      root, targetAddress, 0, &visited);
}

static NSNumber *RionChromiumVirtualKeyCode(NSString *code) {
  static NSDictionary<NSString *, NSNumber *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = @{
      @"KeyA": @(kVK_ANSI_A), @"KeyS": @(kVK_ANSI_S),
      @"KeyD": @(kVK_ANSI_D), @"KeyF": @(kVK_ANSI_F),
      @"KeyH": @(kVK_ANSI_H), @"KeyG": @(kVK_ANSI_G),
      @"KeyZ": @(kVK_ANSI_Z), @"KeyX": @(kVK_ANSI_X),
      @"KeyC": @(kVK_ANSI_C), @"KeyV": @(kVK_ANSI_V),
      @"KeyB": @(kVK_ANSI_B), @"KeyQ": @(kVK_ANSI_Q),
      @"KeyW": @(kVK_ANSI_W), @"KeyE": @(kVK_ANSI_E),
      @"KeyR": @(kVK_ANSI_R), @"KeyY": @(kVK_ANSI_Y),
      @"KeyT": @(kVK_ANSI_T), @"Digit1": @(kVK_ANSI_1),
      @"Digit2": @(kVK_ANSI_2), @"Digit3": @(kVK_ANSI_3),
      @"Digit4": @(kVK_ANSI_4), @"Digit6": @(kVK_ANSI_6),
      @"Digit5": @(kVK_ANSI_5), @"Equal": @(kVK_ANSI_Equal),
      @"Digit9": @(kVK_ANSI_9), @"Digit7": @(kVK_ANSI_7),
      @"Minus": @(kVK_ANSI_Minus), @"Digit8": @(kVK_ANSI_8),
      @"Digit0": @(kVK_ANSI_0), @"BracketRight": @(kVK_ANSI_RightBracket),
      @"KeyO": @(kVK_ANSI_O), @"KeyU": @(kVK_ANSI_U),
      @"BracketLeft": @(kVK_ANSI_LeftBracket), @"KeyI": @(kVK_ANSI_I),
      @"KeyP": @(kVK_ANSI_P), @"Enter": @(kVK_Return),
      @"KeyL": @(kVK_ANSI_L), @"KeyJ": @(kVK_ANSI_J),
      @"Quote": @(kVK_ANSI_Quote), @"KeyK": @(kVK_ANSI_K),
      @"Semicolon": @(kVK_ANSI_Semicolon),
      @"Backslash": @(kVK_ANSI_Backslash), @"Comma": @(kVK_ANSI_Comma),
      @"Slash": @(kVK_ANSI_Slash), @"KeyN": @(kVK_ANSI_N),
      @"KeyM": @(kVK_ANSI_M), @"Period": @(kVK_ANSI_Period),
      @"Tab": @(kVK_Tab), @"Space": @(kVK_Space),
      @"Backquote": @(kVK_ANSI_Grave), @"Backspace": @(kVK_Delete),
      @"Escape": @(kVK_Escape), @"F17": @(kVK_F17),
      @"F18": @(kVK_F18), @"F19": @(kVK_F19), @"F20": @(kVK_F20),
      @"F5": @(kVK_F5), @"F6": @(kVK_F6), @"F7": @(kVK_F7),
      @"F3": @(kVK_F3), @"F8": @(kVK_F8), @"F9": @(kVK_F9),
      @"F11": @(kVK_F11), @"F13": @(kVK_F13), @"F16": @(kVK_F16),
      @"F14": @(kVK_F14), @"F10": @(kVK_F10), @"F12": @(kVK_F12),
      @"F15": @(kVK_F15), @"Insert": @(kVK_Help),
      @"Home": @(kVK_Home), @"PageUp": @(kVK_PageUp),
      @"Delete": @(kVK_ForwardDelete), @"F4": @(kVK_F4),
      @"End": @(kVK_End), @"F2": @(kVK_F2),
      @"PageDown": @(kVK_PageDown), @"F1": @(kVK_F1),
      @"ArrowLeft": @(kVK_LeftArrow), @"ArrowRight": @(kVK_RightArrow),
      @"ArrowDown": @(kVK_DownArrow), @"ArrowUp": @(kVK_UpArrow)
    };
  });
  return codes[code];
}

static NSString *RionChromiumFunctionCharacter(unichar value) {
  return [NSString stringWithCharacters:&value length:1];
}

static NSString *RionChromiumBaseCharacter(NSString *code) {
  if ([code hasPrefix:@"Key"] && code.length == 4) {
    return [code substringFromIndex:3].lowercaseString;
  }
  if ([code hasPrefix:@"Digit"] && code.length == 6) {
    return [code substringFromIndex:5];
  }
  NSDictionary<NSString *, NSString *> *characters = @{
    @"Backquote": @"`", @"Equal": @"=", @"Minus": @"-",
    @"BracketRight": @"]", @"BracketLeft": @"[", @"Quote": @"'",
    @"Semicolon": @";", @"Backslash": @"\\", @"Comma": @",",
    @"Slash": @"/", @"Period": @".", @"Tab": @"\t", @"Space": @" ",
    @"Enter": @"\r", @"Backspace": @"\x7f", @"Escape": @"\x1b"
  };
  NSString *character = characters[code];
  if (character) return character;
  if ([code hasPrefix:@"F"] && code.length >= 2) {
    NSInteger number = [[code substringFromIndex:1] integerValue];
    if (number >= 1 && number <= 35) {
      return RionChromiumFunctionCharacter(
          (unichar)(NSF1FunctionKey + number - 1));
    }
  }
  NSDictionary<NSString *, NSNumber *> *functions = @{
    @"ArrowUp": @(NSUpArrowFunctionKey),
    @"ArrowDown": @(NSDownArrowFunctionKey),
    @"ArrowLeft": @(NSLeftArrowFunctionKey),
    @"ArrowRight": @(NSRightArrowFunctionKey),
    @"Insert": @(NSInsertFunctionKey), @"Delete": @(NSDeleteFunctionKey),
    @"Home": @(NSHomeFunctionKey), @"End": @(NSEndFunctionKey),
    @"PageUp": @(NSPageUpFunctionKey), @"PageDown": @(NSPageDownFunctionKey)
  };
  NSNumber *function = functions[code];
  return function
      ? RionChromiumFunctionCharacter(function.unsignedShortValue)
      : nil;
}

static NSString *RionChromiumShiftedCharacter(NSString *code,
                                               NSString *base) {
  if ([code hasPrefix:@"Key"]) return base.uppercaseString;
  NSDictionary<NSString *, NSString *> *shifted = @{
    @"Digit1": @"!", @"Digit2": @"@", @"Digit3": @"#",
    @"Digit4": @"$", @"Digit5": @"%", @"Digit6": @"^",
    @"Digit7": @"&", @"Digit8": @"*", @"Digit9": @"(",
    @"Digit0": @")", @"Backquote": @"~", @"Equal": @"+",
    @"Minus": @"_", @"BracketRight": @"}", @"BracketLeft": @"{",
    @"Quote": @"\"", @"Semicolon": @":", @"Backslash": @"|",
    @"Comma": @"<", @"Slash": @"?", @"Period": @">"
  };
  return shifted[code] ?: base;
}

static void RionCollectChromiumRendererTargets(
    NSView *view, uint32_t depth, uintptr_t *visited,
    NSMutableArray<NSView *> *matches) {
  if (!view || !visited || *visited >= 512 || depth > 64) return;
  *visited += 1;
  if ([NSStringFromClass(view.class)
          isEqualToString:@"RenderWidgetHostViewCocoa"] &&
      view.acceptsFirstResponder && view.window) {
    [matches addObject:view];
  }
  for (NSView *child in view.subviews) {
    RionCollectChromiumRendererTargets(child, depth + 1, visited, matches);
  }
}

extern "C" int32_t rion_appkit_dispatch_chromium_key(
    void *nativeView, uintptr_t webContentsRootAddress, const char *rawCode,
    bool keyDown, uint64_t modifierFlags, bool repeat,
    RionAppKitChromiumKeyDispatchResult *result) {
  if (result) std::memset(result, 0, sizeof(*result));
  if (!nativeView || webContentsRootAddress == 0 || !rawCode || !result)
    return 1;
  if (!NSThread.isMainThread) return 2;
  NSView *root = (__bridge NSView *)nativeView;
  NSWindow *targetWindow = root.window;
  if (!targetWindow) return 3;
  NSView *webContentsRoot =
      RionFindNativeViewWithAddress(root, webContentsRootAddress);
  if (!webContentsRoot || webContentsRoot.window != targetWindow ||
      ![NSStringFromClass(webContentsRoot.class)
          isEqualToString:@"WebContentsViewCocoa"])
    return 4;
  NSMutableArray<NSView *> *targets = [NSMutableArray arrayWithCapacity:1];
  uintptr_t visited = 0;
  RionCollectChromiumRendererTargets(webContentsRoot, 0, &visited, targets);
  if (targets.count != 1) return 9;
  NSView *target = targets.firstObject;
  NSString *code = [NSString stringWithUTF8String:rawCode];
  NSNumber *virtualCode = code ? RionChromiumVirtualKeyCode(code) : nil;
  NSString *base = code ? RionChromiumBaseCharacter(code) : nil;
  // A function character without a native scan code is not a dispatchable
  // DOM code on macOS. In particular, Chromium declares no macOS native code
  // for F21-F24; messaging nil would otherwise collapse to keyCode 0 (KeyA).
  if (!code || !virtualCode || !base) return 8;

  NSWindow *keyWindow = NSApp.keyWindow;
  id keyWindowFirstResponder = keyWindow.firstResponder;
  id targetFirstResponder = targetWindow.firstResponder;
  result->targetAttached = 1;
  @try {
    NSEventModifierFlags flags = (NSEventModifierFlags)modifierFlags;
    if ([code hasPrefix:@"F"] || [code hasPrefix:@"Arrow"] ||
        [@[@"Insert", @"Delete", @"Home", @"End", @"PageUp", @"PageDown"]
            containsObject:code]) {
      flags |= NSEventModifierFlagFunction;
    }
    NSString *characters = base ?: @"";
    if ((flags & NSEventModifierFlagShift) != 0) {
      characters = RionChromiumShiftedCharacter(code, characters);
    }
    NSEventType type = keyDown ? NSEventTypeKeyDown : NSEventTypeKeyUp;
    NSEvent *event = [NSEvent keyEventWithType:type
                                      location:NSZeroPoint
                                 modifierFlags:flags
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:targetWindow.windowNumber
                                       context:nil
                                    characters:characters
                   charactersIgnoringModifiers:base ?: @""
                                     isARepeat:repeat
                                       keyCode:virtualCode.unsignedShortValue];
    if (!event) return 5;
    if (keyDown) {
      [target keyDown:event];
    } else {
      [target keyUp:event];
    }
    result->dispatchedEventCount = 1;
    result->virtualKeyCode = virtualCode.unsignedShortValue;
    result->modifierFlags = flags;
    NSRect targetBounds = target.bounds;
    result->targetX = targetBounds.origin.x;
    result->targetY = targetBounds.origin.y;
    result->targetWidth = targetBounds.size.width;
    result->targetHeight = targetBounds.size.height;
  } @catch (__unused NSException *exception) {
    return 6;
  }
  result->focusNeutral = NSApp.keyWindow == keyWindow &&
      keyWindow.firstResponder == keyWindowFirstResponder &&
      targetWindow.firstResponder == targetFirstResponder;
  result->keyWindowPreserved = NSApp.keyWindow == keyWindow;
  result->keyWindowFirstResponderPreserved =
      keyWindow.firstResponder == keyWindowFirstResponder;
  result->targetFirstResponderPreserved =
      targetWindow.firstResponder == targetFirstResponder;
  return 0;
}

static NSEvent *RionCreateChromiumMouseEvent(
    NSEventType type, NSPoint windowPoint, NSInteger windowNumber,
    uint8_t button, NSEventModifierFlags modifierFlags,
    NSTimeInterval timestamp, CGFloat pressure) {
  NSEvent *event = [NSEvent mouseEventWithType:type
                                      location:windowPoint
                                 modifierFlags:modifierFlags
                                     timestamp:timestamp
                                  windowNumber:windowNumber
                                       context:nil
                                   eventNumber:0
                                    clickCount:1
                                      pressure:pressure];
  if (!event) return nil;
  CGEventRef cgEvent = event.CGEvent;
  if (!cgEvent) return nil;
  // DOM and Chromium number auxiliary buttons as middle=1/right=2, while
  // AppKit's CGEvent ABI uses right=1/center=2. NSEventTypeOtherMouse* alone
  // does not carry the center-button identity Chromium requires.
  const CGMouseButton nativeButton =
      button == 1 ? kCGMouseButtonCenter
                  : button == 2 ? kCGMouseButtonRight
                                : kCGMouseButtonLeft;
  CGEventSetIntegerValueField(
      cgEvent, kCGMouseEventButtonNumber, (int64_t)nativeButton);
  return [NSEvent eventWithCGEvent:cgEvent];
}

extern "C" int32_t rion_appkit_dispatch_chromium_mouse(
    void *nativeView, uintptr_t webContentsRootAddress, double clientX,
    double clientY, double zoomFactor, uint8_t button, uint64_t modifierFlags,
    RionAppKitChromiumMouseDispatchResult *result) {
  if (result) std::memset(result, 0, sizeof(*result));
  if (!nativeView || webContentsRootAddress == 0 || !result || button > 2 ||
      !std::isfinite(clientX) || !std::isfinite(clientY) ||
      !std::isfinite(zoomFactor) || zoomFactor < 0.25 || zoomFactor > 5.0)
    return 1;
  if (!NSThread.isMainThread) return 2;
  NSView *root = (__bridge NSView *)nativeView;
  NSWindow *targetWindow = root.window;
  if (!targetWindow) return 3;
  NSView *webContentsRoot =
      RionFindNativeViewWithAddress(root, webContentsRootAddress);
  if (!webContentsRoot || webContentsRoot.window != targetWindow ||
      ![NSStringFromClass(webContentsRoot.class)
          isEqualToString:@"WebContentsViewCocoa"])
    return 4;
  NSMutableArray<NSView *> *targets = [NSMutableArray arrayWithCapacity:1];
  uintptr_t visited = 0;
  RionCollectChromiumRendererTargets(webContentsRoot, 0, &visited, targets);
  if (targets.count != 1) return 9;
  NSView *target = targets.firstObject;
  NSRect targetBounds = target.bounds;
  if (!std::isfinite(targetBounds.origin.x) ||
      !std::isfinite(targetBounds.origin.y) ||
      !std::isfinite(targetBounds.size.width) ||
      !std::isfinite(targetBounds.size.height) ||
      targetBounds.size.width <= 0 || targetBounds.size.height <= 0)
    return 7;
  // The renderer receipt contract is surface-local integer Chromium CSS
  // pixels. AppKit consumes logical view points: page zoom is the only scale
  // in this conversion. NSView/window coordinates already abstract Retina's
  // backing pixels, and convertPoint applies every parent/slot offset.
  double canonicalClientX = std::floor(clientX);
  double canonicalClientY = std::floor(clientY);
  if (canonicalClientX != clientX || canonicalClientY != clientY) return 1;
  double appKitOffsetX = canonicalClientX * zoomFactor;
  double appKitOffsetY = canonicalClientY * zoomFactor;
  if (!std::isfinite(appKitOffsetX) || !std::isfinite(appKitOffsetY) ||
      appKitOffsetX < 0 || appKitOffsetY < 0 ||
      appKitOffsetX >= targetBounds.size.width ||
      appKitOffsetY >= targetBounds.size.height)
    return 7;

  NSWindow *keyWindow = NSApp.keyWindow;
  id keyWindowFirstResponder = keyWindow.firstResponder;
  id targetFirstResponder = targetWindow.firstResponder;
  result->targetAttached = 1;
  @try {
    NSEventType downType = button == 0   ? NSEventTypeLeftMouseDown
                           : button == 1 ? NSEventTypeOtherMouseDown
                                         : NSEventTypeRightMouseDown;
    NSEventType upType = button == 0   ? NSEventTypeLeftMouseUp
                         : button == 1 ? NSEventTypeOtherMouseUp
                                       : NSEventTypeRightMouseUp;
    CGFloat localY = target.isFlipped
        ? NSMinY(targetBounds) + appKitOffsetY
        : NSMaxY(targetBounds) - appKitOffsetY;
    NSPoint localPoint =
        NSMakePoint(NSMinX(targetBounds) + appKitOffsetX, localY);
    NSPoint windowPoint = [target convertPoint:localPoint toView:nil];
    if (!std::isfinite(windowPoint.x) || !std::isfinite(windowPoint.y)) return 7;
    NSTimeInterval timestamp = NSProcessInfo.processInfo.systemUptime;
    NSEventModifierFlags flags = (NSEventModifierFlags)modifierFlags;
    NSEvent *down = RionCreateChromiumMouseEvent(
        downType, windowPoint, targetWindow.windowNumber, button, flags,
        timestamp, 1.0);
    NSEvent *up = RionCreateChromiumMouseEvent(
        upType, windowPoint, targetWindow.windowNumber, button, flags,
        timestamp, 0.0);
    if (!down || !up) return 5;
    if (button == 0) {
      [target mouseDown:down];
      [target mouseUp:up];
    } else if (button == 1) {
      [target otherMouseDown:down];
      [target otherMouseUp:up];
    } else {
      [target rightMouseDown:down];
      [target rightMouseUp:up];
    }
    result->dispatchedEventCount = 2;
    result->button = button;
    result->modifierFlags = flags;
    result->clientX = canonicalClientX;
    result->clientY = canonicalClientY;
    result->zoomFactor = zoomFactor;
    result->appKitPointX = localPoint.x;
    result->appKitPointY = localPoint.y;
    result->windowPointX = windowPoint.x;
    result->windowPointY = windowPoint.y;
    result->targetFlipped = target.isFlipped ? 1 : 0;
    result->targetX = targetBounds.origin.x;
    result->targetY = targetBounds.origin.y;
    result->targetWidth = targetBounds.size.width;
    result->targetHeight = targetBounds.size.height;
  } @catch (__unused NSException *exception) {
    return 6;
  }
  result->focusNeutral = NSApp.keyWindow == keyWindow &&
      keyWindow.firstResponder == keyWindowFirstResponder &&
      targetWindow.firstResponder == targetFirstResponder;
  result->keyWindowPreserved = NSApp.keyWindow == keyWindow;
  result->keyWindowFirstResponderPreserved =
      keyWindow.firstResponder == keyWindowFirstResponder;
  result->targetFirstResponderPreserved =
      targetWindow.firstResponder == targetFirstResponder;
  return 0;
}

extern "C" int32_t rion_appkit_probe_dispatch_key(
    void *nativeView, uintptr_t targetAddress, uint16_t keyCode,
    const char *characters, uint64_t modifierFlags, uint8_t dispatchMode,
    RionAppKitKeyDispatchProbeResult *result) {
  if (result) std::memset(result, 0, sizeof(*result));
  if (!nativeView || targetAddress == 0 || !characters || !result ||
      dispatchMode > 3)
    return 1;
  if (!NSThread.isMainThread) return 2;
  NSView *root = (__bridge NSView *)nativeView;
  NSWindow *targetWindow = root.window;
  if (!targetWindow) return 3;
  NSView *target = RionFindNativeViewWithAddress(root, targetAddress);
  if (!target || target.window != targetWindow) return 4;
  NSString *text = [NSString stringWithUTF8String:characters];
  if (!text || text.length == 0) return 1;

  NSWindow *keyWindow = NSApp.keyWindow;
  id keyWindowFirstResponder = keyWindow.firstResponder;
  id targetFirstResponder = targetWindow.firstResponder;
  result->targetAttached = 1;
  @try {
    NSTimeInterval timestamp = NSProcessInfo.processInfo.systemUptime;
    NSEventModifierFlags flags = (NSEventModifierFlags)modifierFlags;
    NSEvent *down = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                     location:NSZeroPoint
                                modifierFlags:flags
                                    timestamp:timestamp
                                 windowNumber:targetWindow.windowNumber
                                      context:nil
                                   characters:text
                  charactersIgnoringModifiers:text
                                    isARepeat:NO
                                      keyCode:keyCode];
    NSEvent *up = [NSEvent keyEventWithType:NSEventTypeKeyUp
                                   location:NSZeroPoint
                              modifierFlags:flags
                                  timestamp:timestamp
                               windowNumber:targetWindow.windowNumber
                                    context:nil
                                 characters:text
                charactersIgnoringModifiers:text
                                  isARepeat:NO
                                    keyCode:keyCode];
    if (!down || !up) return 5;
    BOOL temporaryKeyWindow = dispatchMode >= 2;
    BOOL routeThroughWindow = (dispatchMode % 2) == 1;
    if (temporaryKeyWindow) {
      [targetWindow makeFirstResponder:target];
      [targetWindow makeKeyWindow];
    }
    if (routeThroughWindow) {
      [targetWindow sendEvent:down];
      [targetWindow sendEvent:up];
    } else {
      [target keyDown:down];
      [target keyUp:up];
    }
    if (temporaryKeyWindow) {
      [targetWindow makeFirstResponder:targetFirstResponder];
      if (keyWindow && keyWindow != targetWindow) {
        [keyWindow makeKeyWindow];
        [keyWindow makeFirstResponder:keyWindowFirstResponder];
      } else if (!keyWindow) {
        [targetWindow resignKeyWindow];
      }
    }
    result->dispatched = 1;
  } @catch (__unused NSException *exception) {
    return 6;
  }
  result->keyWindowPreserved = NSApp.keyWindow == keyWindow;
  result->keyWindowFirstResponderPreserved =
      keyWindow.firstResponder == keyWindowFirstResponder;
  result->targetFirstResponderPreserved =
      targetWindow.firstResponder == targetFirstResponder;
  return 0;
}

extern "C" int32_t rion_appkit_probe_dispatch_mouse(
    void *nativeView, uintptr_t targetAddress, double x, double y,
    uint8_t button, uint64_t modifierFlags,
    RionAppKitMouseDispatchProbeResult *result) {
  if (result) std::memset(result, 0, sizeof(*result));
  if (!nativeView || targetAddress == 0 || !result || button > 2 ||
      !std::isfinite(x) || !std::isfinite(y))
    return 1;
  if (!NSThread.isMainThread) return 2;
  NSView *root = (__bridge NSView *)nativeView;
  NSWindow *targetWindow = root.window;
  if (!targetWindow) return 3;
  NSView *target = RionFindNativeViewWithAddress(root, targetAddress);
  if (!target || target.window != targetWindow) return 4;
  NSPoint localPoint = NSMakePoint(x, y);
  if (!NSPointInRect(localPoint, target.bounds)) return 7;

  NSWindow *keyWindow = NSApp.keyWindow;
  id keyWindowFirstResponder = keyWindow.firstResponder;
  id targetFirstResponder = targetWindow.firstResponder;
  result->targetAttached = 1;
  @try {
    NSEventType downType = button == 0   ? NSEventTypeLeftMouseDown
                           : button == 1 ? NSEventTypeOtherMouseDown
                                         : NSEventTypeRightMouseDown;
    NSEventType upType = button == 0   ? NSEventTypeLeftMouseUp
                         : button == 1 ? NSEventTypeOtherMouseUp
                                       : NSEventTypeRightMouseUp;
    NSPoint windowPoint = [target convertPoint:localPoint toView:nil];
    NSTimeInterval timestamp = NSProcessInfo.processInfo.systemUptime;
    NSEventModifierFlags flags = (NSEventModifierFlags)modifierFlags;
    NSEvent *down = RionCreateChromiumMouseEvent(
        downType, windowPoint, targetWindow.windowNumber, button, flags,
        timestamp, 1.0);
    NSEvent *up = RionCreateChromiumMouseEvent(
        upType, windowPoint, targetWindow.windowNumber, button, flags,
        timestamp, 0.0);
    if (!down || !up) return 5;
    if (button == 0) {
      [target mouseDown:down];
      [target mouseUp:up];
    } else if (button == 1) {
      [target otherMouseDown:down];
      [target otherMouseUp:up];
    } else {
      [target rightMouseDown:down];
      [target rightMouseUp:up];
    }
    result->dispatched = 1;
  } @catch (__unused NSException *exception) {
    return 6;
  }
  result->keyWindowPreserved = NSApp.keyWindow == keyWindow;
  result->keyWindowFirstResponderPreserved =
      keyWindow.firstResponder == keyWindowFirstResponder;
  result->targetFirstResponderPreserved =
      targetWindow.firstResponder == targetFirstResponder;
  return 0;
}
