#import "RionRuntimeTabsController.h"
#import <objc/message.h>
#import <objc/runtime.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>

// Unified compact is AppKit's 40pt titlebar host on macOS 12 and newer. Keep
// the accessory at the exact host height so the blur covers the whole row and
// never leaves a separator-colored strip above the game content.
static const CGFloat kRionTitlebarHeight = 40.0;
static const CGFloat kRionTabHeight = 28.0;
static const CGFloat kRionTabMinimumWidth = 144.0;
static const CGFloat kRionTabMaximumWidth = 280.0;
static const CGFloat kRionTabSpacing = 6.0;
static const CGFloat kRionTabLeadingPadding = 10.0;
static const CGFloat kRionTabIconSize = 16.0;
static const CGFloat kRionTabIconTitleSpacing = 6.0;
static const CGFloat kRionTabAccessorySpacing = 4.0;
static const CGFloat kRionTabAudioIconSize = 14.0;
static const CGFloat kRionTabMoreButtonWidth = 20.0;
static const CGFloat kRionTabTrailingPadding = 8.0;
static const CGFloat kRionTabScrollButtonWidth = 22.0;
static const CGFloat kRionTabScrollButtonSpacing = 3.0;
static const CGFloat kRionAddButtonSpacing = 8.0;
static const CGFloat kRionRootLeadingInset = 4.0;
static const CGFloat kRionWindowNameMaximumWidth = 188.0;
static const CGFloat kRionWindowNameTrailingSpacing = 10.0;
static const CGFloat kRionRootTrailingDraggableWidth = 12.0;
static const CGFloat kRionTrafficLightFallbackWidth = 76.0;
static const NSInteger kRionAddButtonTag = 41001;
static NSToolbarItemIdentifier const RionRuntimeToolbarSpacerIdentifier =
    @"com.rionstudio.runtime-tabs.layout-spacer";
static NSPasteboardType const RionRuntimeTabPasteboardType =
    @"com.rionstudio.runtime-tab";

static NSString *RionRuntimeTabDragPayload(NSString *sourceWindowID,
                                           NSString *tabIdentifier,
                                           NSString *sessionIdentifier,
                                           NSPoint grabRatio,
                                           NSSize tabSize) {
  return [@[ sourceWindowID, tabIdentifier, sessionIdentifier,
             @(grabRatio.x).stringValue, @(grabRatio.y).stringValue,
             @(tabSize.width).stringValue, @(tabSize.height).stringValue ]
      componentsJoinedByString:@"\n"];
}

static NSArray<NSString *> *RionRuntimeTabDragPayloadParts(NSString *payload) {
  if (payload.length == 0) return nil;
  NSArray<NSString *> *parts = [payload componentsSeparatedByString:@"\n"];
  if (parts.count != 7 || parts[0].length == 0 || parts[1].length == 0 ||
      parts[2].length == 0) {
    return nil;
  }
  CGFloat grabRatioX = parts[3].doubleValue;
  CGFloat grabRatioY = parts[4].doubleValue;
  CGFloat tabWidth = parts[5].doubleValue;
  CGFloat tabHeight = parts[6].doubleValue;
  if (!std::isfinite(grabRatioX) || !std::isfinite(grabRatioY) ||
      !std::isfinite(tabWidth) || !std::isfinite(tabHeight) ||
      grabRatioX < 0.0 || grabRatioX > 1.0 || grabRatioY < 0.0 ||
      grabRatioY > 1.0 || tabWidth <= 0.0 || tabHeight <= 0.0) {
    return nil;
  }
  return parts;
}

static char RionRuntimeTitlebarHeightAssociationKey;
static std::mutex RionRuntimeTitlebarHeightHookMutex;
static std::unordered_map<Class, IMP> RionRuntimeOriginalTitlebarHeightIMPs;
static char RionRuntimeTitlebarWidgetInsetAssociationKey;
static std::mutex RionRuntimeTitlebarWidgetInsetHookMutex;
static std::unordered_map<Class, IMP>
    RionRuntimeOriginalTitlebarWidgetInsetIMPs;
static char RionRuntimeFullscreenPresentationPolicyAssociationKey;

// Tao implements TaoWindow's -sendEvent: in an extern "C" Rust callback. The
// macOS 26 crash reports repeatedly show that callback panicking while invoking
// `[NSEvent type]`. objc2 turns Objective-C exceptions into Rust panics, but
// Tao's callback cannot unwind, so the process aborts before Rion receives the
// event. Keep the same Tao behavior in Objective-C, where AppKit exceptions can
// be contained safely. This is limited to Tao's exact runtime window class.
static void RionSafeTaoWindowSendEvent(id window, SEL selector,
                                       NSEvent *event) {
  @autoreleasepool {
    if (!window || !event) return;
    @try {
      if (event.type == NSEventTypeLeftMouseDown &&
          [window isMovableByWindowBackground]) {
        [window performWindowDragWithEvent:event];
      }

      Class taoWindow = NSClassFromString(@"TaoWindow");
      Class superclass = taoWindow ? class_getSuperclass(taoWindow) : Nil;
      Method method = class_getInstanceMethod(superclass, selector);
      IMP implementation = method ? method_getImplementation(method) : nullptr;
      if (!implementation) return;
      using SendEventFunction = void (*)(id, SEL, NSEvent *);
      reinterpret_cast<SendEventFunction>(implementation)(window, selector,
                                                          event);
    } @catch (NSException *exception) {
      NSLog(@"Rion Studio discarded an invalid native window event: %@",
            exception.reason);
    }
  }
}

bool rion_runtime_tabs_install_safe_tao_event_dispatch(void) {
  @autoreleasepool {
    Class taoWindow = NSClassFromString(@"TaoWindow");
    if (!taoWindow) return false;
    SEL selector = @selector(sendEvent:);
    Method method = class_getInstanceMethod(taoWindow, selector);
    if (!method) return false;
    IMP safeImplementation =
        reinterpret_cast<IMP>(RionSafeTaoWindowSendEvent);
    if (method_getImplementation(method) != safeImplementation) {
      method_setImplementation(method, safeImplementation);
    }
    return method_getImplementation(method) == safeImplementation;
  }
}

static BOOL RionRuntimeTabsOverflow(CGFloat contentWidth,
                                    CGFloat availableWidth) {
  return contentWidth - availableWidth > 1.0;
}

static CGFloat RionRuntimeClampScrollOrigin(CGFloat origin,
                                            CGFloat contentWidth,
                                            CGFloat viewportWidth) {
  return MIN(MAX(0, contentWidth - viewportWidth), MAX(0, origin));
}

static CGFloat RionRuntimePreferredTabWidth(CGFloat labelWidth,
                                            BOOL hideTabCloseButton) {
  CGFloat fixedWidth = kRionTabLeadingPadding + kRionTabIconSize +
      kRionTabIconTitleSpacing + kRionTabAccessorySpacing +
      kRionTabAudioIconSize + kRionTabTrailingPadding;
  if (!hideTabCloseButton) {
    fixedWidth += kRionTabAccessorySpacing + kRionTabMoreButtonWidth;
  }
  return MIN(kRionTabMaximumWidth,
             MAX(kRionTabMinimumWidth, ceil(labelWidth) + fixedWidth));
}

static CGFloat RionRuntimeRevealScrollOrigin(
    CGFloat itemMinimumX, CGFloat itemMaximumX, CGFloat visibleOrigin,
    CGFloat viewportWidth, CGFloat contentWidth) {
  CGFloat origin = visibleOrigin;
  if (itemMinimumX < visibleOrigin) {
    origin = itemMinimumX;
  } else if (itemMaximumX > visibleOrigin + viewportWidth) {
    origin = itemMaximumX - viewportWidth;
  }
  return RionRuntimeClampScrollOrigin(origin, contentWidth, viewportWidth);
}

static CGFloat RionRuntimeDragScrollDelta(CGFloat pointX,
                                          CGFloat minimumX,
                                          CGFloat maximumX,
                                          CGFloat edgeWidth) {
  if (pointX < minimumX + edgeWidth) {
    CGFloat strength = MIN(
        1.0, MAX(0.0, (minimumX + edgeWidth - pointX) /
                           MAX(1.0, edgeWidth)));
    return -(2.0 + round(strength * 14.0));
  }
  if (pointX > maximumX - edgeWidth) {
    CGFloat strength = MIN(
        1.0, MAX(0.0, (pointX - (maximumX - edgeWidth)) /
                           MAX(1.0, edgeWidth)));
    return 2.0 + round(strength * 14.0);
  }
  return 0;
}

static CGFloat RionRuntimeTabReorderHysteresis(CGFloat tabWidth) {
  return MIN(5.0, MAX(2.0, round(tabWidth * 0.025)));
}

static CGFloat RionRuntimeTabInsertionProbeX(CGFloat pointerX,
                                             CGFloat tabWidth,
                                             CGFloat grabRatioX) {
  return pointerX + (0.5 - grabRatioX) * tabWidth;
}

static CGFloat RionRuntimeDirectionalInsertionProbeX(
    CGFloat minimumX, CGFloat maximumX, CGFloat centerX, CGFloat deltaX,
    BOOL *shouldResolveInsertion) {
  if (deltaX > 0.1) {
    *shouldResolveInsertion = YES;
    return maximumX;
  }
  if (deltaX < -0.1) {
    *shouldResolveInsertion = YES;
    return minimumX;
  }
  *shouldResolveInsertion = NO;
  return centerX;
}

static NSUInteger RionRuntimeStableInsertionIndex(
    CGFloat pointX, NSArray<NSNumber *> *midpoints, NSArray<NSNumber *> *widths,
    NSUInteger currentIndex) {
  NSUInteger count = MIN(midpoints.count, widths.count);
  currentIndex = MIN(currentIndex, count);
  NSUInteger desiredIndex = count;
  for (NSUInteger index = 0; index < count; ++index) {
    if (pointX < midpoints[index].doubleValue) {
      desiredIndex = index;
      break;
    }
  }
  if (desiredIndex > currentIndex) {
    while (currentIndex < desiredIndex) {
      CGFloat midpoint = midpoints[currentIndex].doubleValue;
      CGFloat margin =
          RionRuntimeTabReorderHysteresis(widths[currentIndex].doubleValue);
      if (pointX < midpoint + margin) break;
      currentIndex += 1;
    }
  } else if (desiredIndex < currentIndex) {
    while (currentIndex > desiredIndex) {
      NSUInteger boundaryIndex = currentIndex - 1;
      CGFloat midpoint = midpoints[boundaryIndex].doubleValue;
      CGFloat margin =
          RionRuntimeTabReorderHysteresis(widths[boundaryIndex].doubleValue);
      if (pointX > midpoint - margin) break;
      currentIndex -= 1;
    }
  }
  return currentIndex;
}

static NSRect RionRuntimeDragFrameWithLockedY(NSRect frame, CGFloat screenY) {
  frame.origin.y = screenY;
  return frame;
}

// AppKit always asks an NSDraggingSession for drag contents. Supplying the tab
// snapshot here creates a second, floating copy of the tab even though the
// titlebar already owns the reorder placeholder and native detach lifecycle.
// Keep the dragging item for AppKit's destination routing, but make its visual
// contents a real transparent bitmap so there is only one visible tab.
static NSImage *RionRuntimeTransparentDragImage(void) {
  static NSImage *image;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSBitmapImageRep *representation = [[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:nullptr
                      pixelsWide:1
                      pixelsHigh:1
                   bitsPerSample:8
                 samplesPerPixel:4
                        hasAlpha:YES
                        isPlanar:NO
                  colorSpaceName:NSDeviceRGBColorSpace
                     bytesPerRow:4
                    bitsPerPixel:32];
    if (representation.bitmapData) {
      std::memset(representation.bitmapData, 0, 4);
    }
    image = [[NSImage alloc] initWithSize:NSMakeSize(1.0, 1.0)];
    [image addRepresentation:representation];
  });
  return image;
}

static BOOL RionRuntimePointInHalfOpenRect(NSPoint point, NSRect rect) {
  return point.x >= NSMinX(rect) && point.x < NSMaxX(rect) &&
      point.y >= NSMinY(rect) && point.y < NSMaxY(rect);
}

static void RionDisableToolbarBaselineSeparator(NSToolbar *toolbar) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  // Required on macOS 14. macOS 15 ignores this property in favor of
  // titlebarSeparatorStyle, which is configured alongside it below.
  toolbar.showsBaselineSeparator = NO;
#pragma clang diagnostic pop
}
static std::mutex RionRuntimeFullscreenPresentationHookMutex;
static std::unordered_map<Class, IMP>
    RionRuntimeOriginalFullscreenPresentationOptionIMPs;

// NSApplicationPresentationOptions is process-wide, while each runtime window
// owns its fullscreen toolbar policy. Keep a main-thread registry so one
// auto-hide window cannot re-enable AppKit's process-wide auto-hide bit while a
// different fullscreen runtime window needs its toolbar permanently visible.
// The original bit is captured before the first fullscreen request and is
// restored after the last managed fullscreen window leaves.
static NSMutableDictionary<NSValue *, NSNumber *> *
RionFullscreenToolbarPresentationRequests(void) {
  static NSMutableDictionary<NSValue *, NSNumber *> *requests;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    requests = [NSMutableDictionary dictionary];
  });
  return requests;
}

static BOOL RionFullscreenToolbarPresentationBaselineCaptured = NO;
static BOOL RionFullscreenToolbarPresentationBaselineAutoHide = NO;

static void RionApplyFullscreenToolbarPresentationPolicy(void) {
  NSApplication *application = NSApplication.sharedApplication;
  NSMutableDictionary<NSValue *, NSNumber *> *requests =
      RionFullscreenToolbarPresentationRequests();
  NSApplicationPresentationOptions current = application.presentationOptions;

  if (requests.count == 0 &&
      !RionFullscreenToolbarPresentationBaselineCaptured) {
    return;
  }

  if (requests.count > 0 &&
      !RionFullscreenToolbarPresentationBaselineCaptured) {
    RionFullscreenToolbarPresentationBaselineCaptured = YES;
    RionFullscreenToolbarPresentationBaselineAutoHide =
        (current & NSApplicationPresentationAutoHideToolbar) != 0;
  }

  BOOL shouldAutoHide = RionFullscreenToolbarPresentationBaselineAutoHide;
  for (NSNumber *request in requests.objectEnumerator) {
    // A false request represents always-show or reveal-lock. It has priority
    // over every auto-hide fullscreen runtime window in this process.
    if (!request.boolValue) {
      shouldAutoHide = NO;
      break;
    }
  }

  const NSApplicationPresentationOptions autoHideToolbar =
      NSApplicationPresentationAutoHideToolbar;
  NSApplicationPresentationOptions desired = current;
  if (shouldAutoHide) {
    desired |= autoHideToolbar;
  } else {
    desired &= ~autoHideToolbar;
  }

  BOOL policyApplied = desired == current;
  if (desired != current) {
    @try {
      // Only change AutoHideToolbar. FullScreen, menu bar, Dock and every
      // other process presentation option remain exactly as AppKit set them.
      application.presentationOptions = desired;
      policyApplied = YES;
    } @catch (__unused NSException *exception) {
      // AppKit can reject presentation changes during a style-mask animation;
      // the next controller/event policy pass will retry with the same bit.
    }
  }

  if (requests.count == 0 && policyApplied) {
    RionFullscreenToolbarPresentationBaselineCaptured = NO;
    RionFullscreenToolbarPresentationBaselineAutoHide = NO;
  }
}

static void RionSetFullscreenToolbarPresentationRequest(
    const void *controller, BOOL active, BOOL autoHide) {
  if (!controller) return;
  NSMutableDictionary<NSValue *, NSNumber *> *requests =
      RionFullscreenToolbarPresentationRequests();
  NSValue *key = [NSValue valueWithPointer:controller];
  if (active) {
    requests[key] = @(autoHide);
  } else {
    [requests removeObjectForKey:key];
  }
  RionApplyFullscreenToolbarPresentationPolicy();
}

static Method RionDirectInstanceMethod(Class targetClass, SEL selector);

static IMP RionOriginalFullscreenPresentationOptionsIMPForObject(id object) {
  std::lock_guard<std::mutex> lock(
      RionRuntimeFullscreenPresentationHookMutex);
  for (Class candidate = object_getClass(object); candidate;
       candidate = class_getSuperclass(candidate)) {
    auto found = RionRuntimeOriginalFullscreenPresentationOptionIMPs.find(
        candidate);
    if (found != RionRuntimeOriginalFullscreenPresentationOptionIMPs.end()) {
      return found->second;
    }
  }
  return nullptr;
}

static NSApplicationPresentationOptions
RionRuntimeFullscreenPresentationOptions(
    id delegate, SEL selector, NSWindow *window,
    NSApplicationPresentationOptions proposedOptions) {
  NSApplicationPresentationOptions options = proposedOptions;
  IMP original = RionOriginalFullscreenPresentationOptionsIMPForObject(delegate);
  if (original) {
    using FullscreenPresentationOptionsFunction =
        NSApplicationPresentationOptions (*)(id, SEL, NSWindow *,
                                             NSApplicationPresentationOptions);
    @try {
      options = reinterpret_cast<FullscreenPresentationOptionsFunction>(
          original)(delegate, selector, window, proposedOptions);
    } @catch (__unused NSException *exception) {
      options = proposedOptions;
    }
  }

  // AppKit asks the window delegate for the final presentation options before
  // building NSToolbarFullScreenWindow. Clamp only the Rion-marked window;
  // every other delegate result, including all non-toolbar flags, is kept.
  NSNumber *alwaysShow = objc_getAssociatedObject(
      window, &RionRuntimeFullscreenPresentationPolicyAssociationKey);
  if (alwaysShow.boolValue) {
    options &= ~NSApplicationPresentationAutoHideToolbar;
  }
  return options;
}

static BOOL RionInstallFullscreenPresentationOptionsHook(NSWindow *window) {
  if (!window || !window.delegate) return NO;
  id delegate = window.delegate;
  SEL selector = @selector(window:willUseFullScreenPresentationOptions:);
  if (![delegate respondsToSelector:selector]) return NO;

  NSMethodSignature *signature = [delegate methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 4 ||
      signature.methodReturnLength != sizeof(NSApplicationPresentationOptions)) {
    return NO;
  }

  Class targetClass = object_getClass(delegate);
  std::lock_guard<std::mutex> lock(RionRuntimeFullscreenPresentationHookMutex);
  if (RionRuntimeOriginalFullscreenPresentationOptionIMPs.find(targetClass) !=
      RionRuntimeOriginalFullscreenPresentationOptionIMPs.end()) {
    return YES;
  }

  Method inheritedMethod = class_getInstanceMethod(targetClass, selector);
  if (!inheritedMethod) return NO;
  IMP original = method_getImplementation(inheritedMethod);
  // A superclass may already carry the marker-aware wrapper. Do not save that
  // wrapper as the subclass's original implementation.
  if (original == (IMP)RionRuntimeFullscreenPresentationOptions) return YES;
  const char *types = method_getTypeEncoding(inheritedMethod);
  RionRuntimeOriginalFullscreenPresentationOptionIMPs.emplace(targetClass,
                                                                original);

  Method directMethod = RionDirectInstanceMethod(targetClass, selector);
  if (directMethod) {
    method_setImplementation(directMethod,
                             (IMP)RionRuntimeFullscreenPresentationOptions);
    return YES;
  }
  if (class_addMethod(targetClass, selector,
                      (IMP)RionRuntimeFullscreenPresentationOptions, types)) {
    return YES;
  }

  RionRuntimeOriginalFullscreenPresentationOptionIMPs.erase(targetClass);
  return NO;
}

static void RionSetFullscreenPresentationPolicyMarker(NSWindow *window,
                                                      BOOL active,
                                                      BOOL alwaysShow) {
  if (!window) return;
  objc_setAssociatedObject(
      window, &RionRuntimeFullscreenPresentationPolicyAssociationKey,
      active && alwaysShow ? @YES : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

RionRuntimeContentLayout RionRuntimeContentLayoutForRects(
    NSRect contentBounds, NSRect contentLayoutRect, BOOL contentViewFlipped) {
  RionRuntimeContentLayout result = {0, 0, NO};
  const CGFloat contentHeight = NSHeight(contentBounds);
  if (!std::isfinite(NSMinX(contentBounds)) ||
      !std::isfinite(NSMinY(contentBounds)) ||
      !std::isfinite(NSWidth(contentBounds)) ||
      !std::isfinite(contentHeight) || contentHeight <= 0 ||
      !std::isfinite(NSMinX(contentLayoutRect)) ||
      !std::isfinite(NSMinY(contentLayoutRect)) ||
      !std::isfinite(NSWidth(contentLayoutRect)) ||
      !std::isfinite(NSHeight(contentLayoutRect))) {
    return result;
  }

  NSRect clippedLayoutRect = NSIntersectionRect(contentBounds,
                                                 contentLayoutRect);
  if (NSIsEmptyRect(clippedLayoutRect)) return result;

  const CGFloat topInset = contentViewFlipped
      ? NSMinY(clippedLayoutRect) - NSMinY(contentBounds)
      : NSMaxY(contentBounds) - NSMaxY(clippedLayoutRect);
  const CGFloat totalInset = contentHeight - NSHeight(clippedLayoutRect);
  const CGFloat maximumInset = floor(contentHeight);
  result.yOffset = MIN(maximumInset, MAX(0.0, round(topInset)));
  result.heightInset = MIN(maximumInset,
                           MAX(result.yOffset, round(totalInset)));
  result.valid = YES;
  return result;
}

// Some WebView window hosts fall back to AppKit's 32pt fullscreen metric.
// Rion uses AppKit's native fullscreen host, so wrap the frame getter and opt
// in only marked Rion windows.
// The class-level hook remains safe for every other instance by forwarding to
// the exact original implementation saved for that frame class.
//
// Chromium also overrides _minXTitlebarWidgetInset on BrowserWindowFrame for
// macOS 26, but AppKit's auxiliary fullscreen toolbar window has its own frame
// class and misses that metric. Mirror the windowed value onto only the active
// Rion frame instances so AppKit can lay out its own controls at the same inset.
static void RionLogTitlebarHeightOverrideUnavailable(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSLog(@"Rion Studio could not configure the native titlebar height; "
          "AppKit's default metric will be used.");
  });
}

static void RionLogFullscreenTitlebarGeometrySyncUnavailable(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSLog(@"Rion Studio could not synchronize the fullscreen titlebar "
          "geometry; AppKit's window-button layout will be used.");
  });
}

static IMP RionOriginalTitlebarHeightIMPForObject(id object) {
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarHeightHookMutex);
  for (Class candidate = object_getClass(object); candidate;
       candidate = class_getSuperclass(candidate)) {
    auto found = RionRuntimeOriginalTitlebarHeightIMPs.find(candidate);
    if (found != RionRuntimeOriginalTitlebarHeightIMPs.end()) {
      return found->second;
    }
  }
  return nullptr;
}

static CGFloat RionRuntimeTitlebarHeight(id frameView, SEL selector) {
  NSNumber *overrideHeight = objc_getAssociatedObject(
      frameView, &RionRuntimeTitlebarHeightAssociationKey);
  if (overrideHeight) return overrideHeight.doubleValue;

  IMP original = RionOriginalTitlebarHeightIMPForObject(frameView);
  if (!original) return 0;
  using TitlebarHeightFunction = CGFloat (*)(id, SEL);
  return reinterpret_cast<TitlebarHeightFunction>(original)(frameView, selector);
}

static IMP RionOriginalTitlebarWidgetInsetIMPForObject(id object) {
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarWidgetInsetHookMutex);
  for (Class candidate = object_getClass(object); candidate;
       candidate = class_getSuperclass(candidate)) {
    auto found = RionRuntimeOriginalTitlebarWidgetInsetIMPs.find(candidate);
    if (found != RionRuntimeOriginalTitlebarWidgetInsetIMPs.end()) {
      return found->second;
    }
  }
  return nullptr;
}

static CGFloat RionRuntimeTitlebarWidgetInset(id frameView, SEL selector) {
  NSNumber *overrideInset = objc_getAssociatedObject(
      frameView, &RionRuntimeTitlebarWidgetInsetAssociationKey);
  if (overrideInset) return overrideInset.doubleValue;

  IMP original = RionOriginalTitlebarWidgetInsetIMPForObject(frameView);
  if (!original) return 0;
  using TitlebarWidgetInsetFunction = CGFloat (*)(id, SEL);
  return reinterpret_cast<TitlebarWidgetInsetFunction>(original)(frameView,
                                                                  selector);
}

static Method RionDirectInstanceMethod(Class targetClass, SEL selector) {
  unsigned int count = 0;
  Method *methods = class_copyMethodList(targetClass, &count);
  Method result = nullptr;
  for (unsigned int index = 0; index < count; ++index) {
    if (method_getName(methods[index]) == selector) {
      result = methods[index];
      break;
    }
  }
  std::free(methods);
  return result;
}

static BOOL RionInstallTitlebarHeightHook(NSView *frameView) {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"_titlebarHeight");
  if (![frameView respondsToSelector:selector]) {
    RionLogTitlebarHeightOverrideUnavailable();
    return NO;
  }

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    RionLogTitlebarHeightOverrideUnavailable();
    return NO;
  }

  Class targetClass = object_getClass(frameView);
  std::lock_guard<std::mutex> lock(RionRuntimeTitlebarHeightHookMutex);
  if (RionRuntimeOriginalTitlebarHeightIMPs.find(targetClass) !=
      RionRuntimeOriginalTitlebarHeightIMPs.end()) {
    return YES;
  }

  Method inheritedMethod = class_getInstanceMethod(targetClass, selector);
  if (!inheritedMethod) {
    RionLogTitlebarHeightOverrideUnavailable();
    return NO;
  }
  IMP original = method_getImplementation(inheritedMethod);
  // A superclass may already carry the wrapper. In that case this exact
  // class inherits the marker-aware behavior and must not save the wrapper as
  // its "original" implementation, which would recurse for unmarked views.
  if (original == (IMP)RionRuntimeTitlebarHeight) return YES;
  const char *types = method_getTypeEncoding(inheritedMethod);
  RionRuntimeOriginalTitlebarHeightIMPs.emplace(targetClass, original);

  Method directMethod = RionDirectInstanceMethod(targetClass, selector);
  if (directMethod) {
    method_setImplementation(directMethod, (IMP)RionRuntimeTitlebarHeight);
    return YES;
  }
  if (class_addMethod(targetClass, selector,
                      (IMP)RionRuntimeTitlebarHeight, types)) {
    return YES;
  }

  RionRuntimeOriginalTitlebarHeightIMPs.erase(targetClass);
  RionLogTitlebarHeightOverrideUnavailable();
  return NO;
}

static BOOL RionInstallTitlebarWidgetInsetHook(NSView *frameView) {
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

static NSString *RionStringFromUTF8(const char *value) {
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
                beforeTabID.UTF8String, screenX ? screenX.doubleValue : NAN,
                screenY ? screenY.doubleValue : NAN,
                grabRatioX ? grabRatioX.doubleValue : NAN,
                grabRatioY ? grabRatioY.doubleValue : NAN,
                tabWidth ? tabWidth.doubleValue : NAN,
                tabHeight ? tabHeight.doubleValue : NAN,
                cancelled ? cancelled.boolValue : false);
}

void *rion_runtime_tabs_create(
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

void rion_runtime_tabs_destroy(void *rawController) {
  @autoreleasepool {
    if (!rawController) return;
    RionRuntimeTabsController *controller =
        (__bridge_transfer RionRuntimeTabsController *)rawController;
    [controller destroy];
  }
}

void rion_runtime_tabs_prepare_fullscreen(void *rawController, bool fullscreen) {
  if (rawController) {
    [(__bridge RionRuntimeTabsController *)rawController
        prepareForFullscreenTransition:fullscreen];
  }
}

void rion_runtime_tabs_set_fullscreen_policy(void *rawController, bool alwaysShow) {
  if (rawController) {
    [(__bridge RionRuntimeTabsController *)rawController
        setAlwaysShowInFullScreen:alwaysShow];
  }
}

bool rion_runtime_tabs_is_main_thread(void) {
  return [NSThread isMainThread];
}

void rion_runtime_tabs_set_reveal_locked(void *rawController, bool locked) {
  if (rawController) {
    [(__bridge RionRuntimeTabsController *)rawController setRevealLocked:locked];
  }
}

void rion_runtime_tabs_set_window_name(void *rawController,
                                       const char *windowName) {
  @autoreleasepool {
    if (!rawController) return;
    [(__bridge RionRuntimeTabsController *)rawController
        setWindowName:RionStringFromUTF8(windowName)];
  }
}

void rion_runtime_tabs_set_active(void *rawController,
                                  const char *tabIdentifier) {
  @autoreleasepool {
    if (!rawController) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller setActiveTabIdentifier:RionStringFromUTF8(tabIdentifier)];
  }
}

void rion_runtime_tabs_ensure(void *rawController, const char *tabIdentifier,
                              const char *name, const char *type,
                              const char *workspaceTemplate,
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

void rion_runtime_tabs_reserve(void *rawController, const char *tabIdentifier,
                               const char *name, const char *type,
                               const char *workspaceTemplate,
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

void rion_runtime_tabs_replace(void *rawController,
                               const char *provisionalIdentifier,
                               const char *tabIdentifier, const char *name,
                               const char *type,
                               const char *workspaceTemplate,
                               const char *activeTabIdentifier) {
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

void rion_runtime_tabs_remove(void *rawController, const char *tabIdentifier,
                              const char *activeTabIdentifier) {
  @autoreleasepool {
    if (!rawController || !tabIdentifier) return;
    RionRuntimeTabsController *controller =
        (__bridge RionRuntimeTabsController *)rawController;
    [controller removeTabIdentifier:RionStringFromUTF8(tabIdentifier)
                activeTabIdentifier:RionStringFromUTF8(activeTabIdentifier)];
  }
}

void rion_runtime_tabs_reorder(void *rawController,
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
    void *rawController, const RionRuntimeTabInput *input,
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

RionRuntimeContentLayout rion_runtime_tabs_content_layout(void *rawController) {
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

bool rion_runtime_tabs_control_row_contains(void *rawController,
                                            double screenX,
                                            double screenY) {
  if (!rawController || !std::isfinite(screenX) || !std::isfinite(screenY)) {
    return false;
  }
  return [(__bridge RionRuntimeTabsController *)rawController
      controlRowContainsTopLeftScreenPoint:NSMakePoint(screenX, screenY)];
}

bool rion_runtime_tabs_drag_anchor(void *rawController,
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
    const char *beforeTabIdentifier, double screenX, double screenY,
    double grabRatioX, double grabRatioY, double tabWidth, double tabHeight,
    bool cancelled) {
  (void)sessionIdentifier;
  (void)tabIdentifier;
  (void)beforeTabIdentifier;
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
    CGFloat longWindowNameWidth = MIN(kRionWindowNameMaximumWidth, 420.0);
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
- (void)captureWindowedTrafficLightFrames;
- (void)configureAccessoryForTitlebar;
- (void)detachAccessoryController;
- (void)displayTitlebarHostIfNeeded;
- (void)detachTitlebarHeightOverrideFromFrameView:(nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrideFromFrameView:
    (nullable NSView *)frameView;
- (void)detachTitlebarWidgetInsetOverrides;
- (void)ensureTitlebarHeightOverride;
- (void)ensureFullScreenTitlebarWidgetInsetOverrides;
- (void)enforceTrafficLightVisibility;
- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                     sourceWindowID:(NSString *)sourceWindowID
                       sessionID:(NSString *)sessionID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier
                        screenPoint:(NSPoint)screenPoint;
- (void)handleHoverWithTabIdentifier:(NSString *)tabIdentifier
                      sourceWindowID:(NSString *)sourceWindowID
                           sessionID:(NSString *)sessionID
                    beforeIdentifier:(nullable NSString *)beforeIdentifier
                         screenPoint:(NSPoint)screenPoint;
- (void)moveTabDrag:(RionRuntimeTabItemView *)item atScreenPoint:(NSPoint)screenPoint;
- (void)endTabDrag:(RionRuntimeTabItemView *)item
       screenPoint:(NSPoint)screenPoint
         cancelled:(BOOL)cancelled;
- (nullable NSString *)tabIdentifierBeforePoint:(NSPoint)point inView:(NSView *)view;
- (nullable NSString *)stableTabIdentifierBeforePoint:(NSPoint)point
                                               inView:(NSView *)view
                                 draggedTabIdentifier:(NSString *)tabIdentifier
                                            sessionID:(NSString *)sessionID
                                           grabRatioX:(CGFloat)grabRatioX
                                       sourceTabWidth:(CGFloat)sourceTabWidth;
- (void)previewDragTabIdentifier:(NSString *)tabIdentifier
                beforeIdentifier:(nullable NSString *)beforeIdentifier;
- (void)positionDragSurfaceForTabIdentifier:(NSString *)tabIdentifier
                                    atPoint:(NSPoint)point
                                     inView:(NSView *)view
                                 grabRatioX:(CGFloat)grabRatioX;
- (void)hideDragSurfaceForTabIdentifier:(NSString *)tabIdentifier;
- (void)resetTabDragInsertionState;
- (void)hideInsertionIndicator;
- (void)scrollTabStripForDragPoint:(NSPoint)point inView:(NSView *)view;
- (void)stopTabDragEdgeScroll;
- (void)applyTabDragEdgeScroll;
- (void)setDragPlaceholderIdentifier:(nullable NSString *)identifier;
- (void)updateDragPlaceholderAppearance;
- (void)scrollTabsLeft:(id)sender;
- (void)scrollTabsRight:(id)sender;
- (void)beginTabShortcutModifierHandoff:(NSEventModifierFlags)flags;
- (void)finishTabShortcutModifierHandoffWithAction:(NSString *)actionType;
- (void)flushTabShortcutModifierHandoffWithAction:(NSString *)actionType;
- (void)handleTabShortcutModifierEvent:(NSEvent *)event;
- (void)notifyTabShortcutModifierHandoff:(NSString *)actionType;
- (CGFloat)dragPreviewScreenOriginY;
- (void)updateTabScrollButtonState;
- (BOOL)controlRowContainsTopLeftScreenPoint:(NSPoint)point;
- (BOOL)dragAnchorForTabIdentifier:(NSString *)tabIdentifier
                       grabRatioX:(CGFloat)grabRatioX
                       grabRatioY:(CGFloat)grabRatioY
                     windowOffset:(NSPoint *)windowOffset;
- (void)hideResidualFullScreenTrafficLightOverlay;
- (void)installPreparedToolbarForFullScreen;
- (void)installFreshToolbarForWindowedMode;
- (NSToolbar *)makeFullScreenToolbar;
- (NSToolbar *)makeToolbarHost;
- (NSToolbar *)makeWindowedToolbar;
- (BOOL)orderToolbarBelowAccessory;
- (void)removeTrafficLightObservationRestoringState:(BOOL)restoreState;
- (void)revealToolbarAndOrderBelowAccessory;
- (BOOL)readCustomTitlebarHeight:(CGFloat *)height
                   fromFrameView:(nullable NSView *)frameView;
- (BOOL)readTitlebarWidgetInset:(CGFloat *)inset
                  fromFrameView:(nullable NSView *)frameView;
- (void)restoreWindowedTrafficLightFrames;
- (void)refreshFullscreenTrafficLightVisibility;
- (void)restoreWindowedTitlebarHost;
- (void)scheduleContentLayoutNotification;
- (void)scheduleFullscreenHostRefresh;
- (void)scheduleLiquidGlassTitlebarRehost;
- (BOOL)setCustomTitlebarHeight:(CGFloat)height
                    onFrameView:(nullable NSView *)frameView;
- (BOOL)attachTitlebarHeightOverrideToFrameView:(nullable NSView *)frameView;
- (BOOL)attachTitlebarWidgetInsetOverride:(CGFloat)inset
                              toFrameView:(nullable NSView *)frameView;
- (void)settleWindowedTitlebarAfterFullScreenExit;
- (void)synchronizeFullScreenTitlebarGeometry;
- (BOOL)synchronizeTitlebarGeometryForFrameView:(nullable NSView *)frameView;
- (void)updateTrafficLightObservation;
- (void)ensureFullscreenPresentationOptionsHook;
- (void)updateFullscreenToolbarPresentationPolicy;
- (BOOL)updateTitlebarButtonPositionsForFrameView:(nullable NSView *)frameView;
- (void)updateInsertionIndicatorBeforeIdentifier:(nullable NSString *)identifier;
- (nullable NSView *)toolbarHostView;

@end

@implementation RionRuntimeTabModel
@end

@implementation RionRuntimeDraggableView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeWindowNameField

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

static void *RionRuntimeTrafficLightObservationContext =
    &RionRuntimeTrafficLightObservationContext;
static void *RionRuntimeContentLayoutObservationContext =
    &RionRuntimeContentLayoutObservationContext;

@implementation RionRuntimeBackdropView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeVerticallyCenteredTextFieldCell

- (NSRect)titleRectForBounds:(NSRect)bounds {
  NSRect titleRect = [super titleRectForBounds:bounds];
  NSFont *font = self.font;
  if (!font || NSHeight(bounds) <= 0) return titleRect;

  CGFloat metricHeight =
      ceil(font.ascender - font.descender + font.leading);
  CGFloat titleHeight = MIN(NSHeight(bounds), MAX(0, metricHeight));
  titleRect.origin.y =
      NSMinY(bounds) + (NSHeight(bounds) - titleHeight) / 2.0;
  titleRect.size.height = titleHeight;
  return titleRect;
}

- (void)drawInteriorWithFrame:(NSRect)cellFrame
                       inView:(NSView *)controlView {
  [super drawInteriorWithFrame:[self titleRectForBounds:cellFrame]
                        inView:controlView];
}

@end

@implementation RionRuntimeHorizontalScrollView

- (void)scrollWheel:(NSEvent *)event {
  if (std::fabs(event.scrollingDeltaX) >= std::fabs(event.scrollingDeltaY)) {
    [super scrollWheel:event];
    return;
  }
  NSClipView *clipView = self.contentView;
  CGFloat scale = event.hasPreciseScrollingDeltas ? 1.0 : 14.0;
  CGFloat maximumOrigin =
      MAX(0, self.documentView.frame.size.width - clipView.bounds.size.width);
  CGFloat originX = MIN(
      maximumOrigin,
      MAX(0, clipView.bounds.origin.x - event.scrollingDeltaY * scale));
  [clipView scrollToPoint:NSMakePoint(originX, clipView.bounds.origin.y)];
  [self reflectScrolledClipView:clipView];
}

@end

static BOOL RionRuntimeUsesDarkAppearance(NSAppearance *appearance) {
  NSAppearanceName match = [appearance
      bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua,
                                           NSAppearanceNameDarkAqua ]];
  return [match isEqualToString:NSAppearanceNameDarkAqua];
}

static NSColor *RionRuntimeNeutralColor(BOOL darkAppearance,
                                        CGFloat lightAlpha,
                                        CGFloat darkAlpha) {
  return [NSColor colorWithCalibratedWhite:darkAppearance ? 1.0 : 0.0
                                     alpha:darkAppearance ? darkAlpha : lightAlpha];
}

@implementation RionRuntimeSurfaceView {
  BOOL _active;
  CGFloat _cornerRadius;
  NSView *_effectView;
  BOOL _hovered;
  BOOL _usesLiquidGlass;
  BOOL _windowActive;
}

- (instancetype)initWithContentView:(NSView *)contentView
                       cornerRadius:(CGFloat)cornerRadius {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;

  _contentView = contentView;
  _cornerRadius = cornerRadius;
  self.wantsLayer = YES;

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    NSGlassEffectView *glass = [[NSGlassEffectView alloc] initWithFrame:NSZeroRect];
    glass.cornerRadius = cornerRadius;
    glass.style = NSGlassEffectViewStyleRegular;
    glass.contentView = contentView;
    _effectView = glass;
    _usesLiquidGlass = YES;
  } else
#endif
  {
    NSVisualEffectView *material =
        [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
    material.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    material.material = NSVisualEffectMaterialTitlebar;
    material.state = NSVisualEffectStateFollowsWindowActiveState;
    material.wantsLayer = YES;
    material.layer.cornerRadius = cornerRadius;
    material.layer.masksToBounds = YES;
    [material addSubview:contentView];
    _effectView = material;
  }

  [self addSubview:_effectView];
  [self updateActive:NO hovered:NO windowActive:YES animate:NO];
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (void)layout {
  [super layout];
  _effectView.frame = self.bounds;
  [_effectView layoutSubtreeIfNeeded];
  _contentView.frame = _effectView.bounds;
}

- (void)viewDidChangeEffectiveAppearance {
  [super viewDidChangeEffectiveAppearance];
  [self applyAppearanceAnimated:NO];
}

- (void)updateActive:(BOOL)active
             hovered:(BOOL)hovered
        windowActive:(BOOL)windowActive
             animate:(BOOL)animate {
  _active = active;
  _hovered = hovered;
  _windowActive = windowActive;
  [self applyAppearanceAnimated:animate];
}

- (void)applyAppearanceAnimated:(BOOL)animate {
  NSAppearance *appearance = self.effectiveAppearance;
  BOOL darkAppearance = RionRuntimeUsesDarkAppearance(appearance);
  BOOL increaseContrast =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldIncreaseContrast;
  BOOL reduceTransparency =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency;
  BOOL reduceMotion =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
  CGFloat activeFillAlpha = darkAppearance
                                ? (increaseContrast ? 0.12 : 0.075)
                                : (increaseContrast ? 0.075 : 0.045);
  CGFloat hoverFillAlpha = darkAppearance
                               ? (increaseContrast ? 0.065 : 0.045)
                               : (increaseContrast ? 0.045 : 0.025);
  CGFloat activeBorderAlpha = darkAppearance
                                  ? (increaseContrast ? 0.24 : 0.16)
                                  : (increaseContrast ? 0.18 : 0.12);
  CGFloat hoverBorderAlpha = darkAppearance
                                 ? (increaseContrast ? 0.16 : 0.11)
                                 : (increaseContrast ? 0.13 : 0.08);
  CGFloat visibility = _windowActive ? 1.0 : 0.65;
  CGFloat fillAlpha = _active
                          ? activeFillAlpha * visibility
                          : _hovered ? hoverFillAlpha * visibility : 0.0;
  CGFloat borderAlpha = _active
                            ? activeBorderAlpha * visibility
                            : _hovered ? hoverBorderAlpha * visibility : 0.0;
  NSColor *neutralTint = fillAlpha > 0
                             ? RionRuntimeNeutralColor(darkAppearance,
                                                       fillAlpha,
                                                       fillAlpha)
                             : nil;
  NSColor *surfaceFill = neutralTint ?: NSColor.clearColor;
  NSColor *borderColor = borderAlpha > 0
                             ? RionRuntimeNeutralColor(darkAppearance,
                                                       borderAlpha,
                                                       borderAlpha)
                             : NSColor.clearColor;

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    if (_usesLiquidGlass) {
      NSGlassEffectView *glass = (NSGlassEffectView *)_effectView;
      glass.tintColor = neutralTint;
      glass.alphaValue = _windowActive ? 1.0 : 0.82;
    }
  }
#endif
  if (!_usesLiquidGlass) {
    NSVisualEffectView *material = (NSVisualEffectView *)_effectView;
    material.material = reduceTransparency
                            ? NSVisualEffectMaterialWindowBackground
                            : NSVisualEffectMaterialTitlebar;
    material.emphasized = NO;
    material.alphaValue = _windowActive
                              ? (reduceTransparency || increaseContrast ? 1.0 : 0.96)
                              : 0.78;
    material.layer.backgroundColor = surfaceFill.CGColor;
  }

  void (^updates)(void) = ^{
    self.layer.cornerRadius = self->_cornerRadius;
    self.layer.backgroundColor = surfaceFill.CGColor;
    self.layer.borderWidth = self->_active
                                 ? (increaseContrast ? 0.85 : 0.65)
                                 : self->_hovered ? 0.5 : 0.0;
    self.layer.borderColor = borderColor.CGColor;
    self.layer.opacity = 1.0;
  };
  if (animate && !reduceMotion) {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.14;
      updates();
    } completionHandler:nil];
  } else {
    updates();
  }
}

@end

@implementation RionRuntimeTabItemView {
  __weak NSDraggingSession *_activeDraggingSession;
  BOOL _dragStarted;
  BOOL _dragPreviewYLocked;
  CGFloat _dragPreviewLockedScreenY;
  BOOL _hideTabCloseButton;
  BOOL _hovered;
  NSImageView *_audioView;
  NSImageView *_iconView;
  NSButton *_moreButton;
  NSPoint _pointerDownInTab;
  NSPoint _pointerDownLocation;
  BOOL _pointerTracking;
  NSTrackingArea *_trackingArea;
  NSTextField *_titleField;
  BOOL _windowActive;
}

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (!self) return nil;

  self.focusRingType = NSFocusRingTypeNone;
  self.accessibilityRole = NSAccessibilityRadioButtonRole;

  _iconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _iconView.imageAlignment = NSImageAlignCenter;
  _iconView.imageScaling = NSImageScaleProportionallyDown;
  _iconView.wantsLayer = YES;
  _iconView.layer.cornerRadius = 4.0;
  _iconView.layer.masksToBounds = YES;

  _audioView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _audioView.imageAlignment = NSImageAlignCenter;
  _audioView.imageScaling = NSImageScaleProportionallyDown;
  _audioView.contentTintColor = NSColor.secondaryLabelColor;
  _audioView.toolTip = @"";

  RionRuntimeVerticallyCenteredTextFieldCell *titleCell =
      [[RionRuntimeVerticallyCenteredTextFieldCell alloc] initTextCell:@""];
  titleCell.alignment = NSTextAlignmentLeft;
  titleCell.bezeled = NO;
  titleCell.bordered = NO;
  titleCell.drawsBackground = NO;
  titleCell.editable = NO;
  titleCell.selectable = NO;
  titleCell.usesSingleLineMode = YES;
  titleCell.lineBreakMode = NSLineBreakByTruncatingTail;
  _titleField = [[NSTextField alloc] initWithFrame:NSZeroRect];
  _titleField.cell = titleCell;
  _titleField.focusRingType = NSFocusRingTypeNone;

  NSImage *closeImage = [NSImage imageWithSystemSymbolName:@"xmark"
                                   accessibilityDescription:nil];
  closeImage = [closeImage imageWithSymbolConfiguration:
                         [NSImageSymbolConfiguration configurationWithPointSize:11.0
                                                                        weight:NSFontWeightSemibold]];
  _moreButton = [NSButton buttonWithImage:closeImage
                                   target:self
                                   action:@selector(closePressed:)];
  _moreButton.bordered = NO;
  _moreButton.imageScaling = NSImageScaleProportionallyDown;
  _moreButton.contentTintColor = NSColor.secondaryLabelColor;

  [self addSubview:_iconView];
  [self addSubview:_titleField];
  [self addSubview:_audioView];
  [self addSubview:_moreButton];
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (CGFloat)preferredWidth {
  CGFloat labelWidth = [_titleField.stringValue sizeWithAttributes:@{
    NSFontAttributeName : [NSFont systemFontOfSize:12.0 weight:NSFontWeightSemibold]
  }].width;
  return RionRuntimePreferredTabWidth(labelWidth, _hideTabCloseButton);
}

- (NSSize)intrinsicContentSize {
  return NSMakeSize(self.preferredWidth, kRionTabHeight);
}

- (void)configureWithTab:(RionRuntimeTabModel *)tab
                    image:(NSImage *)image
      hideTabCloseButton:(BOOL)hideTabCloseButton
               closeLabel:(NSString *)closeLabel
        audioPlayingLabel:(NSString *)audioPlayingLabel
           audioMutedLabel:(NSString *)audioMutedLabel
             windowActive:(BOOL)windowActive {
  _windowActive = windowActive;
  self.tabIdentifier = tab.identifier;
  self.activeTab = tab.active;
  _hideTabCloseButton = hideTabCloseButton;
  _iconView.image = image;
  _titleField.stringValue = tab.name;
  NSString *audioLabel = tab.audioMuted ? audioMutedLabel : audioPlayingLabel;
  NSString *audioSymbol = tab.audioMuted ? @"speaker.slash.fill" : @"speaker.wave.2.fill";
  NSImage *audioImage = [NSImage imageWithSystemSymbolName:audioSymbol
                                       accessibilityDescription:nil];
  _audioView.image = [audioImage imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:12.0
                                                       weight:NSFontWeightMedium]];
  _audioView.hidden = !tab.audioMuted && !tab.audible;
  _audioView.toolTip = _audioView.hidden ? @"" : audioLabel;
  _moreButton.identifier = tab.identifier;
  _moreButton.hidden = hideTabCloseButton;
  _moreButton.toolTip = hideTabCloseButton ? @"" : closeLabel;
  _moreButton.accessibilityLabel = hideTabCloseButton ? @"" : closeLabel;
  _moreButton.accessibilityElement = !hideTabCloseButton;
  self.toolTip = tab.tooltip.length > 0 ? tab.tooltip : tab.name;
  self.accessibilityLabel = _audioView.hidden
      ? tab.name
      : [NSString stringWithFormat:@"%@, %@", tab.name, audioLabel];
  self.accessibilityValue = @(tab.active);

  [self invalidateIntrinsicContentSize];
  [self updateVisualStateAnimated:YES];
  self.needsLayout = YES;
}

- (void)layout {
  [super layout];
  CGFloat width = self.bounds.size.width;
  CGFloat x = kRionTabLeadingPadding;
  _iconView.frame =
      NSMakeRect(x, (kRionTabHeight - kRionTabIconSize) / 2.0,
                 kRionTabIconSize, kRionTabIconSize);
  x += kRionTabIconSize + kRionTabIconTitleSpacing;

  CGFloat trailingX = width - kRionTabTrailingPadding;
  CGFloat audioX = 0;
  if (_hideTabCloseButton) {
    _moreButton.frame = NSZeroRect;
    audioX = trailingX - kRionTabAudioIconSize;
  } else {
    CGFloat moreX = MAX(x, trailingX - kRionTabMoreButtonWidth);
    _moreButton.frame =
        NSMakeRect(moreX, 0, kRionTabMoreButtonWidth, kRionTabHeight);
    audioX = moreX - kRionTabAccessorySpacing - kRionTabAudioIconSize;
  }
  _audioView.frame =
      NSMakeRect(audioX, (kRionTabHeight - kRionTabAudioIconSize) / 2.0,
                 kRionTabAudioIconSize, kRionTabAudioIconSize);
  CGFloat titleEnd = audioX - kRionTabAccessorySpacing;
  _titleField.frame =
      NSMakeRect(x, 0, MAX(1.0, titleEnd - x), kRionTabHeight);
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  _hovered = YES;
  [self updateVisualStateAnimated:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  _hovered = NO;
  [self updateVisualStateAnimated:YES];
}

- (void)updateWindowActive:(BOOL)windowActive {
  _windowActive = windowActive;
  [self updateVisualStateAnimated:YES];
}

- (void)updateVisualStateAnimated:(BOOL)animate {
  [_surfaceView updateActive:self.activeTab
                     hovered:_hovered
                windowActive:_windowActive
                     animate:animate];
  _titleField.font = [NSFont systemFontOfSize:12.0
                                       weight:self.activeTab ? NSFontWeightSemibold
                                                             : NSFontWeightRegular];
  _titleField.textColor = self.activeTab
                              ? (_windowActive ? NSColor.labelColor
                                               : NSColor.secondaryLabelColor)
                              : NSColor.secondaryLabelColor;
  CGFloat moreAlpha = _hideTabCloseButton
                          ? 0.0
                          : self.activeTab ? 0.46 : _hovered ? 0.76 : 0.0;
  BOOL reduceMotion =
      NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
  if (animate && !reduceMotion) {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.12;
      self->_moreButton.animator.alphaValue = moreAlpha;
    } completionHandler:nil];
  } else {
    _moreButton.alphaValue = moreAlpha;
  }
}

- (NSView *)hitTest:(NSPoint)point {
  NSView *hit = [super hitTest:point];
  if (hit == _moreButton && !_hideTabCloseButton &&
      _moreButton.alphaValue > 0.05) return hit;
  return hit ? self : nil;
}

- (void)mouseDown:(NSEvent *)event {
  _pointerDownLocation = event.locationInWindow;
  _pointerDownInTab = [self convertPoint:event.locationInWindow fromView:nil];
  _pointerTracking = YES;
  _dragStarted = NO;
}

- (void)mouseDragged:(NSEvent *)event {
  if (!_pointerTracking || _dragStarted) return;
  NSPoint current = event.locationInWindow;
  if (std::hypot(current.x - _pointerDownLocation.x,
                 current.y - _pointerDownLocation.y) >= 3.0) {
    _dragStarted = YES;
    [self.tabsController beginTabDrag:self event:event];
  }
}

- (void)mouseUp:(NSEvent *)event {
  (void)event;
  BOOL shouldActivate = _pointerTracking && !_dragStarted;
  _pointerTracking = NO;
  _dragStarted = NO;
  if (shouldActivate) [NSApp sendAction:self.action to:self.target from:self];
}

- (void)rightMouseDown:(NSEvent *)event {
  (void)event;
  [self.tabsController performSelector:@selector(showTabMenu:)
                             withObject:self.tabIdentifier];
}

- (void)closePressed:(id)sender {
  (void)sender;
  [self.tabsController performSelector:@selector(closeTab:)
                             withObject:self.tabIdentifier];
}

- (void)applyDragPreviewYLock {
  if (!_dragPreviewYLocked || !_activeDraggingSession) return;
  CGFloat lockedScreenY = _dragPreviewLockedScreenY;
  [_activeDraggingSession
      enumerateDraggingItemsWithOptions:0
                                forView:nil
                                classes:@[ NSPasteboardItem.class ]
                          searchOptions:@{}
                             usingBlock:^(NSDraggingItem *draggingItem,
                                          NSInteger index, BOOL *stop) {
    (void)index;
    (void)stop;
    draggingItem.draggingFrame = RionRuntimeDragFrameWithLockedY(
        draggingItem.draggingFrame, lockedScreenY);
  }];
}

- (void)beginDragPreviewSession:(NSDraggingSession *)session
                  lockedScreenY:(CGFloat)screenY {
  _activeDraggingSession = session;
  [self lockDragPreviewToScreenY:screenY];
}

- (void)lockDragPreviewToScreenY:(CGFloat)screenY {
  if (!std::isfinite(screenY)) return;
  _dragPreviewYLocked = YES;
  _dragPreviewLockedScreenY = screenY;
  [self applyDragPreviewYLock];
}

- (void)clearDragPreviewYLock {
  _dragPreviewYLocked = NO;
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  (void)session;
  (void)context;
  return NSDragOperationMove;
}

- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session {
  (void)session;
  return YES;
}

- (void)draggingSession:(NSDraggingSession *)session
          movedToPoint:(NSPoint)screenPoint {
  _activeDraggingSession = session;
  [self applyDragPreviewYLock];
  if (self.dragSessionID.length > 0) {
    [self.tabsController moveTabDrag:self atScreenPoint:screenPoint];
  }
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation {
  (void)session;
  [self clearDragPreviewYLock];
  _activeDraggingSession = nil;
  NSEvent *event = NSApp.currentEvent;
  BOOL cancelledWithEscape =
      event.type == NSEventTypeKeyDown && event.keyCode == 53;
  BOOL captureWasCancelled =
      event && event.type != NSEventTypeLeftMouseUp && !cancelledWithEscape;
  if (operation != NSDragOperationNone) {
    self.dragSessionID = @"";
    return;
  }
  [self.tabsController endTabDrag:self
                      screenPoint:screenPoint
                        cancelled:cancelledWithEscape || captureWasCancelled];
}

- (NSPoint)grabRatio {
  CGFloat width = MAX(1.0, self.bounds.size.width);
  CGFloat height = MAX(1.0, self.bounds.size.height);
  return NSMakePoint(MIN(1.0, MAX(0.0, _pointerDownInTab.x / width)),
                     MIN(1.0, MAX(0.0, _pointerDownInTab.y / height)));
}

@end

@implementation RionRuntimeAddButton {
  NSTrackingArea *_trackingArea;
}

- (BOOL)isFlipped {
  return YES;
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  [_surfaceView updateActive:NO hovered:YES windowActive:self.window.isKeyWindow animate:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  [_surfaceView updateActive:NO hovered:NO windowActive:self.window.isKeyWindow animate:YES];
}

@end

@implementation RionRuntimeTabsRootView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    [self registerForDraggedTypes:@[ RionRuntimeTabPasteboardType ]];
  }
  return self;
}

- (NSSize)intrinsicContentSize {
  return NSMakeSize(NSViewNoIntrinsicMetric, kRionTitlebarHeight);
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
  return [self draggingUpdated:sender];
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
  if (![[sender draggingPasteboard]
          availableTypeFromArray:@[ RionRuntimeTabPasteboardType ]]) {
    return NSDragOperationNone;
  }
  NSPoint point = [self convertPoint:sender.draggingLocation fromView:nil];
  [self.tabsController scrollTabStripForDragPoint:point inView:self];
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = RionRuntimeTabDragPayloadParts(payload);
  if (parts) {
    CGFloat grabRatioX = parts[3].doubleValue;
    CGFloat sourceTabWidth = parts[5].doubleValue;
    id source = sender.draggingSource;
    if ([source isKindOfClass:RionRuntimeTabItemView.class]) {
      [(RionRuntimeTabItemView *)source
          lockDragPreviewToScreenY:self.tabsController.dragPreviewScreenOriginY];
    }
    [self.tabsController setDragPlaceholderIdentifier:parts[1]];
    [self.tabsController positionDragSurfaceForTabIdentifier:parts[1]
                                                     atPoint:point
                                                      inView:self
                                                  grabRatioX:grabRatioX];
    NSString *identifier =
        [self.tabsController stableTabIdentifierBeforePoint:point
                                                     inView:self
                                       draggedTabIdentifier:parts[1]
                                                  sessionID:parts[2]
                                                 grabRatioX:grabRatioX
                                             sourceTabWidth:sourceTabWidth];
    [self.tabsController previewDragTabIdentifier:parts[1]
                                  beforeIdentifier:identifier];
    [self.tabsController hideInsertionIndicator];
    NSPoint screenPoint =
        [self.window convertPointToScreen:sender.draggingLocation];
    [self.tabsController handleHoverWithTabIdentifier:parts[1]
                                        sourceWindowID:parts[0]
                                             sessionID:parts[2]
                                      beforeIdentifier:identifier
                                           screenPoint:screenPoint];
  } else {
    NSString *identifier =
        [self.tabsController tabIdentifierBeforePoint:point inView:self];
    [self.tabsController updateInsertionIndicatorBeforeIdentifier:identifier];
  }
  return NSDragOperationMove;
}

- (void)draggingExited:(nullable id<NSDraggingInfo>)sender {
  id source = sender.draggingSource;
  if ([source isKindOfClass:RionRuntimeTabItemView.class]) {
    [(RionRuntimeTabItemView *)source clearDragPreviewYLock];
  }
  [self.tabsController hideInsertionIndicator];
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = RionRuntimeTabDragPayloadParts(payload);
  if (parts) {
    [self.tabsController hideDragSurfaceForTabIdentifier:parts[1]];
  } else {
    [self.tabsController setDragPlaceholderIdentifier:nil];
  }
  [self.tabsController resetTabDragInsertionState];
  [self.tabsController stopTabDragEdgeScroll];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
  NSString *payload = [[sender draggingPasteboard]
      stringForType:RionRuntimeTabPasteboardType];
  NSArray<NSString *> *parts = RionRuntimeTabDragPayloadParts(payload);
  if (!parts) return NO;
  NSString *sourceWindowID = parts[0];
  NSString *tabIdentifier = parts[1];
  NSString *sessionID = parts[2];
  NSPoint point = [self convertPoint:sender.draggingLocation fromView:nil];
  NSString *beforeIdentifier =
      [self.tabsController stableTabIdentifierBeforePoint:point
                                                   inView:self
                                     draggedTabIdentifier:tabIdentifier
                                                sessionID:sessionID
                                               grabRatioX:parts[3].doubleValue
                                           sourceTabWidth:parts[5].doubleValue];
  [self.tabsController previewDragTabIdentifier:tabIdentifier
                                beforeIdentifier:beforeIdentifier];
  NSPoint screenPoint =
      [self.window convertPointToScreen:sender.draggingLocation];
  id source = sender.draggingSource;
  if ([source isKindOfClass:RionRuntimeTabItemView.class]) {
    [(RionRuntimeTabItemView *)source clearDragPreviewYLock];
  }
  [self.tabsController hideInsertionIndicator];
  [self.tabsController setDragPlaceholderIdentifier:nil];
  [self.tabsController resetTabDragInsertionState];
  [self.tabsController stopTabDragEdgeScroll];
  [self.tabsController handleDropWithTabIdentifier:tabIdentifier
                                    sourceWindowID:sourceWindowID
                                         sessionID:sessionID
                                  beforeIdentifier:beforeIdentifier
                                       screenPoint:screenPoint];
  return YES;
}

@end

@implementation RionRuntimeTitlebarAccessoryViewController

- (void)viewDidAppear {
  [super viewDidAppear];
  if (self.appearanceHandler) self.appearanceHandler();
}

@end

@implementation RionRuntimeTabsController {
  RionRuntimeTabsActionHandler _actionHandler;
  RionRuntimeContentLayoutHandler _contentLayoutHandler;
  RionRuntimeTitlebarAccessoryViewController *_accessoryController;
  RionRuntimeSurfaceView *_addSurface;
  RionRuntimeAddButton *_addButton;
  RionRuntimeSurfaceView *_scrollLeftSurface;
  RionRuntimeAddButton *_scrollLeftButton;
  RionRuntimeSurfaceView *_scrollRightSurface;
  RionRuntimeAddButton *_scrollRightButton;
  NSView *_clusterContainer;
  RionRuntimeDraggableView *_clusterContent;
  NSString *_windowID;
  NSView *_insertionIndicator;
  NSString *_dragPlaceholderTabIdentifier;
  NSString *_dragInsertionSessionIdentifier;
  NSString *_dragInsertionBeforeIdentifier;
  CGFloat _dragInsertionVisualCenterX;
  CGFloat _dragSurfaceCanvasX;
  BOOL _dragSurfaceOverlayActive;
  BOOL _dragSurfaceVisible;
  CGFloat _dragScrollRootX;
  NSTimer *_dragScrollTimer;
  NSMutableArray<NSButton *> *_observedTrafficLightButtons;
  NSMutableDictionary<NSValue *, NSDictionary<NSString *, NSNumber *> *> *
      _originalTrafficLightStates;
  NSMutableDictionary<NSNumber *, NSValue *> *_windowedTrafficLightFrames;
  RionRuntimeWindowNameField *_windowNameField;
  NSToolbar *_fullscreenToolbar;
  NSToolbar *_toolbar;
  dispatch_block_t _pendingContentLayoutNotification;
  dispatch_block_t _pendingFullscreenHostRefresh;
  RionRuntimeDraggableView *_tabCanvas;
  __weak RionRuntimeTabItemView *_activeTabItem;
  NSMutableArray<RionRuntimeTabItemView *> *_tabItems;
  NSMutableDictionary<NSString *, RionRuntimeTabItemView *> *_tabItemsByIdentifier;
  NSMutableDictionary<NSString *, NSImage *> *_tabIconCache;
  NSMutableDictionary<NSString *, NSString *> *_tabIconCacheKeys;
  NSScrollView *_tabScrollView;
  NSMutableArray<RionRuntimeSurfaceView *> *_tabSurfaces;
  RionRuntimeBackdropView *_titlebarBackdrop;
  __weak NSView *_titlebarFrameView;
  NSHashTable<NSView *> *_titlebarWidgetInsetFrameViews;
  __weak NSWindow *_fullscreenTitlebarHostWindow;
  NSWindowTitleVisibility _previousTitleVisibility;
  BOOL _previousTitlebarAppearsTransparent;
  NSTitlebarSeparatorStyle _previousTitlebarSeparatorStyle;
  NSWindowToolbarStyle _previousToolbarStyle;
  NSToolbar *_previousToolbar;
  BOOL _previousFullSizeContentView;
  CGFloat _previousCustomTitlebarHeight;
  BOOL _hasPreviousCustomTitlebarHeight;
  CGFloat _stableTitlebarWidgetInset;
  BOOL _hasStableTitlebarWidgetInset;
  __weak NSWindow *_window;
  __weak NSResponder *_tabShortcutOriginResponder;
  NSString *_tabShortcutOriginTabIdentifier;
  NSEventModifierFlags _tabShortcutPendingModifiers;
  NSMutableArray<id> *_windowObservers;
  id _tabShortcutMonitor;
  BOOL _destroyed;
  BOOL _contentLayoutObserved;
  BOOL _enforcingTrafficLightVisibility;
  BOOL _hasLastNotifiedContentLayout;
  BOOL _fullscreenTransitionActive;
  BOOL _fullscreenHostReady;
  RionRuntimeContentLayout _lastNotifiedContentLayout;
  CGFloat _stableTrafficLightReserveWidth;
}

- (nullable instancetype)initWithWindow:(NSWindow *)window
                       windowIdentifier:(NSString *)windowIdentifier
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler
                    contentLayoutHandler:
                        (RionRuntimeContentLayoutHandler)contentLayoutHandler {
  if (!window || windowIdentifier.length == 0 || !actionHandler ||
      !contentLayoutHandler) {
    return nil;
  }
  self = [super init];
  if (!self) return nil;

  _window = window;
  // The plus button exists before the first tab. Bind the controller to its
  // Game Window during construction so an empty host can still scope
  // openLauncher to the correct launch target.
  _windowID = [windowIdentifier copy];
  _hasPreviousCustomTitlebarHeight =
      [self readCustomTitlebarHeight:&_previousCustomTitlebarHeight
                       fromFrameView:window.contentView.superview];
  _hasStableTitlebarWidgetInset =
      [self readTitlebarWidgetInset:&_stableTitlebarWidgetInset
                      fromFrameView:window.contentView.superview];
  [self ensureTitlebarHeightOverride];
  _actionHandler = [actionHandler copy];
  _contentLayoutHandler = [contentLayoutHandler copy];
  _observedTrafficLightButtons = [NSMutableArray array];
  _originalTrafficLightStates = [NSMutableDictionary dictionary];
  _windowedTrafficLightFrames = [NSMutableDictionary dictionary];
  _tabItems = [NSMutableArray array];
  _tabItemsByIdentifier = [NSMutableDictionary dictionary];
  _tabIconCache = [NSMutableDictionary dictionary];
  _tabIconCacheKeys = [NSMutableDictionary dictionary];
  _tabSurfaces = [NSMutableArray array];
  _titlebarWidgetInsetFrameViews = [NSHashTable weakObjectsHashTable];
  _windowObservers = [NSMutableArray array];
  _previousTitleVisibility = window.titleVisibility;
  _previousTitlebarAppearsTransparent = window.titlebarAppearsTransparent;
  if (@available(macOS 11.0, *)) {
    _previousTitlebarSeparatorStyle = window.titlebarSeparatorStyle;
  }
  _previousToolbarStyle = window.toolbarStyle;
  _previousToolbar = window.toolbar;
  _previousFullSizeContentView =
      (window.styleMask & NSWindowStyleMaskFullSizeContentView) != 0;
  _fullscreenTransitionActive =
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  _fullscreenHostReady = _fullscreenTransitionActive;
  _stableTrafficLightReserveWidth = kRionTrafficLightFallbackWidth;

  window.titleVisibility = NSWindowTitleHidden;
  window.titlebarAppearsTransparent = YES;
  if (@available(macOS 11.0, *)) {
    window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
  }

  _toolbar = [self makeWindowedToolbar];
  _fullscreenToolbar = [self makeFullScreenToolbar];
  _toolbar.visible = YES;
  window.toolbar = _toolbar;
  [self ensureTitlebarHeightOverride];

  RionRuntimeTabsRootView *root = [[RionRuntimeTabsRootView alloc]
      initWithFrame:NSMakeRect(0, 0, MAX(1.0, window.frame.size.width),
                               kRionTitlebarHeight)];
  root.tabsController = self;
  _titlebarBackdrop = [[RionRuntimeBackdropView alloc] initWithFrame:root.bounds];
  _titlebarBackdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  _titlebarBackdrop.material = NSVisualEffectMaterialHeaderView;
  _titlebarBackdrop.state = NSVisualEffectStateFollowsWindowActiveState;
  [root addSubview:_titlebarBackdrop];
  _clusterContent = [[RionRuntimeDraggableView alloc] initWithFrame:root.bounds];

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
  if (@available(macOS 26.0, *)) {
    NSGlassEffectContainerView *glassContainer =
        [[NSGlassEffectContainerView alloc] initWithFrame:root.bounds];
    glassContainer.spacing = kRionTabSpacing;
    glassContainer.contentView = _clusterContent;
    _clusterContainer = glassContainer;
  } else
#endif
  {
    _clusterContainer = _clusterContent;
  }
  [root addSubview:_clusterContainer];

  _tabScrollView = [[RionRuntimeHorizontalScrollView alloc] initWithFrame:NSZeroRect];
  _tabScrollView.autohidesScrollers = YES;
  _tabScrollView.borderType = NSNoBorder;
  _tabScrollView.drawsBackground = NO;
  _tabScrollView.hasHorizontalScroller = NO;
  _tabScrollView.hasVerticalScroller = NO;
  _tabScrollView.horizontalScrollElasticity = NSScrollElasticityAllowed;
  _tabScrollView.verticalScrollElasticity = NSScrollElasticityNone;
  _tabCanvas = [[RionRuntimeDraggableView alloc] initWithFrame:NSZeroRect];
  _tabCanvas.accessibilityRole = NSAccessibilityTabGroupRole;
  _tabScrollView.documentView = _tabCanvas;
  _tabScrollView.contentView.postsBoundsChangedNotifications = YES;

  RionRuntimeVerticallyCenteredTextFieldCell *windowNameCell =
      [[RionRuntimeVerticallyCenteredTextFieldCell alloc] initTextCell:@""];
  windowNameCell.alignment = NSTextAlignmentLeft;
  windowNameCell.bezeled = NO;
  windowNameCell.bordered = NO;
  windowNameCell.drawsBackground = NO;
  windowNameCell.editable = NO;
  windowNameCell.selectable = NO;
  windowNameCell.usesSingleLineMode = YES;
  windowNameCell.lineBreakMode = NSLineBreakByTruncatingTail;
  _windowNameField = [[RionRuntimeWindowNameField alloc] initWithFrame:NSZeroRect];
  _windowNameField.cell = windowNameCell;
  _windowNameField.focusRingType = NSFocusRingTypeNone;
  _windowNameField.enabled = YES;
  _windowNameField.font = [NSFont systemFontOfSize:12.0 weight:NSFontWeightSemibold];
  _windowNameField.textColor = NSColor.labelColor;
  _windowNameField.hidden = YES;

  NSImage *scrollLeft = [NSImage imageWithSystemSymbolName:@"chevron.left"
                                  accessibilityDescription:nil];
  scrollLeft = [scrollLeft imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:9.0
                                                      weight:NSFontWeightSemibold]];
  _scrollLeftButton = [RionRuntimeAddButton buttonWithImage:scrollLeft
                                                     target:self
                                                     action:@selector(scrollTabsLeft:)];
  _scrollLeftButton.bordered = NO;
  _scrollLeftButton.imageScaling = NSImageScaleProportionallyDown;
  _scrollLeftButton.contentTintColor = NSColor.secondaryLabelColor;
  _scrollLeftSurface = [[RionRuntimeSurfaceView alloc]
      initWithContentView:_scrollLeftButton cornerRadius:7.0];
  _scrollLeftButton.surfaceView = _scrollLeftSurface;
  _scrollLeftSurface.hidden = YES;

  NSImage *scrollRight = [NSImage imageWithSystemSymbolName:@"chevron.right"
                                   accessibilityDescription:nil];
  scrollRight = [scrollRight imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:9.0
                                                      weight:NSFontWeightSemibold]];
  _scrollRightButton = [RionRuntimeAddButton buttonWithImage:scrollRight
                                                      target:self
                                                      action:@selector(scrollTabsRight:)];
  _scrollRightButton.bordered = NO;
  _scrollRightButton.imageScaling = NSImageScaleProportionallyDown;
  _scrollRightButton.contentTintColor = NSColor.secondaryLabelColor;
  _scrollRightSurface = [[RionRuntimeSurfaceView alloc]
      initWithContentView:_scrollRightButton cornerRadius:7.0];
  _scrollRightButton.surfaceView = _scrollRightSurface;
  _scrollRightSurface.hidden = YES;

  NSImage *plus = [NSImage imageWithSystemSymbolName:@"plus"
                           accessibilityDescription:nil];
  plus = [plus imageWithSymbolConfiguration:
                   [NSImageSymbolConfiguration configurationWithPointSize:11.0
                                                                  weight:NSFontWeightSemibold]];
  _addButton = [RionRuntimeAddButton buttonWithImage:plus
                                              target:self
                                              action:@selector(openLauncher:)];
  _addButton.bordered = NO;
  _addButton.tag = kRionAddButtonTag;
  _addButton.imageScaling = NSImageScaleProportionallyDown;
  _addButton.contentTintColor = NSColor.secondaryLabelColor;
  _addSurface = [[RionRuntimeSurfaceView alloc] initWithContentView:_addButton
                                                       cornerRadius:14.0];
  _addButton.surfaceView = _addSurface;

  [_clusterContent addSubview:_scrollLeftSurface];
  [_clusterContent addSubview:_windowNameField];
  [_clusterContent addSubview:_tabScrollView];
  [_clusterContent addSubview:_scrollRightSurface];
  [_clusterContent addSubview:_addSurface];

  __weak RionRuntimeTabsController *weakScrollSelf = self;
  id scrollObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:NSViewBoundsDidChangeNotification
                  object:_tabScrollView.contentView
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(__unused NSNotification *notification) {
                [weakScrollSelf updateTabScrollButtonState];
              }];
  [_windowObservers addObject:scrollObserver];

  _insertionIndicator = [[NSView alloc] initWithFrame:NSZeroRect];
  _insertionIndicator.wantsLayer = YES;
  _insertionIndicator.layer.backgroundColor = NSColor.controlAccentColor.CGColor;
  _insertionIndicator.layer.cornerRadius = 1.0;
  _insertionIndicator.hidden = YES;
  [root addSubview:_insertionIndicator];

  _accessoryController =
      [[RionRuntimeTitlebarAccessoryViewController alloc] init];
  _accessoryController.layoutAttribute = NSLayoutAttributeTrailing;
  _accessoryController.fullScreenMinHeight = 0;
  _accessoryController.view = root;
  __weak RionRuntimeTabsController *weakSelf = self;
  _accessoryController.appearanceHandler = ^{
    [weakSelf scheduleFullscreenHostRefresh];
  };
  [self applyLiquidGlassTitlebarAppearance];
  [self configureAccessoryForTitlebar];
  [self attachAccessoryController];
  [self layoutTitlebarContent];
  [self captureWindowedTrafficLightFrames];
  [self installWindowObservers];
  __weak RionRuntimeTabsController *weakShortcutSelf = self;
  _tabShortcutMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:(NSEventMaskKeyDown |
                                             NSEventMaskFlagsChanged)
                                handler:^NSEvent *(NSEvent *event) {
    RionRuntimeTabsController *strongSelf = weakShortcutSelf;
    if (!strongSelf || strongSelf->_destroyed || event.window != strongSelf->_window) {
      return event;
    }
    if (event.type == NSEventTypeFlagsChanged) {
      [strongSelf handleTabShortcutModifierEvent:event];
      return event;
    }
    if (event.keyCode != 48) return event;
    NSEventModifierFlags flags = event.modifierFlags &
        NSEventModifierFlagDeviceIndependentFlagsMask;
    if ((flags & NSEventModifierFlagControl) == 0 ||
        (flags & (NSEventModifierFlagCommand | NSEventModifierFlagOption |
                  NSEventModifierFlagFunction)) != 0 ||
        strongSelf->_tabItems.count < 2) {
      return event;
    }
    NSUInteger activeIndex = [strongSelf->_tabItems indexOfObjectPassingTest:
        ^BOOL(RionRuntimeTabItemView *item, NSUInteger index, BOOL *stop) {
      (void)index;
      if (item.activeTab) *stop = YES;
      return item.activeTab;
    }];
    if (activeIndex == NSNotFound) activeIndex = 0;
    BOOL previous = (flags & NSEventModifierFlagShift) != 0;
    NSUInteger count = strongSelf->_tabItems.count;
    NSUInteger targetIndex = previous ? (activeIndex + count - 1) % count
                                      : (activeIndex + 1) % count;
    [strongSelf beginTabShortcutModifierHandoff:flags];
    [strongSelf activateTab:strongSelf->_tabItems[targetIndex].tabIdentifier];
    return nil;
  }];
  // A controller can be created for a window that is already fullscreen
  // (for example after a display-host rebuild). Register that settled state
  // immediately instead of waiting for a future fullscreen notification.
  [self updateFullscreenToolbarPresentationPolicy];
  return self;
}

- (BOOL)attachTitlebarHeightOverrideToFrameView:(nullable NSView *)frameView {
  if (!frameView || !RionInstallTitlebarHeightHook(frameView)) return NO;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarHeightAssociationKey,
                           @(kRionTitlebarHeight),
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  frameView.needsLayout = YES;
  return YES;
}

- (void)detachTitlebarHeightOverrideFromFrameView:(nullable NSView *)frameView {
  if (!frameView) return;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarHeightAssociationKey,
                           nil,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  frameView.needsLayout = YES;
}

- (void)ensureTitlebarHeightOverride {
  if (_destroyed || !_window) return;
  NSView *currentFrameView = _window.contentView.superview;
  if (currentFrameView == _titlebarFrameView) {
    [self attachTitlebarHeightOverrideToFrameView:currentFrameView];
    return;
  }

  [self detachTitlebarHeightOverrideFromFrameView:_titlebarFrameView];
  _titlebarFrameView = nil;
  if ([self attachTitlebarHeightOverrideToFrameView:currentFrameView]) {
    _titlebarFrameView = currentFrameView;
  }
}

- (BOOL)readTitlebarWidgetInset:(CGFloat *)inset
                  fromFrameView:(nullable NSView *)frameView {
  if (!frameView || !inset) return NO;
  SEL selector = NSSelectorFromString(@"_minXTitlebarWidgetInset");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation invoke];
  [invocation getReturnValue:inset];
  return YES;
}

- (BOOL)attachTitlebarWidgetInsetOverride:(CGFloat)inset
                              toFrameView:(nullable NSView *)frameView {
  if (!frameView || !RionInstallTitlebarWidgetInsetHook(frameView)) return NO;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarWidgetInsetAssociationKey,
                           @(inset),
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [_titlebarWidgetInsetFrameViews addObject:frameView];
  frameView.needsLayout = YES;
  return YES;
}

- (void)detachTitlebarWidgetInsetOverrideFromFrameView:
    (nullable NSView *)frameView {
  if (!frameView) return;
  objc_setAssociatedObject(frameView,
                           &RionRuntimeTitlebarWidgetInsetAssociationKey,
                           nil,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [_titlebarWidgetInsetFrameViews removeObject:frameView];
  frameView.needsLayout = YES;
}

- (void)detachTitlebarWidgetInsetOverrides {
  for (NSView *frameView in _titlebarWidgetInsetFrameViews.allObjects) {
    objc_setAssociatedObject(frameView,
                             &RionRuntimeTitlebarWidgetInsetAssociationKey,
                             nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    frameView.needsLayout = YES;
  }
  [_titlebarWidgetInsetFrameViews removeAllObjects];
}

- (void)ensureFullScreenTitlebarWidgetInsetOverrides {
  if (_destroyed || !_window || !_hasStableTitlebarWidgetInset ||
      (_window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
    [self detachTitlebarWidgetInsetOverrides];
    return;
  }
  if (@available(macOS 26.0, *)) {
    NSMutableOrderedSet<NSView *> *frameViews = [NSMutableOrderedSet orderedSet];
    void (^addFrameForWindow)(NSWindow *_Nullable) =
        ^(NSWindow *_Nullable candidateWindow) {
      NSView *frameView = candidateWindow.contentView.superview;
      if (frameView) [frameViews addObject:frameView];
    };

    addFrameForWindow(_window);
    addFrameForWindow(_accessoryController.view.window);
    NSButton *closeButton = [_window standardWindowButton:NSWindowCloseButton];
    addFrameForWindow(closeButton.window);

    for (NSView *trackedFrameView in
             _titlebarWidgetInsetFrameViews.allObjects) {
      if (![frameViews containsObject:trackedFrameView]) {
        [self detachTitlebarWidgetInsetOverrideFromFrameView:trackedFrameView];
      }
    }
    for (NSView *frameView in frameViews) {
      [self attachTitlebarWidgetInsetOverride:_stableTitlebarWidgetInset
                                  toFrameView:frameView];
    }
  } else {
    [self detachTitlebarWidgetInsetOverrides];
  }
}

- (BOOL)readCustomTitlebarHeight:(CGFloat *)height
                   fromFrameView:(nullable NSView *)frameView {
  if (!frameView || !height) return NO;
  SEL selector = NSSelectorFromString(@"customTitlebarHeight");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  if (!signature || signature.numberOfArguments != 2 ||
      signature.methodReturnLength != sizeof(CGFloat) ||
      std::strcmp(signature.methodReturnType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation invoke];
  [invocation getReturnValue:height];
  return YES;
}

- (BOOL)setCustomTitlebarHeight:(CGFloat)height
                    onFrameView:(nullable NSView *)frameView {
  if (!frameView) return NO;
  SEL selector = NSSelectorFromString(@"setCustomTitlebarHeight:");
  if (![frameView respondsToSelector:selector]) return NO;

  NSMethodSignature *signature =
      [frameView methodSignatureForSelector:selector];
  const char *argumentType = signature && signature.numberOfArguments == 3
      ? [signature getArgumentTypeAtIndex:2]
      : nullptr;
  if (!signature || signature.numberOfArguments != 3 ||
      signature.methodReturnLength != 0 ||
      std::strcmp(signature.methodReturnType, @encode(void)) != 0 ||
      !argumentType ||
      std::strcmp(argumentType, @encode(CGFloat)) != 0) {
    return NO;
  }

  NSInvocation *invocation =
      [NSInvocation invocationWithMethodSignature:signature];
  invocation.target = frameView;
  invocation.selector = selector;
  [invocation setArgument:&height atIndex:2];
  [invocation invoke];
  return YES;
}

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

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
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
      if ([notification.name isEqualToString:NSWindowDidResizeNotification]) {
        [strongSelf layoutTitlebarContent];
        [strongSelf scheduleContentLayoutNotification];
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
        [strongSelf updateFullscreenToolbarPresentationPolicy];
        // AppKit has already built NSToolbarFullScreenWindow. Never replace its
        // toolbar here; apply the final native visibility and frame geometry.
        [strongSelf attachAccessoryController];
        [strongSelf applyFullScreenPolicy];
        [strongSelf scheduleLiquidGlassTitlebarRehost];
        [strongSelf scheduleFullscreenHostRefresh];
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

- (CGFloat)tabsContentWidth {
  CGFloat width = 0;
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    width += _tabItems[index].preferredWidth;
    if (index > 0) width += kRionTabSpacing;
  }
  return width;
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
  _clusterContainer.frame = root.bounds;
  _clusterContent.frame = root.bounds;

  CGFloat leadingInset = [self trafficLightReserveWidth] + kRionRootLeadingInset;
  CGFloat windowNameWidth = 0;
  if (!_windowNameField.hidden) {
    windowNameWidth = MIN(kRionWindowNameMaximumWidth,
                          ceil(_windowNameField.intrinsicContentSize.width));
    _windowNameField.frame = NSMakeRect(
        leadingInset, MAX(0, (rootHeight - kRionTabHeight) / 2.0),
        windowNameWidth, kRionTabHeight);
    leadingInset += windowNameWidth + kRionWindowNameTrailingSpacing;
  } else {
    _windowNameField.frame = NSZeroRect;
  }
  CGFloat tabsWidth = [self tabsContentWidth];
  CGFloat availableWithoutScrollControls = MAX(
      0,
      rootWidth - leadingInset - kRionRootTrailingDraggableWidth -
          kRionTabHeight - kRionAddButtonSpacing);
  BOOL overflowing =
      RionRuntimeTabsOverflow(tabsWidth, availableWithoutScrollControls);
  CGFloat scrollControlsWidth = overflowing
      ? 2.0 * (kRionTabScrollButtonWidth + kRionTabScrollButtonSpacing)
      : 0.0;
  CGFloat maximumViewportWidth =
      MAX(0, availableWithoutScrollControls - scrollControlsWidth);
  CGFloat viewportWidth = MIN(tabsWidth, maximumViewportWidth);
  CGFloat verticalInset = MAX(0, (rootHeight - kRionTabHeight) / 2.0);
  CGFloat scrollViewX = leadingInset;
  _scrollLeftSurface.hidden = !overflowing;
  _scrollRightSurface.hidden = !overflowing;
  if (overflowing) {
    _scrollLeftSurface.frame =
        NSMakeRect(leadingInset, verticalInset, kRionTabScrollButtonWidth,
                   kRionTabHeight);
    _scrollLeftButton.frame = _scrollLeftSurface.bounds;
    scrollViewX += kRionTabScrollButtonWidth + kRionTabScrollButtonSpacing;
  } else {
    _scrollLeftSurface.frame = NSZeroRect;
    _scrollRightSurface.frame = NSZeroRect;
  }
  _tabScrollView.frame = NSMakeRect(scrollViewX, verticalInset,
                                    viewportWidth, kRionTabHeight);
  _tabCanvas.frame = NSMakeRect(0, 0, MAX(tabsWidth, viewportWidth), kRionTabHeight);

  CGFloat x = 0;
  RionRuntimeSurfaceView *dragSurface = nil;
  for (NSUInteger index = 0; index < _tabItems.count; ++index) {
    RionRuntimeTabItemView *item = _tabItems[index];
    RionRuntimeSurfaceView *surface = _tabSurfaces[index];
    CGFloat width = item.preferredWidth;
    BOOL lifted = _dragSurfaceOverlayActive &&
        [_dragPlaceholderTabIdentifier isEqualToString:item.tabIdentifier];
    surface.frame = lifted
        ? NSMakeRect(_dragSurfaceCanvasX, 0, width, kRionTabHeight)
        : NSMakeRect(x, 0, width, kRionTabHeight);
    if (lifted) dragSurface = surface;
    [surface layoutSubtreeIfNeeded];
    item.frame = surface.bounds;
    [item layoutSubtreeIfNeeded];
    x += width + kRionTabSpacing;
  }
  if (dragSurface) {
    [_tabCanvas addSubview:dragSurface positioned:NSWindowAbove relativeTo:nil];
  }
  CGFloat tabsEndX = scrollViewX + viewportWidth;
  if (overflowing) {
    _scrollRightSurface.frame =
        NSMakeRect(tabsEndX + kRionTabScrollButtonSpacing, verticalInset,
                   kRionTabScrollButtonWidth, kRionTabHeight);
    _scrollRightButton.frame = _scrollRightSurface.bounds;
    tabsEndX = NSMaxX(_scrollRightSurface.frame);
  }
  _addSurface.frame = NSMakeRect(tabsEndX + kRionAddButtonSpacing,
                                 verticalInset, kRionTabHeight, kRionTabHeight);
  _addButton.frame = _addSurface.bounds;

  if (!_dragSurfaceOverlayActive) {
    [self scrollActiveTabIntoView];
  }
  [self updateTabScrollButtonState];
}

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
  CGFloat originX = RionRuntimeRevealScrollOrigin(
      NSMinX(activeFrame), NSMaxX(activeFrame), visible.origin.x,
      visible.size.width, _tabCanvas.frame.size.width);
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

- (void)scrollTabsLeft:(id)sender {
  (void)sender;
  NSRect visible = _tabScrollView.contentView.bounds;
  CGFloat targetX = 0;
  for (NSView *surface in _tabSurfaces) {
    if (NSMinX(surface.frame) < NSMinX(visible) - 1.0) {
      targetX = NSMinX(surface.frame);
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
  CGFloat maximumOrigin =
      MAX(0, _tabCanvas.frame.size.width - visible.size.width);
  CGFloat targetX = maximumOrigin;
  for (NSView *surface in _tabSurfaces) {
    if (NSMaxX(surface.frame) > NSMaxX(visible) + 1.0) {
      targetX = NSMaxX(surface.frame) - visible.size.width;
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

- (void)setActiveTabIdentifier:(nullable NSString *)tabIdentifier {
  if (_destroyed) return;
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
    RionRuntimeTabModel *tab = [[RionRuntimeTabModel alloc] init];
    tab.active = NO;
    tab.audible = NO;
    tab.audioMuted = NO;
    tab.identifier = tabIdentifier;
    tab.name = name.length > 0 ? name : tabIdentifier;
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
    [_tabItems addObject:item];
    [_tabSurfaces addObject:surface];
    [_tabCanvas addSubview:surface];
    _tabItemsByIdentifier[tabIdentifier] = item;
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

- (void)replaceTabIdentifier:(NSString *)provisionalIdentifier
              withIdentifier:(NSString *)tabIdentifier
                        name:(NSString *)name
                        type:(NSString *)type
           workspaceTemplate:(nullable NSString *)workspaceTemplate
         activeTabIdentifier:(nullable NSString *)activeTabIdentifier {
  if (_destroyed || provisionalIdentifier.length == 0 ||
      tabIdentifier.length == 0) return;
  NSUInteger index = [_tabItems indexOfObjectPassingTest:
      ^BOOL(RionRuntimeTabItemView *item, NSUInteger candidateIndex, BOOL *stop) {
    (void)candidateIndex;
    BOOL matches = [item.tabIdentifier isEqualToString:provisionalIdentifier];
    if (matches) *stop = YES;
    return matches;
  }];
  if (index == NSNotFound) {
    [self reserveTabIdentifier:tabIdentifier
                          name:name
                          type:type
             workspaceTemplate:workspaceTemplate
              windowIdentifier:_windowID ?: @""];
    [self setActiveTabIdentifier:activeTabIdentifier];
    return;
  }
  RionRuntimeTabModel *tab = [[RionRuntimeTabModel alloc] init];
  tab.active = activeTabIdentifier.length > 0 &&
      [activeTabIdentifier isEqualToString:tabIdentifier];
  tab.audible = NO;
  tab.audioMuted = NO;
  tab.identifier = tabIdentifier;
  tab.name = name.length > 0 ? name : tabIdentifier;
  tab.tooltip = tab.name;
  tab.type = type.length > 0 ? type : @"role";
  tab.workspaceTemplate = workspaceTemplate;
  RionRuntimeTabItemView *item = _tabItems[index];
  [_tabItemsByIdentifier removeObjectForKey:provisionalIdentifier];
  [item configureWithTab:tab
                   image:[self imageForTab:tab]
      hideTabCloseButton:NO
              closeLabel:@"Stop and close tab"
       audioPlayingLabel:@"Playing audio"
          audioMutedLabel:@"Tab muted"
            windowActive:_window.isKeyWindow];
  [_tabIconCache removeObjectForKey:provisionalIdentifier];
  [_tabIconCacheKeys removeObjectForKey:provisionalIdentifier];
  _tabItemsByIdentifier[tabIdentifier] = item;
  [self setActiveTabIdentifier:activeTabIdentifier];
  [self layoutTitlebarContent];
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
  [self layoutTitlebarContent];
  [self updateDragPlaceholderAppearance];
  if (NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return;
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
  if (!hasMovement) return;
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
    context.duration = 0.12;
    for (NSUInteger index = 0; index < self->_tabSurfaces.count; ++index) {
      self->_tabSurfaces[index].animator.frame = targetFrames[index].rectValue;
    }
  } completionHandler:nil];
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
    _actionHandler(@{ @"type" : @"stop", @"tabId" : tabIdentifier,
                      @"sourceWindowId" : _windowID });
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
  [self resetTabDragInsertionState];
  NSString *sessionID = NSUUID.UUID.UUIDString;
  item.dragSessionID = sessionID;
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
  draggingSession.animatesToStartingPositionsOnCancelOrFail = YES;
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
