#import "../RionRuntimeTabsController.h"
#import <objc/message.h>
#import <objc/runtime.h>
#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// Unified compact is AppKit's 40pt titlebar host on macOS 12 and newer. Keep
// the accessory at the exact host height so the blur covers the whole row and
// never leaves a separator-colored strip above the game content.
static const CGFloat kRionTitlebarHeight = 40.0;
static const CGFloat kRionTabHeight = 28.0;
static const CGFloat kRionTabCompactMinimumWidth = 112.0;
static const CGFloat kRionTabMinimumWidth = 144.0;
static const CGFloat kRionTabMaximumWidth = 320.0;
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
static const CGFloat kRionTabScrollFusionInset =
    kRionTabScrollButtonWidth + kRionTabScrollButtonSpacing;
static const CGFloat kRionAddButtonSpacing = 8.0;
static const CGFloat kRionRootLeadingInset = 4.0;
static const CGFloat kRionWindowNameMinimumWidth = 150.0;
static const CGFloat kRionWindowNameMaximumWidth = 240.0;
static const CGFloat kRionWindowNameTrailingSpacing = 10.0;
static const CGFloat kRionRootTrailingDraggableWidth = 12.0;
static const CGFloat kRionTrafficLightFallbackWidth = 76.0;
static const NSInteger kRionAddButtonTag = 41001;
static NSToolbarItemIdentifier const RionRuntimeToolbarSpacerIdentifier =
    @"com.rionstudio.runtime-tabs.layout-spacer";
static NSPasteboardType const RionRuntimeTabPasteboardType =
    @"com.rionstudio.runtime-tab";

static CGFloat RionRuntimeWindowNameWidth(CGFloat intrinsicWidth) {
  return MIN(kRionWindowNameMaximumWidth,
             MAX(kRionWindowNameMinimumWidth, ceil(intrinsicWidth)));
}

static CGFloat RionRuntimeInsetRevealScrollOrigin(
    CGFloat itemMinimumX, CGFloat itemMaximumX, CGFloat currentOriginX,
    CGFloat viewportWidth, CGFloat contentWidth, CGFloat edgeInset) {
  CGFloat maximumOrigin = MAX(0, contentWidth - viewportWidth);
  CGFloat boundedInset = MIN(MAX(0, edgeInset), viewportWidth / 2.0);
  CGFloat originX = currentOriginX;
  CGFloat safeMinimumX = currentOriginX + boundedInset;
  CGFloat safeMaximumX = currentOriginX + viewportWidth - boundedInset;
  if (itemMinimumX < safeMinimumX) {
    originX = itemMinimumX - boundedInset;
  } else if (itemMaximumX > safeMaximumX) {
    originX = itemMaximumX - viewportWidth + boundedInset;
  }
  return MIN(maximumOrigin, MAX(0, originX));
}

static CGFloat RionRuntimeTabEdgeFadeAlpha(CGFloat viewportX,
                                           CGFloat viewportWidth,
                                           CGFloat edgeInset) {
  if (viewportWidth <= 0 || viewportX <= 0 || viewportX >= viewportWidth) {
    return 0;
  }
  CGFloat boundedInset = MIN(MAX(0, edgeInset), viewportWidth / 2.0);
  if (boundedInset <= 0) return 1;
  CGFloat normalizedAlpha = 1;
  if (viewportX < boundedInset) {
    normalizedAlpha = viewportX / boundedInset;
  }
  if (viewportX > viewportWidth - boundedInset) {
    normalizedAlpha = (viewportWidth - viewportX) / boundedInset;
  }
  // Smoothstep avoids a visible change in slope where a tab enters or leaves
  // an arrow's fusion zone.
  return normalizedAlpha * normalizedAlpha * (3.0 - 2.0 * normalizedAlpha);
}

static NSRect RionRuntimeTabEdgeEffectVisibleRect(
    CGFloat surfaceWidth, CGFloat surfaceHeight, CGFloat viewportMinimumX,
    CGFloat viewportWidth, CGFloat arrowCenterInset) {
  CGFloat localMinimumX = MIN(
      surfaceWidth, MAX(0, arrowCenterInset - viewportMinimumX));
  CGFloat localMaximumX = MIN(
      surfaceWidth,
      MAX(0, viewportWidth - arrowCenterInset - viewportMinimumX));
  return NSMakeRect(localMinimumX, 0,
                    MAX(0, localMaximumX - localMinimumX), surfaceHeight);
}

static CGFloat RionRuntimeTrailingControlOriginX(
    CGFloat targetOriginX, NSRect visibleTabTailFrame,
    BOOL followsVisibleTabTail) {
  return followsVisibleTabTail
      ? NSMaxX(visibleTabTailFrame) + kRionAddButtonSpacing
      : targetOriginX;
}

static void RionRuntimeLayoutTabClusterViews(
    NSView *viewport, NSView *effectContainer, NSView *content,
    NSRect viewportFrame) {
  if (!viewport || !effectContainer || !content) return;
  // NSGlassEffectContainerView elevates its descendants into a private
  // presentation hierarchy. Keep that AppKit-owned effect host at local zero
  // and let an ordinary clipping viewport own the titlebar-relative origin.
  // This also keeps the non-glass fallback from resetting its own origin by
  // assigning its bounds back to its frame.
  viewport.frame = viewportFrame;
  effectContainer.frame = viewport.bounds;
  if (content != effectContainer) content.frame = effectContainer.bounds;
}

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
    // WebKit re-sends page-unhandled keyDown events through NSApp. Synthetic
    // macro keys already reached their explicit WKWebView target, so consuming
    // the marked fallback here prevents it from leaking to the active role.
    if (objc_getAssociatedObject(
            event, NSSelectorFromString(@"rionStudioMacroKeyEvent"))) {
      return;
    }
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

struct RionRuntimeTabWidthLayout {
  std::vector<CGFloat> widths;
  CGFloat contentWidth = 0;
  BOOL overflowing = NO;
};

static CGFloat RionRuntimeTabWidthsContentWidth(
    const std::vector<CGFloat> &widths) {
  CGFloat contentWidth = 0;
  for (CGFloat width : widths) contentWidth += width;
  if (widths.size() > 1) {
    contentWidth += kRionTabSpacing * (widths.size() - 1);
  }
  return contentWidth;
}

static RionRuntimeTabWidthLayout RionRuntimeResolveTabWidths(
    const std::vector<CGFloat> &preferredWidths, CGFloat availableWidth,
    CGFloat backingScaleFactor) {
  RionRuntimeTabWidthLayout layout;
  if (preferredWidths.empty()) return layout;

  layout.widths.reserve(preferredWidths.size());
  for (CGFloat preferredWidth : preferredWidths) {
    layout.widths.push_back(MIN(
        kRionTabMaximumWidth,
        MAX(kRionTabCompactMinimumWidth, preferredWidth)));
  }
  CGFloat preferredContentWidth =
      RionRuntimeTabWidthsContentWidth(layout.widths);
  if (preferredContentWidth <= availableWidth + 0.0001) {
    layout.contentWidth = preferredContentWidth;
    return layout;
  }

  CGFloat gapWidth = kRionTabSpacing * (layout.widths.size() - 1);
  CGFloat minimumContentWidth =
      kRionTabCompactMinimumWidth * layout.widths.size() + gapWidth;
  if (minimumContentWidth > availableWidth + 0.0001) {
    std::fill(layout.widths.begin(), layout.widths.end(),
              kRionTabCompactMinimumWidth);
    layout.contentWidth = minimumContentWidth;
    layout.overflowing = YES;
    return layout;
  }

  std::vector<CGFloat> sortedWidths = layout.widths;
  std::sort(sortedWidths.begin(), sortedWidths.end());
  CGFloat remainingWidth = MAX(0, availableWidth - gapWidth);
  size_t remainingCount = sortedWidths.size();
  CGFloat sharedCap = kRionTabCompactMinimumWidth;
  for (CGFloat preferredWidth : sortedWidths) {
    CGFloat equalShare =
        remainingWidth / std::max<size_t>(1, remainingCount);
    if (preferredWidth <= equalShare + 0.0001) {
      remainingWidth -= preferredWidth;
      --remainingCount;
      continue;
    }
    sharedCap = MAX(kRionTabCompactMinimumWidth, equalShare);
    break;
  }

  CGFloat scale = std::isfinite(backingScaleFactor)
      ? MAX(1.0, backingScaleFactor)
      : 1.0;
  CGFloat quantum = 1.0 / scale;
  CGFloat roundedWidth = 0;
  for (size_t index = 0; index < layout.widths.size(); ++index) {
    CGFloat rawWidth = MAX(kRionTabCompactMinimumWidth,
                           MIN(layout.widths[index], sharedCap));
    layout.widths[index] =
        floor(rawWidth / quantum + 0.0001) * quantum;
    roundedWidth += layout.widths[index];
  }
  CGFloat targetWidth = MAX(0, availableWidth - gapWidth);
  NSInteger remainingQuanta = (NSInteger)floor(
      MAX(0, targetWidth - roundedWidth) / quantum + 0.0001);
  for (size_t index = 0;
       index < layout.widths.size() && remainingQuanta > 0; ++index) {
    CGFloat expandedWidth = layout.widths[index] + quantum;
    if (expandedWidth > preferredWidths[index] + 0.0001) continue;
    layout.widths[index] = expandedWidth;
    --remainingQuanta;
  }
  layout.contentWidth = RionRuntimeTabWidthsContentWidth(layout.widths);
  return layout;
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

static NSMapTable<NSValue *, NSWindow *> *
RionFullscreenToolbarPresentationWindows(void) {
  static NSMapTable<NSValue *, NSWindow *> *windows;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    windows = [NSMapTable strongToWeakObjectsMapTable];
  });
  return windows;
}

static BOOL RionFullscreenToolbarPresentationBaselineCaptured = NO;
static BOOL RionFullscreenToolbarPresentationBaselineAutoHide = NO;

static BOOL RionResolveFullscreenToolbarAutoHide(
    BOOL baselineAutoHide, NSArray<NSNumber *> *requests) {
  if (requests.count == 0) return baselineAutoHide;
  for (NSNumber *request in requests) {
    // A false request represents always-show or reveal-lock. It has priority
    // over every auto-hide fullscreen runtime window in this process.
    if (!request.boolValue) return NO;
  }
  return YES;
}

static NSApplicationPresentationOptions
RionResolveFullscreenToolbarPresentationOptions(
    NSApplicationPresentationOptions options, NSNumber *autoHide);
static void RionSetFullscreenPresentationPolicyMarker(NSWindow *window,
                                                      BOOL active,
                                                      BOOL autoHide);

static BOOL RionUpdateWindowFullscreenToolbarPresentationOptions(
    NSWindow *window, BOOL autoHide) {
  if (!window) return NO;
  SEL getSelector = NSSelectorFromString(@"_fullScreenPresentationOptions");
  SEL setSelector = NSSelectorFromString(@"_setFullScreenPresentationOptions:");
  if (![window respondsToSelector:getSelector] ||
      ![window respondsToSelector:setSelector]) {
    return NO;
  }
  NSMethodSignature *getSignature =
      [window methodSignatureForSelector:getSelector];
  NSMethodSignature *setSignature =
      [window methodSignatureForSelector:setSelector];
  if (!getSignature || getSignature.numberOfArguments != 2 ||
      getSignature.methodReturnLength !=
          sizeof(NSApplicationPresentationOptions) ||
      !setSignature || setSignature.numberOfArguments != 3 ||
      setSignature.methodReturnLength != 0) {
    return NO;
  }

  @try {
    using GetPresentationOptionsFunction =
        NSApplicationPresentationOptions (*)(id, SEL);
    using SetPresentationOptionsFunction =
        void (*)(id, SEL, NSApplicationPresentationOptions);
    NSApplicationPresentationOptions current =
        reinterpret_cast<GetPresentationOptionsFunction>(objc_msgSend)(
            window, getSelector);
    NSApplicationPresentationOptions desired =
        RionResolveFullscreenToolbarPresentationOptions(current, @(autoHide));
    if (desired == current) return NO;
    reinterpret_cast<SetPresentationOptionsFunction>(objc_msgSend)(
        window, setSelector, desired);
    return YES;
  } @catch (__unused NSException *exception) {
    return NO;
  }
}

static void RionApplyWindowFullscreenToolbarHostPolicy(
    NSWindow *window, BOOL autoHide) {
  if (!window || !window.toolbar) return;
  SEL controllerSelector =
      NSSelectorFromString(@"_fullScreenContentController");
  if (![window respondsToSelector:controllerSelector]) return;
  NSMethodSignature *controllerSignature =
      [window methodSignatureForSelector:controllerSelector];
  if (!controllerSignature || controllerSignature.numberOfArguments != 2 ||
      controllerSignature.methodReturnLength != sizeof(id)) {
    return;
  }

  @try {
    using ObjectGetterFunction = id (*)(id, SEL);
    id controller =
        reinterpret_cast<ObjectGetterFunction>(objc_msgSend)(
            window, controllerSelector);
    SEL companionSelector =
        NSSelectorFromString(@"menuBarCompanionController");
    if (!controller ||
        ![controller respondsToSelector:companionSelector]) {
      return;
    }
    id companion =
        reinterpret_cast<ObjectGetterFunction>(objc_msgSend)(
            controller, companionSelector);
    if (!companion) return;

    NSArray<NSString *> *selectorNames = autoHide
        ? @[ @"_enableFullScreenAutohidingForToolbar:",
             @"_disableFullScreenForceVisibleForToolbar:" ]
        : @[ @"_disableFullScreenAutohidingForToolbar:",
             @"_enableFullScreenForceVisibleForToolbar:" ];
    for (NSString *selectorName in selectorNames) {
      SEL selector = NSSelectorFromString(selectorName);
      NSMethodSignature *signature =
          [companion methodSignatureForSelector:selector];
      if (![companion respondsToSelector:selector] || !signature ||
          signature.numberOfArguments != 3 ||
          signature.methodReturnLength != 0) {
        continue;
      }
      using ToolbarPolicyFunction = void (*)(id, SEL, NSToolbar *);
      reinterpret_cast<ToolbarPolicyFunction>(objc_msgSend)(
          companion, selector, window.toolbar);
    }
  } @catch (__unused NSException *exception) {
  }
}

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

  BOOL shouldAutoHide = RionResolveFullscreenToolbarAutoHide(
      RionFullscreenToolbarPresentationBaselineAutoHide,
      requests.allValues);

  NSMapTable<NSValue *, NSWindow *> *windows =
      RionFullscreenToolbarPresentationWindows();
  for (NSValue *key in requests) {
    NSWindow *window = [windows objectForKey:key];
    if (!window) continue;
    RionSetFullscreenPresentationPolicyMarker(window, YES, shouldAutoHide);
    RionUpdateWindowFullscreenToolbarPresentationOptions(window,
                                                         shouldAutoHide);
    RionApplyWindowFullscreenToolbarHostPolicy(window, shouldAutoHide);
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
    const void *controller, NSWindow *window, BOOL active, BOOL autoHide) {
  if (!controller) return;
  NSMutableDictionary<NSValue *, NSNumber *> *requests =
      RionFullscreenToolbarPresentationRequests();
  NSMapTable<NSValue *, NSWindow *> *windows =
      RionFullscreenToolbarPresentationWindows();
  NSValue *key = [NSValue valueWithPointer:controller];
  if (active) {
    requests[key] = @(autoHide);
    if (window) [windows setObject:window forKey:key];
  } else {
    [requests removeObjectForKey:key];
    [windows removeObjectForKey:key];
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
RionResolveFullscreenToolbarPresentationOptions(
    NSApplicationPresentationOptions options, NSNumber *autoHide) {
  if (!autoHide) return options;
  if (autoHide.boolValue) {
    return options | NSApplicationPresentationAutoHideToolbar;
  }
  return options & ~NSApplicationPresentationAutoHideToolbar;
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
  NSNumber *autoHide = objc_getAssociatedObject(
      window, &RionRuntimeFullscreenPresentationPolicyAssociationKey);
  return RionResolveFullscreenToolbarPresentationOptions(options, autoHide);
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
                                                      BOOL autoHide) {
  if (!window) return;
  objc_setAssociatedObject(
      window, &RionRuntimeFullscreenPresentationPolicyAssociationKey,
      active ? @(autoHide) : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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
