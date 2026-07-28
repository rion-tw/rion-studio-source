#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum {
  RionWKHighRefreshRateApplied = 0,
  RionWKHighRefreshRateUnavailable = 1,
  RionWKHighRefreshRateFailed = 2,
};

static id RionWKFeatureWithKey(NSArray *features, NSString *expectedKey) {
  SEL keySelector = NSSelectorFromString(@"key");
  for (id feature in features) {
    if (![feature respondsToSelector:keySelector]) continue;
    id key = ((id (*)(id, SEL))objc_msgSend)(feature, keySelector);
    if ([key isKindOfClass:NSString.class] && [key isEqualToString:expectedKey]) {
      return feature;
    }
  }
  return nil;
}

int32_t rion_wk_enable_high_refresh_rate(void *rawWebView) {
  @autoreleasepool {
    if (!rawWebView) return RionWKHighRefreshRateFailed;
    @try {
      WKWebView *webView = (__bridge WKWebView *)rawWebView;
      WKPreferences *preferences = webView.configuration.preferences;
      Class preferencesClass = NSClassFromString(@"WKPreferences");
      SEL featuresSelector = NSSelectorFromString(@"_features");
      SEL setEnabledSelector =
          NSSelectorFromString(@"_setEnabled:forFeature:");
      if (!preferences || !preferencesClass ||
          ![(id)preferencesClass respondsToSelector:featuresSelector] ||
          ![preferences respondsToSelector:setEnabledSelector]) {
        return RionWKHighRefreshRateUnavailable;
      }
      id features = ((id (*)(id, SEL))objc_msgSend)(
          (id)preferencesClass, featuresSelector);
      if (![features isKindOfClass:NSArray.class]) {
        return RionWKHighRefreshRateUnavailable;
      }
      id feature = RionWKFeatureWithKey(
          (NSArray *)features,
          @"PreferPageRenderingUpdatesNear60FPSEnabled");
      if (!feature) return RionWKHighRefreshRateUnavailable;
      ((void (*)(id, SEL, BOOL, id))objc_msgSend)(
          preferences, setEnabledSelector, NO, feature);
      return RionWKHighRefreshRateApplied;
    } @catch (__unused NSException *exception) {
      return RionWKHighRefreshRateFailed;
    }
  }
}

@interface RionWKFeatureFixture : NSObject
@property(nonatomic, copy) NSString *key;
@end

@implementation RionWKFeatureFixture
@end

bool rion_wk_high_refresh_rate_self_test(void) {
  @autoreleasepool {
    RionWKFeatureFixture *other = [[RionWKFeatureFixture alloc] init];
    other.key = @"OtherFeature";
    RionWKFeatureFixture *target = [[RionWKFeatureFixture alloc] init];
    target.key = @"PreferPageRenderingUpdatesNear60FPSEnabled";
    NSArray *features = @[other, @42, target];
    return RionWKFeatureWithKey(
               features,
               @"PreferPageRenderingUpdatesNear60FPSEnabled") == target &&
        RionWKFeatureWithKey(features, @"MissingFeature") == nil;
  }
}

double rion_ns_window_display_refresh_rate(void *rawWindow) {
  @autoreleasepool {
    if (!rawWindow) return 0;
    @try {
      NSWindow *window = (__bridge NSWindow *)rawWindow;
      NSScreen *screen = window.screen;
      SEL selector = NSSelectorFromString(@"maximumFramesPerSecond");
      if (!screen || ![screen respondsToSelector:selector]) return 0;
      NSInteger framesPerSecond =
          ((NSInteger (*)(id, SEL))objc_msgSend)(screen, selector);
      return framesPerSecond > 1 ? (double)framesPerSecond : 0;
    } @catch (__unused NSException *exception) {
      return 0;
    }
  }
}

typedef void (*RionRoleZoomShortcutHandler)(void *context,
                                            const char *action);
typedef void (*RionRoleZoomShortcutDestructor)(void *context);

@interface RionRoleZoomShortcutBinding : NSObject
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) RionRoleZoomShortcutHandler handler;
@property(nonatomic, assign) RionRoleZoomShortcutDestructor destructor;
@end

@implementation RionRoleZoomShortcutBinding
- (void)dealloc {
  if (_context && _destructor) _destructor(_context);
}
@end

static char RionRoleZoomShortcutBindingKey;

static const char *RionRoleZoomActionForKeyCode(
    unsigned short keyCode, NSEventModifierFlags modifierFlags) {
  NSEventModifierFlags flags = modifierFlags &
      NSEventModifierFlagDeviceIndependentFlagsMask;
  if ((flags & NSEventModifierFlagCommand) == 0 ||
      (flags & (NSEventModifierFlagControl | NSEventModifierFlagOption |
                NSEventModifierFlagFunction)) != 0) {
    return NULL;
  }
  BOOL shift = (flags & NSEventModifierFlagShift) != 0;
  switch (keyCode) {
    case 29:  // Number-row 0.
    case 82:  // Keypad 0.
      return shift ? NULL : "reset";
    case 27:  // Number-row minus.
    case 78:  // Keypad minus.
      return shift ? NULL : "out";
    case 24:  // Number-row equals/plus; Shift is valid for the plus glyph.
      return "in";
    case 69:  // Keypad plus.
      return shift ? NULL : "in";
    default:
      return NULL;
  }
}

static RionRoleZoomShortcutBinding *
RionRoleZoomBindingForResponder(NSResponder *responder) {
  if (![responder isKindOfClass:NSView.class]) return nil;
  for (NSView *view = (NSView *)responder; view; view = view.superview) {
    RionRoleZoomShortcutBinding *binding =
        objc_getAssociatedObject(view, &RionRoleZoomShortcutBindingKey);
    if (binding) return binding;
  }
  return nil;
}

static void RionInstallRoleZoomShortcutMonitor(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                          handler:^NSEvent *(NSEvent *event) {
      RionRoleZoomShortcutBinding *binding =
          RionRoleZoomBindingForResponder(event.window.firstResponder);
      if (!binding || !binding.context || !binding.handler) return event;
      const char *action =
          RionRoleZoomActionForKeyCode(event.keyCode, event.modifierFlags);
      if (!action) return event;
      binding.handler(binding.context, action);
      return nil;
    }];
  });
}

bool rion_wk_install_role_zoom_shortcut(
    void *rawWebView, void *context, RionRoleZoomShortcutHandler handler,
    RionRoleZoomShortcutDestructor destructor) {
  @autoreleasepool {
    if (!rawWebView || !context || !handler || !destructor) return false;
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    RionRoleZoomShortcutBinding *binding =
        [[RionRoleZoomShortcutBinding alloc] init];
    binding.context = context;
    binding.handler = handler;
    binding.destructor = destructor;
    objc_setAssociatedObject(webView, &RionRoleZoomShortcutBindingKey, binding,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    RionInstallRoleZoomShortcutMonitor();
    return true;
  }
}

bool rion_wk_role_zoom_shortcut_self_test(void) {
  NSEventModifierFlags command = NSEventModifierFlagCommand;
  const char *reset = RionRoleZoomActionForKeyCode(29, command);
  const char *zoomIn = RionRoleZoomActionForKeyCode(
      24, command | NSEventModifierFlagShift);
  const char *keypadIn = RionRoleZoomActionForKeyCode(
      69, command | NSEventModifierFlagNumericPad);
  const char *zoomOut = RionRoleZoomActionForKeyCode(78, command);
  return reset && strcmp(reset, "reset") == 0 && zoomIn &&
      strcmp(zoomIn, "in") == 0 && keypadIn &&
      strcmp(keypadIn, "in") == 0 && zoomOut &&
      strcmp(zoomOut, "out") == 0 &&
      !RionRoleZoomActionForKeyCode(29, command | NSEventModifierFlagShift) &&
      !RionRoleZoomActionForKeyCode(69, command | NSEventModifierFlagShift) &&
      !RionRoleZoomActionForKeyCode(27, command | NSEventModifierFlagControl) &&
      !RionRoleZoomActionForKeyCode(24, NSEventModifierFlagControl);
}

bool rion_wk_window_content_layout_metrics(void *rawWindow, double *width,
                                           double *height,
                                           double *topInset) {
  @autoreleasepool {
    if (!rawWindow || !width || !height || !topInset) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    NSView *contentView = window.contentView;
    if (!contentView) return false;
    NSRect rect = [contentView convertRect:window.contentLayoutRect fromView:nil];
    NSRect bounds = contentView.bounds;
    if (!isfinite(NSWidth(rect)) || !isfinite(NSHeight(rect)) ||
        NSWidth(rect) <= 0 || NSHeight(rect) <= 0) {
      return false;
    }
    *width = NSWidth(rect);
    *height = NSHeight(rect);
    *topInset = contentView.isFlipped
        ? NSMinY(rect) - NSMinY(bounds)
        : NSMaxY(bounds) - NSMaxY(rect);
    if (!isfinite(*topInset) || *topInset < 0) return false;
    return true;
  }
}

static void RionJavaScriptAlert(id delegate, SEL selector, WKWebView *webView,
                                NSString *message, WKFrameInfo *frame,
                                void (^completionHandler)(void)) {
  (void)delegate;
  (void)selector;
  (void)webView;
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"JavaScript";
  alert.informativeText = message ?: @"";
  [alert addButtonWithTitle:@"OK"];
  [alert runModal];
  completionHandler();
}

static void RionJavaScriptConfirm(id delegate, SEL selector, WKWebView *webView,
                                  NSString *message, WKFrameInfo *frame,
                                  void (^completionHandler)(BOOL)) {
  (void)delegate;
  (void)selector;
  (void)webView;
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"JavaScript";
  alert.informativeText = message ?: @"";
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];
  completionHandler([alert runModal] == NSAlertFirstButtonReturn);
}

static void RionJavaScriptPrompt(id delegate, SEL selector, WKWebView *webView,
                                 NSString *prompt, NSString *defaultText,
                                 WKFrameInfo *frame,
                                 void (^completionHandler)(NSString *)) {
  (void)delegate;
  (void)selector;
  (void)webView;
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"JavaScript";
  alert.informativeText = prompt ?: @"";
  NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
  input.stringValue = defaultText ?: @"";
  alert.accessoryView = input;
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];
  completionHandler([alert runModal] == NSAlertFirstButtonReturn ? input.stringValue : nil);
}

static void RionDenyMediaCapture(id delegate, SEL selector, WKWebView *webView,
                                 WKSecurityOrigin *origin, WKFrameInfo *frame,
                                 WKMediaCaptureType captureType,
                                 void (^decisionHandler)(WKPermissionDecision)) {
  (void)delegate;
  (void)selector;
  (void)webView;
  (void)origin;
  (void)frame;
  (void)captureType;
  decisionHandler(WKPermissionDecisionDeny);
}

static BOOL RionInstallDelegateMethod(Class delegateClass, SEL selector, IMP implementation) {
  Method existing = class_getInstanceMethod(delegateClass, selector);
  const char *types = existing ? method_getTypeEncoding(existing) : NULL;
  if (!types) {
    struct objc_method_description description =
        protocol_getMethodDescription(@protocol(WKUIDelegate), selector, NO, YES);
    types = description.types;
  }
  if (!types) return NO;
  if (existing) {
    class_replaceMethod(delegateClass, selector, implementation, types);
    return YES;
  }
  return class_addMethod(delegateClass, selector, implementation, types);
}

static BOOL RionInstallSecurityPolicyOnDelegate(id<WKUIDelegate> delegate) {
  if (!delegate) return NO;
  Class delegateClass = object_getClass(delegate);
  if (!delegateClass) return NO;
  BOOL alert = RionInstallDelegateMethod(
      delegateClass,
      @selector(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
      (IMP)RionJavaScriptAlert);
  BOOL confirm = RionInstallDelegateMethod(
      delegateClass,
      @selector(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
      (IMP)RionJavaScriptConfirm);
  BOOL prompt = RionInstallDelegateMethod(
      delegateClass,
      @selector(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:),
      (IMP)RionJavaScriptPrompt);
  BOOL permission = RionInstallDelegateMethod(
      delegateClass,
      @selector(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:),
      (IMP)RionDenyMediaCapture);
  return alert && confirm && prompt && permission;
}

bool rion_wk_install_security_policy(void *rawWebView) {
  @autoreleasepool {
    if (!rawWebView) return false;
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    id<WKUIDelegate> delegate = webView.UIDelegate;
    return RionInstallSecurityPolicyOnDelegate(delegate);
  }
}

@interface RionWKPolicyFixtureDelegate : NSObject <WKUIDelegate>
@end

@implementation RionWKPolicyFixtureDelegate
- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:(void (^)(WKPermissionDecision decision))decisionHandler {
  (void)webView;
  (void)origin;
  (void)frame;
  (void)type;
  decisionHandler(WKPermissionDecisionGrant);
}
@end

bool rion_wk_security_policy_self_test(void) {
  @autoreleasepool {
    RionWKPolicyFixtureDelegate *delegate = [[RionWKPolicyFixtureDelegate alloc] init];
    if (!RionInstallSecurityPolicyOnDelegate(delegate)) return false;
    SEL permissionSelector =
        @selector(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:);
    IMP permissionImplementation =
        class_getMethodImplementation(object_getClass(delegate), permissionSelector);
    if (permissionImplementation != (IMP)RionDenyMediaCapture) return false;
    __block WKPermissionDecision decision = WKPermissionDecisionPrompt;
    ((void (*)(id, SEL, WKWebView *, WKSecurityOrigin *, WKFrameInfo *,
               WKMediaCaptureType, void (^)(WKPermissionDecision)))permissionImplementation)(
        delegate, permissionSelector, nil, nil, nil, WKMediaCaptureTypeCamera,
        ^(WKPermissionDecision value) { decision = value; });
    return decision == WKPermissionDecisionDeny &&
        [delegate respondsToSelector:
            @selector(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:)] &&
        [delegate respondsToSelector:
            @selector(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:)] &&
        [delegate respondsToSelector:
            @selector(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:)];
  }
}

static NSNumber *RionVirtualKeyCode(NSString *code) {
  static NSDictionary<NSString *, NSNumber *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = @{
      @"KeyA": @0, @"KeyS": @1, @"KeyD": @2, @"KeyF": @3,
      @"KeyH": @4, @"KeyG": @5, @"KeyZ": @6, @"KeyX": @7,
      @"KeyC": @8, @"KeyV": @9, @"KeyB": @11, @"KeyQ": @12,
      @"KeyW": @13, @"KeyE": @14, @"KeyR": @15, @"KeyY": @16,
      @"KeyT": @17, @"Digit1": @18, @"Digit2": @19, @"Digit3": @20,
      @"Digit4": @21, @"Digit6": @22, @"Digit5": @23, @"Equal": @24,
      @"Digit9": @25, @"Digit7": @26, @"Minus": @27, @"Digit8": @28,
      @"Digit0": @29, @"BracketRight": @30, @"KeyO": @31,
      @"KeyU": @32, @"BracketLeft": @33, @"KeyI": @34, @"KeyP": @35,
      @"Enter": @36, @"KeyL": @37, @"KeyJ": @38, @"Quote": @39,
      @"KeyK": @40, @"Semicolon": @41, @"Backslash": @42,
      @"Comma": @43, @"Slash": @44, @"KeyN": @45, @"KeyM": @46,
      @"Period": @47, @"Tab": @48, @"Space": @49, @"Backquote": @50,
      @"Backspace": @51, @"Escape": @53, @"MetaLeft": @55,
      @"ShiftLeft": @56, @"AltLeft": @58, @"ControlLeft": @59,
      @"ShiftRight": @60, @"AltRight": @61, @"ControlRight": @62,
      @"F17": @64, @"F18": @79, @"F19": @80, @"F20": @90,
      @"F5": @96, @"F6": @97, @"F7": @98, @"F3": @99,
      @"F8": @100, @"F9": @101, @"F11": @103, @"F13": @105,
      @"F16": @106, @"F14": @107, @"F10": @109, @"F12": @111,
      @"F15": @113, @"Insert": @114, @"Home": @115, @"PageUp": @116,
      @"Delete": @117, @"F4": @118, @"End": @119, @"F2": @120,
      @"PageDown": @121, @"F1": @122, @"ArrowLeft": @123,
      @"ArrowRight": @124, @"ArrowDown": @125, @"ArrowUp": @126
    };
  });
  return codes[code];
}

static BOOL RionIsModifier(NSString *code) {
  return [code hasPrefix:@"Shift"] || [code hasPrefix:@"Control"] ||
         [code hasPrefix:@"Alt"] || [code hasPrefix:@"Meta"];
}

static NSString *RionFunctionCharacter(unichar value) {
  return [NSString stringWithCharacters:&value length:1];
}

static NSString *RionBaseCharacter(NSString *code) {
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
      return RionFunctionCharacter((unichar)(NSF1FunctionKey + number - 1));
    }
  }
  NSDictionary<NSString *, NSNumber *> *functions = @{
    @"ArrowUp": @(NSUpArrowFunctionKey), @"ArrowDown": @(NSDownArrowFunctionKey),
    @"ArrowLeft": @(NSLeftArrowFunctionKey), @"ArrowRight": @(NSRightArrowFunctionKey),
    @"Insert": @(NSInsertFunctionKey), @"Delete": @(NSDeleteFunctionKey),
    @"Home": @(NSHomeFunctionKey), @"End": @(NSEndFunctionKey),
    @"PageUp": @(NSPageUpFunctionKey), @"PageDown": @(NSPageDownFunctionKey)
  };
  NSNumber *function = functions[code];
  return function ? RionFunctionCharacter(function.unsignedShortValue) : nil;
}

static NSString *RionShiftedCharacter(NSString *code, NSString *base) {
  if ([code hasPrefix:@"Key"]) return base.uppercaseString;
  NSDictionary<NSString *, NSString *> *shifted = @{
    @"Digit1": @"!", @"Digit2": @"@", @"Digit3": @"#", @"Digit4": @"$",
    @"Digit5": @"%", @"Digit6": @"^", @"Digit7": @"&", @"Digit8": @"*",
    @"Digit9": @"(", @"Digit0": @")", @"Backquote": @"~", @"Equal": @"+",
    @"Minus": @"_", @"BracketRight": @"}", @"BracketLeft": @"{",
    @"Quote": @"\"", @"Semicolon": @":", @"Backslash": @"|",
    @"Comma": @"<", @"Slash": @"?", @"Period": @">"
  };
  return shifted[code] ?: base;
}

static NSView *RionWKContentView(NSView *root) {
  for (NSView *subview in root.subviews) {
    if ([NSStringFromClass(subview.class) containsString:@"WKContentView"]) {
      return subview;
    }
    NSView *nested = RionWKContentView(subview);
    if (nested) return nested;
  }
  return nil;
}

@protocol RionFirstResponderHost <NSObject>
- (nullable NSResponder *)firstResponder;
- (BOOL)makeFirstResponder:(nullable NSResponder *)responder;
@end

static BOOL RionResponderBelongsToView(NSResponder *responder, NSView *root) {
  if (![responder isKindOfClass:NSView.class]) return false;
  NSView *view = (NSView *)responder;
  return view == root || [view isDescendantOf:root];
}

static NSResponder *RionKeyResponder(WKWebView *webView) {
  NSWindow *window = webView.window;
  if (!window) return nil;
  NSResponder *candidate = window.firstResponder;
  if (RionResponderBelongsToView(candidate, webView)) return candidate;
  NSView *content = RionWKContentView(webView);
  if (content) return content;
  return webView;
}

static BOOL RionRestoreFirstResponder(
    id<RionFirstResponderHost> host, NSResponder *preservedResponder,
    NSView *dispatchTarget) {
  NSResponder *current = host.firstResponder;
  if (current == preservedResponder) return true;
  // A foreground action inside the same role may intentionally move focus from
  // the WKWebView to one of its internal content responders. Preserve that
  // role-local transition, but undo any background dispatch that crossed roles.
  if (preservedResponder && current &&
      RionResponderBelongsToView(preservedResponder, dispatchTarget) &&
      RionResponderBelongsToView(current, dispatchTarget)) {
    return true;
  }
  return [host makeFirstResponder:preservedResponder];
}

static void RionDispatchKeyEvent(NSResponder *responder, NSEvent *event,
                                 NSEventType type, bool keyDown) {
  if (type == NSEventTypeFlagsChanged) {
    [responder flagsChanged:event];
  } else if (keyDown) {
    [responder keyDown:event];
  } else {
    [responder keyUp:event];
  }
}

bool rion_wk_dispatch_key(void *rawWebView, const char *rawCode,
                          bool keyDown, uint64_t rawFlags, bool repeat) {
  @autoreleasepool {
    if (!rawWebView || !rawCode) return false;
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    NSWindow *window = webView.window;
    if (!window) return false;
    NSResponder *preservedResponder = window.firstResponder;
    NSString *code = [NSString stringWithUTF8String:rawCode];
    NSNumber *virtualCode = RionVirtualKeyCode(code);
    NSString *base = RionBaseCharacter(code);
    if (!virtualCode && !base) return false;
    NSEventModifierFlags flags = (NSEventModifierFlags)rawFlags;
    if ([code hasPrefix:@"F"] || [code hasPrefix:@"Arrow"] ||
        [@[@"Insert", @"Delete", @"Home", @"End", @"PageUp", @"PageDown"]
            containsObject:code]) {
      flags |= NSEventModifierFlagFunction;
    }
    NSString *characters = base ?: @"";
    if ((flags & NSEventModifierFlagShift) != 0) {
      characters = RionShiftedCharacter(code, characters);
    }
    NSEventType type = RionIsModifier(code)
        ? NSEventTypeFlagsChanged
        : (keyDown ? NSEventTypeKeyDown : NSEventTypeKeyUp);
    NSEvent *event = [NSEvent keyEventWithType:type
                                      location:NSZeroPoint
                                 modifierFlags:flags
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:window.windowNumber
                                       context:nil
                                    characters:characters
                   charactersIgnoringModifiers:base ?: @""
                                     isARepeat:repeat
                                       keyCode:virtualCode.unsignedShortValue];
    if (!event) return false;
    // Send directly to this role's own WebKit responder. Background automation
    // must not become the window first responder or steal subsequent shortcuts
    // from the role the user selected.
    NSResponder *responder = RionKeyResponder(webView);
    if (!responder) return false;
    RionDispatchKeyEvent(responder, event, type, keyDown);
    return RionRestoreFirstResponder(
        (id<RionFirstResponderHost>)window, preservedResponder, webView);
  }
}

bool rion_wk_dispatch_mouse(void *rawWebView, double x, double y,
                            int button, bool mouseDown) {
  @autoreleasepool {
    if (!rawWebView || !isfinite(x) || !isfinite(y) || button < 0 || button > 2) {
      return false;
    }
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    NSWindow *window = webView.window;
    if (!window) return false;
    // Role WKWebViews are child views already positioned below the AppKit tab
    // strip. BrowserAction points are DOM viewport coordinates, so applying
    // the parent window's contentLayoutRect here would add the titlebar inset a
    // second time (and can yield a negative clientY while the host is hidden).
    NSRect viewportBounds = webView.bounds;
    NSPoint viewPoint = NSMakePoint(NSMinX(viewportBounds) + x, y);
    // BrowserAction coordinates use the DOM convention (origin at top-left).
    // AppKit views normally use a bottom-left origin, while a subclass may opt
    // into flipped coordinates. Normalize only when the concrete WKWebView is
    // not already flipped so the same semantic point reaches both variants.
    if (!webView.isFlipped) {
      viewPoint.y = NSMaxY(viewportBounds) - y;
    } else {
      viewPoint.y = NSMinY(viewportBounds) + y;
    }
    NSPoint windowPoint = [webView convertPoint:viewPoint toView:nil];
    NSEventType type;
    if (button == 0) type = mouseDown ? NSEventTypeLeftMouseDown : NSEventTypeLeftMouseUp;
    else if (button == 1) type = mouseDown ? NSEventTypeOtherMouseDown : NSEventTypeOtherMouseUp;
    else type = mouseDown ? NSEventTypeRightMouseDown : NSEventTypeRightMouseUp;
    NSEvent *event = [NSEvent mouseEventWithType:type
                                       location:windowPoint
                                  modifierFlags:0
                                      timestamp:NSProcessInfo.processInfo.systemUptime
                                   windowNumber:window.windowNumber
                                        context:nil
                                    eventNumber:0
                                     clickCount:1
                                       pressure:mouseDown ? 1.0 : 0.0];
    if (!event) return false;
    NSResponder *preservedResponder = window.firstResponder;
    NSView *target = [webView hitTest:viewPoint] ?: webView;
    if (button == 0) {
      if (mouseDown) [target mouseDown:event]; else [target mouseUp:event];
    } else if (button == 1) {
      if (mouseDown) [target otherMouseDown:event]; else [target otherMouseUp:event];
    } else {
      if (mouseDown) [target rightMouseDown:event]; else [target rightMouseUp:event];
    }
    return RionRestoreFirstResponder(
        (id<RionFirstResponderHost>)window, preservedResponder, webView);
  }
}

@interface RionInputResponderFixture : NSView
@property(nonatomic, assign) NSUInteger keyDownCount;
@end

@implementation RionInputResponderFixture
- (void)keyDown:(NSEvent *)event {
  (void)event;
  self.keyDownCount += 1;
}
@end

@interface RionFirstResponderHostFixture : NSObject <RionFirstResponderHost>
@property(nonatomic, strong, nullable) NSResponder *responder;
@property(nonatomic, assign) NSUInteger focusChangeCount;
@end

@implementation RionFirstResponderHostFixture
- (NSResponder *)firstResponder {
  return self.responder;
}
- (BOOL)makeFirstResponder:(NSResponder *)responder {
  self.responder = responder;
  self.focusChangeCount += 1;
  return true;
}
@end

bool rion_wk_background_input_focus_self_test(void) {
  @autoreleasepool {
    NSView *targetRoot = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
    RionInputResponderFixture *target =
        [[RionInputResponderFixture alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
    NSView *targetNext = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
    NSView *foreground = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
    [targetRoot addSubview:target];
    [targetRoot addSubview:targetNext];

    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                      location:NSZeroPoint
                                 modifierFlags:0
                                     timestamp:0
                                  windowNumber:0
                                       context:nil
                                    characters:@"a"
                   charactersIgnoringModifiers:@"a"
                                     isARepeat:false
                                       keyCode:0];
    if (!event) return false;
    RionDispatchKeyEvent(target, event, NSEventTypeKeyDown, true);

    RionFirstResponderHostFixture *host =
        [[RionFirstResponderHostFixture alloc] init];
    host.responder = target;
    BOOL restored = RionRestoreFirstResponder(
        host, foreground, targetRoot);
    host.responder = targetNext;
    BOOL preservedRoleLocalFocus = RionRestoreFirstResponder(
        host, target, targetRoot);
    return target.keyDownCount == 1 &&
        RionResponderBelongsToView(target, targetRoot) &&
        !RionResponderBelongsToView(foreground, targetRoot) && restored &&
        preservedRoleLocalFocus && host.firstResponder == targetNext &&
        host.focusChangeCount == 1;
  }
}
