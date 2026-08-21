#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <math.h>

typedef struct {
  double content_height;
  double content_width;
  int64_t display_id;
  bool fullscreen;
  bool maximized;
  bool minimized;
  double outer_height;
  double outer_width;
  double outer_x;
  double outer_y;
  double scale_factor;
  double work_height;
  double work_width;
  double work_x;
  double work_y;
} RionDesktopE2EWindowSnapshot;

static CGFloat RionDesktopTop(void) {
  CGFloat top = 0.0;
  for (NSScreen *screen in NSScreen.screens) {
    top = MAX(top, NSMaxY(screen.frame));
  }
  return top;
}

static NSNumber *RionDesktopE2EKeyCode(NSString *code) {
  static NSDictionary<NSString *, NSNumber *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = @{
      @"KeyA": @0, @"KeyS": @1, @"KeyD": @2, @"KeyF": @3,
      @"KeyH": @4, @"KeyG": @5, @"KeyZ": @6, @"KeyX": @7,
      @"KeyC": @8, @"KeyV": @9, @"KeyB": @11, @"KeyQ": @12,
      @"KeyW": @13, @"KeyE": @14, @"KeyR": @15, @"KeyY": @16,
      @"KeyT": @17, @"Digit1": @18, @"Digit2": @19, @"Digit3": @20,
      @"Digit4": @21, @"Digit6": @22, @"Digit5": @23,
      @"Digit9": @25, @"Digit7": @26, @"Digit8": @28, @"Digit0": @29,
      @"KeyO": @31, @"KeyU": @32, @"KeyI": @34, @"KeyP": @35,
      @"KeyL": @37, @"KeyJ": @38, @"KeyK": @40, @"KeyN": @45,
      @"KeyM": @46, @"MetaRight": @54, @"MetaLeft": @55,
      @"ShiftLeft": @56, @"AltLeft": @58, @"ControlLeft": @59,
      @"ShiftRight": @60, @"AltRight": @61, @"ControlRight": @62,
      @"Enter": @36, @"Escape": @53, @"Tab": @48
    };
  });
  return codes[code];
}

static NSMutableSet<NSString *> *RionDesktopE2EHeldModifierCodes(void) {
  static NSMutableSet<NSString *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = [NSMutableSet set];
  });
  return codes;
}

static CGEventFlags RionDesktopE2EModifierFlag(NSString *code) {
  if ([code isEqualToString:@"ShiftLeft"] || [code isEqualToString:@"ShiftRight"]) {
    return kCGEventFlagMaskShift;
  }
  if ([code isEqualToString:@"ControlLeft"] || [code isEqualToString:@"ControlRight"]) {
    return kCGEventFlagMaskControl;
  }
  if ([code isEqualToString:@"AltLeft"] || [code isEqualToString:@"AltRight"]) {
    return kCGEventFlagMaskAlternate;
  }
  if ([code isEqualToString:@"MetaLeft"] || [code isEqualToString:@"MetaRight"]) {
    return kCGEventFlagMaskCommand;
  }
  return 0;
}

static CGEventFlags RionDesktopE2EUpdateModifierFlags(NSString *code, bool keyDown) {
  NSMutableSet<NSString *> *heldCodes = RionDesktopE2EHeldModifierCodes();
  @synchronized(heldCodes) {
    if (RionDesktopE2EModifierFlag(code) != 0) {
      if (keyDown) {
        [heldCodes addObject:code];
      } else {
        [heldCodes removeObject:code];
      }
    }
    CGEventFlags flags = 0;
    for (NSString *heldCode in heldCodes) {
      flags |= RionDesktopE2EModifierFlag(heldCode);
    }
    return flags;
  }
}

static bool RionDesktopE2EActivateFullscreenSpace(NSWindow *window) {
  if ((window.styleMask & NSWindowStyleMaskFullScreen) == 0) return false;
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
  if (!screenNumber) return false;
  const NSInteger windowNumber = window.windowNumber;
  const CGDirectDisplayID displayID = screenNumber.unsignedIntValue;
  NSWindow *targetWindow = window;
  dispatch_async(
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      void *skyLight = dlopen(
          "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
          RTLD_LAZY | RTLD_LOCAL);
      if (!skyLight) return;
      typedef int32_t (*RionMainConnectionFn)(void);
      typedef CFArrayRef (*RionCopySpacesForWindowsFn)(
          int32_t, int32_t, CFArrayRef);
      typedef int32_t (*RionSetCurrentSpaceFn)(
          int32_t, CFStringRef, uint64_t);
      RionMainConnectionFn mainConnection =
          (RionMainConnectionFn)dlsym(skyLight, "CGSMainConnectionID");
      RionCopySpacesForWindowsFn copySpaces =
          (RionCopySpacesForWindowsFn)dlsym(
              skyLight, "CGSCopySpacesForWindows");
      RionSetCurrentSpaceFn setCurrentSpace =
          (RionSetCurrentSpaceFn)dlsym(
              skyLight, "CGSManagedDisplaySetCurrentSpace");
      if (!mainConnection || !copySpaces || !setCurrentSpace) {
        dlclose(skyLight);
        return;
      }

      const int32_t connection = mainConnection();
      NSArray<NSNumber *> *windowNumbers = @[@(windowNumber)];
      CFArrayRef spaces = copySpaces(
          connection, 7, (__bridge CFArrayRef)windowNumbers);
      NSNumber *spaceNumber = spaces && CFArrayGetCount(spaces) > 0
          ? (__bridge NSNumber *)CFArrayGetValueAtIndex(spaces, 0)
          : nil;
      CFUUIDRef displayUUID = CGDisplayCreateUUIDFromDisplayID(displayID);
      CFStringRef displayUUIDString = displayUUID
          ? CFUUIDCreateString(kCFAllocatorDefault, displayUUID)
          : nil;
      const bool switched = spaceNumber && displayUUIDString
          && setCurrentSpace(
              connection,
              displayUUIDString,
              spaceNumber.unsignedLongLongValue) == 0;
      if (displayUUIDString) CFRelease(displayUUIDString);
      if (displayUUID) CFRelease(displayUUID);
      if (spaces) CFRelease(spaces);
      dlclose(skyLight);
      if (!switched) return;
      dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp activateIgnoringOtherApps:YES];
        [targetWindow makeKeyWindow];
      });
    }
  });
  return true;
}

bool rion_desktop_e2e_keyboard_input(const char *rawCode, bool keyDown) {
  @autoreleasepool {
    if (!rawCode) return false;
    NSString *code = [NSString stringWithUTF8String:rawCode];
    NSNumber *virtualCode = RionDesktopE2EKeyCode(code);
    if (!virtualCode) return false;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (!source) return false;
    CGEventRef event = CGEventCreateKeyboardEvent(
        source, (CGKeyCode)virtualCode.unsignedShortValue, keyDown);
    CFRelease(source);
    if (!event) return false;
    CGEventSetFlags(event, RionDesktopE2EUpdateModifierFlags(code, keyDown));
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return true;
  }
}

bool rion_desktop_e2e_drag_webview(void *rawWebview, bool vertical,
                                   double deltaRatio) {
  @autoreleasepool {
    NSView *view = (__bridge NSView *)rawWebview;
    NSWindow *window = view.window;
    if (!view || !window || !isfinite(deltaRatio) || fabs(deltaRatio) < 0.02 ||
        fabs(deltaRatio) > 0.25) {
      return false;
    }
    [window makeKeyAndOrderFront:nil];
    const NSRect viewInWindow = [view convertRect:view.bounds toView:nil];
    const NSRect screenRect = [window convertRectToScreen:viewInWindow];
    const NSRect contentRect = window.contentLayoutRect;
    CGPoint start = CGPointMake(NSMidX(screenRect), RionDesktopTop() - NSMidY(screenRect));
    CGPoint end = start;
    if (vertical) {
      end.x += contentRect.size.width * deltaRatio;
    } else {
      end.y += contentRect.size.height * deltaRatio;
    }
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (!source) return false;
    const CGEventType types[] = {
      kCGEventMouseMoved,
      kCGEventLeftMouseDown,
      kCGEventLeftMouseDragged,
      kCGEventLeftMouseUp,
    };
    const CGPoint points[] = {start, start, end, end};
    bool accepted = true;
    for (NSUInteger index = 0; index < 4; index += 1) {
      CGEventRef event = CGEventCreateMouseEvent(
          source, types[index], points[index], kCGMouseButtonLeft);
      if (!event) {
        accepted = false;
        break;
      }
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
    }
    CFRelease(source);
    return accepted;
  }
}

bool rion_desktop_e2e_control_window(void *rawWindow, int32_t action,
                                     double x, double y, double width,
                                     double height) {
  NSWindow *window = (__bridge NSWindow *)rawWindow;
  if (!window) return false;
  switch (action) {
    case 0: {
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) return false;
      if (window.miniaturized) [window deminiaturize:nil];
      if (window.zoomed) [window performZoom:nil];
      // Use AppKit's semantic resize and move entry points independently. They
      // emit the same did-resize/did-move notifications consumed by the product
      // observer, unlike a direct frame replacement on an off-key test window.
      [window setContentSize:NSMakeSize(width, height)];
      const NSRect frame = window.frame;
      [window setFrameOrigin:NSMakePoint(
          x, RionDesktopTop() - y - frame.size.height)];
      [window displayIfNeeded];
      return true;
    }
    case 1:
      if (window.miniaturized) {
        __block id observer = nil;
        observer = [NSNotificationCenter.defaultCenter
            addObserverForName:NSWindowDidDeminiaturizeNotification
                        object:window
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(__unused NSNotification *notification) {
          [NSNotificationCenter.defaultCenter removeObserver:observer];
          observer = nil;
          if (window.zoomed) [window performZoom:nil];
        }];
        [window deminiaturize:nil];
        return true;
      }
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
        [window toggleFullScreen:nil];
      } else if (window.zoomed) {
        [window performZoom:nil];
      }
      return true;
    case 2:
      if (window.miniaturized) [window deminiaturize:nil];
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) return false;
      if (!window.zoomed) [window performZoom:nil];
      return true;
    case 3:
      [window miniaturize:nil];
      return true;
    case 4:
      if (window.miniaturized) [window deminiaturize:nil];
      if ((window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
        [window toggleFullScreen:nil];
      }
      return true;
    case 5:
      [window performClose:nil];
      return true;
    case 6: {
      if ((window.styleMask & NSWindowStyleMaskFullScreen) == 0) return false;
      [NSApp activateIgnoringOtherApps:YES];
      [window makeKeyAndOrderFront:nil];
      const NSRect frame = window.frame;
      const CGPoint point = CGPointMake(
          NSMidX(frame), RionDesktopTop() - NSMaxY(frame) + 1.0);
      CGEventSourceRef source =
          CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
      if (!source) return false;
      CGEventRef event = CGEventCreateMouseEvent(
          source, kCGEventMouseMoved, point, kCGMouseButtonLeft);
      CFRelease(source);
      if (!event) return false;
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
      return true;
    }
    case 7: {
      [NSApp activateIgnoringOtherApps:YES];
      [window makeKeyAndOrderFront:nil];
      const NSRect frame = window.frame;
      const CGPoint point = CGPointMake(
          NSMidX(frame), RionDesktopTop() - NSMidY(frame));
      CGEventSourceRef source =
          CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
      if (!source) return false;
      CGEventRef event = CGEventCreateMouseEvent(
          source, kCGEventMouseMoved, point, kCGMouseButtonLeft);
      CFRelease(source);
      if (!event) return false;
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
      return true;
    }
    case 8:
      return RionDesktopE2EActivateFullscreenSpace(window);
    default:
      return false;
  }
}

bool rion_desktop_e2e_read_window(void *rawWindow,
                                  RionDesktopE2EWindowSnapshot *snapshot) {
  NSWindow *window = (__bridge NSWindow *)rawWindow;
  if (!window || !snapshot) return false;
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  if (!screen) return false;
  const CGFloat desktopTop = RionDesktopTop();
  const NSRect frame = window.frame;
  const NSRect content = [window contentRectForFrameRect:frame];
  const NSRect work = screen.visibleFrame;
  NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
  snapshot->content_height = content.size.height;
  snapshot->content_width = content.size.width;
  snapshot->display_id = screenNumber.longLongValue;
  snapshot->fullscreen =
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  snapshot->maximized = window.zoomed;
  snapshot->minimized = window.miniaturized;
  snapshot->outer_height = frame.size.height;
  snapshot->outer_width = frame.size.width;
  snapshot->outer_x = frame.origin.x;
  snapshot->outer_y = desktopTop - NSMaxY(frame);
  snapshot->scale_factor = screen.backingScaleFactor;
  snapshot->work_height = work.size.height;
  snapshot->work_width = work.size.width;
  snapshot->work_x = work.origin.x;
  snapshot->work_y = desktopTop - NSMaxY(work);
  return true;
}
