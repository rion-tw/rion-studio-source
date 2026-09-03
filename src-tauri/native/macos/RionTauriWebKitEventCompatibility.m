#import "RionTauriWebKitEventCompatibility.h"

#import <objc/runtime.h>

static BOOL RionTauriIsMarkedWebKitMacroFallbackEvent(NSEvent *event) {
  return event && objc_getAssociatedObject(
      event, NSSelectorFromString(@"rionStudioMacroKeyEvent"));
}

// Tao implements TaoWindow's -sendEvent: in an extern "C" Rust callback. The
// stable v22 shell must contain Objective-C exceptions before they cross that
// callback, and it must consume WKWebView's marked synthetic macro fallback.
// This compatibility hook is intentionally not part of the shared v23 AppKit
// controller archive.
static void RionTauriSafeWebKitWindowSendEvent(id window, SEL selector,
                                                NSEvent *event) {
  @autoreleasepool {
    if (!window || !event) return;
    if (RionTauriIsMarkedWebKitMacroFallbackEvent(event)) return;

    @try {
      if (event.type == NSEventTypeLeftMouseDown &&
          [window isMovableByWindowBackground]) {
        [window performWindowDragWithEvent:event];
      }

      Class taoWindow = NSClassFromString(@"TaoWindow");
      Class superclass = taoWindow ? class_getSuperclass(taoWindow) : Nil;
      Method method = class_getInstanceMethod(superclass, selector);
      IMP implementation = method ? method_getImplementation(method) : NULL;
      if (!implementation) return;
      ((void (*)(id, SEL, NSEvent *))implementation)(window, selector, event);
    } @catch (NSException *exception) {
      NSLog(@"Rion Studio discarded an invalid v22 native window event: %@",
            exception.reason);
    }
  }
}

bool rion_tauri_install_safe_tao_webkit_event_dispatch(void) {
  @autoreleasepool {
    Class taoWindow = NSClassFromString(@"TaoWindow");
    if (!taoWindow) return false;
    SEL selector = @selector(sendEvent:);
    Method method = class_getInstanceMethod(taoWindow, selector);
    if (!method) return false;
    IMP safeImplementation = (IMP)RionTauriSafeWebKitWindowSendEvent;
    if (method_getImplementation(method) != safeImplementation) {
      method_setImplementation(method, safeImplementation);
    }
    return method_getImplementation(method) == safeImplementation;
  }
}
