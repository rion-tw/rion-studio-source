#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <uuid/uuid.h>

enum {
  RionWKHighRefreshRateApplied = 0,
  RionWKHighRefreshRateUnavailable = 1,
  RionWKHighRefreshRateFailed = 2,
};

typedef void (*RionWKSurfaceReleasedCallback)(void *context);
typedef void (*RionWKSurfaceIsolatedCallback)(void *context);
typedef void (*RionWKSurfaceContextDestructor)(void *context);

static char RionWKSurfaceURLObservationContext;
static char RionWKSurfaceLoadingObservationContext;

@interface RionWKSurfaceLease : NSObject
@property(nonatomic, weak) WKWebView *webView;
@property(nonatomic, assign) uintptr_t dataStoreIdentity;
@property(nonatomic, assign) uint64_t token;
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) RionWKSurfaceReleasedCallback releasedCallback;
@property(nonatomic, assign) RionWKSurfaceIsolatedCallback isolatedCallback;
@property(nonatomic, assign) RionWKSurfaceContextDestructor contextDestructor;
@property(nonatomic, assign) BOOL quiesceRequested;
@property(nonatomic, assign) BOOL blankNavigationRequested;
@property(nonatomic, assign) BOOL isolationConfirmed;
@property(nonatomic, assign) BOOL observingIsolation;
- (void)beginIsolationObservation;
- (void)confirmIsolationIfReady;
- (void)finishRelease;
@end

@implementation RionWKSurfaceLease
- (void)beginIsolationObservation {
  WKWebView *webView = _webView;
  if (!webView || _observingIsolation) return;
  @try {
    [webView addObserver:self forKeyPath:@"URL" options:0
                 context:&RionWKSurfaceURLObservationContext];
    [webView addObserver:self forKeyPath:@"loading" options:0
                 context:&RionWKSurfaceLoadingObservationContext];
    _observingIsolation = YES;
  } @catch (__unused NSException *exception) {
    _observingIsolation = NO;
  }
}

- (void)confirmIsolationIfReady {
  if (_isolationConfirmed || !_quiesceRequested ||
      !_blankNavigationRequested) return;
  WKWebView *webView = _webView;
  if (!webView) return;
  uintptr_t currentDataStore = (uintptr_t)(__bridge void *)
      webView.configuration.websiteDataStore;
  if (currentDataStore == 0 || currentDataStore != _dataStoreIdentity) return;
  @try {
    NSURL *url = webView.URL;
    if (!url || ![url.absoluteString isEqualToString:@"about:blank"] ||
        webView.loading) return;
    [webView stopLoading];
    _isolationConfirmed = YES;
    if (_context && _isolatedCallback) _isolatedCallback(_context);
  } @catch (__unused NSException *exception) {
  }
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  (void)keyPath;
  (void)object;
  (void)change;
  if (context == &RionWKSurfaceURLObservationContext ||
      context == &RionWKSurfaceLoadingObservationContext) {
    [self confirmIsolationIfReady];
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change
                        context:context];
}

- (void)finishRelease {
  if (!_context) return;
  WKWebView *webView = _webView;
  if (_observingIsolation && webView) {
    @try {
      [webView removeObserver:self forKeyPath:@"URL"
                      context:&RionWKSurfaceURLObservationContext];
      [webView removeObserver:self forKeyPath:@"loading"
                      context:&RionWKSurfaceLoadingObservationContext];
    } @catch (__unused NSException *exception) {
    }
  }
  _observingIsolation = NO;
  void *context = _context;
  RionWKSurfaceReleasedCallback releasedCallback = _releasedCallback;
  RionWKSurfaceContextDestructor contextDestructor = _contextDestructor;
  _context = NULL;
  _releasedCallback = NULL;
  _isolatedCallback = NULL;
  _contextDestructor = NULL;
  if (releasedCallback) releasedCallback(context);
  if (contextDestructor) contextDestructor(context);
}

- (void)dealloc {
  [self finishRelease];
}
@end

static char RionWKSurfaceLeaseKey;

static NSMapTable<NSNumber *, RionWKSurfaceLease *> *RionWKSurfaceLeases(void) {
  static NSMapTable<NSNumber *, RionWKSurfaceLease *> *leases;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    leases = [NSMapTable strongToWeakObjectsMapTable];
  });
  return leases;
}

static uint64_t RionWKNextSurfaceToken(void) {
  static uint64_t nextToken = 1;
  @synchronized(RionWKSurfaceLeases()) {
    return nextToken++;
  }
}

static uint64_t RionWKAttachSurfaceLease(
    WKWebView *webView, uintptr_t dataStoreIdentity, void *context,
    RionWKSurfaceIsolatedCallback isolatedCallback,
    RionWKSurfaceReleasedCallback releasedCallback,
    RionWKSurfaceContextDestructor contextDestructor) {
  if (!webView || dataStoreIdentity == 0 || !context || !releasedCallback ||
      !isolatedCallback || !contextDestructor) return 0;
  RionWKSurfaceLease *lease = [[RionWKSurfaceLease alloc] init];
  lease.webView = webView;
  lease.dataStoreIdentity = dataStoreIdentity;
  lease.token = RionWKNextSurfaceToken();
  lease.context = context;
  lease.releasedCallback = releasedCallback;
  lease.isolatedCallback = isolatedCallback;
  lease.contextDestructor = contextDestructor;
  objc_setAssociatedObject(webView, &RionWKSurfaceLeaseKey, lease,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [RionWKSurfaceLeases() setObject:lease forKey:@(lease.token)];
  return lease.token;
}

static void RionWKFinishSurfaceLease(RionWKSurfaceLease *lease) {
  if (!lease) return;
  WKWebView *webView = lease.webView;
  uint64_t token = lease.token;
  if (webView) {
    objc_setAssociatedObject(webView, &RionWKSurfaceLeaseKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  [RionWKSurfaceLeases() removeObjectForKey:@(token)];
  [lease finishRelease];
}

uint64_t rion_wk_track_surface(
    void *rawWebView, void *context,
    RionWKSurfaceIsolatedCallback isolatedCallback,
    RionWKSurfaceReleasedCallback releasedCallback,
    RionWKSurfaceContextDestructor contextDestructor) {
  @autoreleasepool {
    if (!rawWebView) return 0;
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    uintptr_t dataStoreIdentity = (uintptr_t)(__bridge void *)
        webView.configuration.websiteDataStore;
    uint64_t token = RionWKAttachSurfaceLease(
        webView, dataStoreIdentity, context, isolatedCallback, releasedCallback,
        contextDestructor);
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    [lease beginIsolationObservation];
    return token;
  }
}

static bool RionWKQuiesceSurfaceOnMain(uint64_t token) {
  @autoreleasepool {
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    WKWebView *webView = lease.webView;
    if (!lease || !webView) return false;
    uintptr_t currentDataStore = (uintptr_t)(__bridge void *)
        webView.configuration.websiteDataStore;
    if (currentDataStore == 0 || currentDataStore != lease.dataStoreIdentity) {
      return false;
    }
    @try {
      lease.quiesceRequested = YES;
      if (lease.isolationConfirmed) return true;
      // JavaScript completion is best-effort. A busy or wedged WebContent process
      // may never invoke it, and tying native isolation to that callback leaves the
      // exact game page online until the close transaction times out. WebKit keeps
      // script evaluation and the following navigation ordered for a healthy page;
      // issue the native stop/blank request immediately in either case.
      @try {
        [webView
            evaluateJavaScript:
                @"try { globalThis.__rionPrepareForNativeClose?.(); } catch {}"
            completionHandler:nil];
      } @catch (__unused NSException *exception) {
      }
      [webView stopLoading];
      NSURL *blankURL = [NSURL URLWithString:@"about:blank"];
      if (!blankURL) return false;
      lease.blankNavigationRequested = YES;
      [webView loadRequest:[NSURLRequest requestWithURL:blankURL]];
      [lease confirmIsolationIfReady];
      return true;
    } @catch (__unused NSException *exception) {
      return false;
    }
  }
}

bool rion_wk_quiesce_surface(uint64_t token) {
  if (NSThread.isMainThread) return RionWKQuiesceSurfaceOnMain(token);
  if (token == 0) return false;
  dispatch_async(dispatch_get_main_queue(), ^{
    (void)RionWKQuiesceSurfaceOnMain(token);
  });
  return true;
}

static bool RionWKSurfaceQuiescedOnMain(uint64_t token) {
  @autoreleasepool {
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    WKWebView *webView = lease.webView;
    if (!lease || !webView || !lease.quiesceRequested ||
        !lease.blankNavigationRequested) return false;
    uintptr_t currentDataStore = (uintptr_t)(__bridge void *)
        webView.configuration.websiteDataStore;
    if (currentDataStore == 0 || currentDataStore != lease.dataStoreIdentity) {
      return false;
    }
    @try {
      NSURL *url = webView.URL;
      if (!url || ![url.absoluteString isEqualToString:@"about:blank"]) {
        return false;
      }
      [webView stopLoading];
      return !webView.loading;
    } @catch (__unused NSException *exception) {
      return false;
    }
  }
}

bool rion_wk_surface_quiesced(uint64_t token) {
  if (NSThread.isMainThread) return RionWKSurfaceQuiescedOnMain(token);
  return false;
}

static bool RionWKReleaseSurfaceOnMain(uint64_t token) {
  @autoreleasepool {
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    if (!lease) return true;
    WKWebView *webView = lease.webView;
    if (!webView) {
      RionWKFinishSurfaceLease(lease);
      return true;
    }
    uintptr_t currentDataStore = (uintptr_t)(__bridge void *)
        webView.configuration.websiteDataStore;
    if (!lease.isolationConfirmed || currentDataStore == 0 ||
        currentDataStore != lease.dataStoreIdentity) {
      return false;
    }
    @try {
      NSURL *url = webView.URL;
      if (!url || ![url.absoluteString isEqualToString:@"about:blank"] ||
          webView.loading) {
        return false;
      }
      [webView stopLoading];
      [webView removeFromSuperview];
      RionWKFinishSurfaceLease(lease);
      return true;
    } @catch (__unused NSException *exception) {
      return false;
    }
  }
}

bool rion_wk_release_surface(uint64_t token) {
  if (token == 0) return false;
  if (NSThread.isMainThread) return RionWKReleaseSurfaceOnMain(token);
  dispatch_async(dispatch_get_main_queue(), ^{
    (void)RionWKReleaseSurfaceOnMain(token);
  });
  return true;
}

static bool RionWKSurfaceReleasedOnMain(uint64_t token) {
  @autoreleasepool {
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    if (!lease) return true;
    WKWebView *webView = lease.webView;
    if (!webView) {
      RionWKFinishSurfaceLease(lease);
      return true;
    }
    uintptr_t currentDataStore = (uintptr_t)(__bridge void *)
        webView.configuration.websiteDataStore;
    if (!lease.quiesceRequested || currentDataStore == 0 ||
        currentDataStore != lease.dataStoreIdentity) {
      return false;
    }
    @try {
      // Wry removes the WKWebView from its native host when processing Close, but
      // may retain the Objective-C object past that point. Confirm the exact view
      // is detached and isolated instead of waiting for an unreachable dealloc.
      if (webView.superview || webView.window) return false;
      NSURL *url = webView.URL;
      if (url && ![url.absoluteString isEqualToString:@"about:blank"]) {
        return false;
      }
      [webView stopLoading];
      if (webView.loading) return false;
      RionWKFinishSurfaceLease(lease);
      return true;
    } @catch (__unused NSException *exception) {
      return false;
    }
  }
}

bool rion_wk_surface_released(uint64_t token) {
  if (NSThread.isMainThread) return RionWKSurfaceReleasedOnMain(token);
  return false;
}

static void RionWKNoopSurfaceCallback(void *context) { (void)context; }
static void RionWKMarkSurfaceReleased(void *context) {
  if (context) (*(int *)context)++;
}

bool rion_wk_surface_lifecycle_self_test(void) {
  @autoreleasepool {
    NSObject *firstFixture = [[NSObject alloc] init];
    NSObject *secondFixture = [[NSObject alloc] init];
    WKWebView *first = (WKWebView *)firstFixture;
    WKWebView *second = (WKWebView *)secondFixture;
    int firstContext = 0;
    int secondContext = 0;
    uint64_t firstToken = RionWKAttachSurfaceLease(
        first, 101, &firstContext, RionWKNoopSurfaceCallback,
        RionWKMarkSurfaceReleased,
        RionWKNoopSurfaceCallback);
    uint64_t secondToken = RionWKAttachSurfaceLease(
        second, 202, &secondContext, RionWKNoopSurfaceCallback,
        RionWKMarkSurfaceReleased,
        RionWKNoopSurfaceCallback);
    BOOL distinct = firstToken != 0 && secondToken != 0 && firstToken != secondToken;
    RionWKSurfaceLease *firstLease =
        [RionWKSurfaceLeases() objectForKey:@(firstToken)];
    RionWKSurfaceLease *secondLease =
        [RionWKSurfaceLeases() objectForKey:@(secondToken)];
    uintptr_t firstDataStoreIdentity = firstLease.dataStoreIdentity;
    uintptr_t secondDataStoreIdentity = secondLease.dataStoreIdentity;
    BOOL distinctDataStores = firstDataStoreIdentity != 0 &&
        secondDataStoreIdentity != 0 &&
        firstDataStoreIdentity != secondDataStoreIdentity;
    BOOL live = firstLease.webView == first && secondLease.webView == second;
    RionWKFinishSurfaceLease(firstLease);
    BOOL isolated = firstContext == 1 && secondContext == 0;
    BOOL firstRemoved =
        [RionWKSurfaceLeases() objectForKey:@(firstToken)] == nil;
    RionWKFinishSurfaceLease(secondLease);
    BOOL callbacksMatched = firstContext == 1 && secondContext == 1;
    BOOL secondRemoved =
        [RionWKSurfaceLeases() objectForKey:@(secondToken)] == nil;
    objc_setAssociatedObject(first, &RionWKSurfaceLeaseKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(second, &RionWKSurfaceLeaseKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return distinct && distinctDataStores && live && isolated && callbacksMatched &&
        firstRemoved && secondRemoved;
  }
}

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

static int32_t RionWKConfigureHighRefreshRate(
    WKWebViewConfiguration *configuration) {
  WKPreferences *preferences = configuration.preferences;
  Class preferencesClass = NSClassFromString(@"WKPreferences");
  SEL featuresSelector = NSSelectorFromString(@"_features");
  SEL setEnabledSelector = NSSelectorFromString(@"_setEnabled:forFeature:");
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
      (NSArray *)features, @"PreferPageRenderingUpdatesNear60FPSEnabled");
  if (!feature) return RionWKHighRefreshRateUnavailable;
  ((void (*)(id, SEL, BOOL, id))objc_msgSend)(
      preferences, setEnabledSelector, NO, feature);
  return RionWKHighRefreshRateApplied;
}

void *rion_wk_create_role_configuration(
    const uint8_t *dataStoreIdentifierBytes,
    int32_t *highRefreshRateStatus) {
  @autoreleasepool {
    if (highRefreshRateStatus) {
      *highRefreshRateStatus = RionWKHighRefreshRateFailed;
    }
    if (!dataStoreIdentifierBytes) return NULL;
    @try {
      uuid_t identifierBytes;
      memcpy(identifierBytes, dataStoreIdentifierBytes, sizeof(identifierBytes));
      NSUUID *identifier =
          [[NSUUID alloc] initWithUUIDBytes:identifierBytes];
      WKWebsiteDataStore *dataStore =
          [WKWebsiteDataStore dataStoreForIdentifier:identifier];
      WKWebViewConfiguration *configuration =
          [[WKWebViewConfiguration alloc] init];
      configuration.websiteDataStore = dataStore;
      int32_t status = RionWKConfigureHighRefreshRate(configuration);
      if (highRefreshRateStatus) *highRefreshRateStatus = status;
      return (__bridge_retained void *)configuration;
    } @catch (__unused NSException *exception) {
      return NULL;
    }
  }
}

int32_t rion_ns_low_power_mode_enabled(void) {
  @autoreleasepool {
    @try {
      NSProcessInfo *processInfo = NSProcessInfo.processInfo;
      SEL selector = NSSelectorFromString(@"isLowPowerModeEnabled");
      if (!processInfo || ![processInfo respondsToSelector:selector]) return -1;
      return ((BOOL (*)(id, SEL))objc_msgSend)(processInfo, selector) ? 1 : 0;
    } @catch (__unused NSException *exception) {
      return -1;
    }
  }
}

int32_t rion_ns_thermal_state(void) {
  @autoreleasepool {
    @try {
      NSProcessInfo *processInfo = NSProcessInfo.processInfo;
      SEL selector = NSSelectorFromString(@"thermalState");
      if (!processInfo || ![processInfo respondsToSelector:selector]) return -1;
      NSInteger state =
          ((NSInteger (*)(id, SEL))objc_msgSend)(processInfo, selector);
      switch (state) {
        case NSProcessInfoThermalStateNominal:
          return 0;
        case NSProcessInfoThermalStateFair:
          return 1;
        case NSProcessInfoThermalStateSerious:
          return 2;
        case NSProcessInfoThermalStateCritical:
          return 3;
        default:
          return 4;
      }
    } @catch (__unused NSException *exception) {
      return -1;
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
