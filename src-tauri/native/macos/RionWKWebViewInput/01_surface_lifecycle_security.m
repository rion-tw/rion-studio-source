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

enum {
  RionWKSurfaceBlankNavigationStarted = 1,
  RionWKSurfaceNavigationFinished = 2,
  RionWKSurfaceNavigationFailed = 3,
  RionWKSurfaceProvisionalNavigationFailed = 4,
  RionWKSurfaceWebContentProcessTerminated = 5,
  RionWKSurfaceDataStoreMismatch = 6,
  RionWKSurfaceNavigationSubmissionFailed = 7,
  RionWKSurfaceReleaseFailed = 8,
  RionWKSurfaceLeaseDestroyed = 9,
  RionWKSurfaceStaleEvent = 10,
};

typedef void (*RionWKSurfaceReleasedCallback)(void *context);
typedef void (*RionWKSurfaceEventCallback)(void *context, int32_t event);
typedef void (*RionWKSurfaceContextDestructor)(void *context);

@class RionWKNavigationDelegateProxy;

@interface RionWKSurfaceLease : NSObject
@property(nonatomic, weak) WKWebView *webView;
@property(nonatomic, assign) uintptr_t dataStoreIdentity;
@property(nonatomic, assign) uint64_t token;
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) RionWKSurfaceReleasedCallback releasedCallback;
@property(nonatomic, assign) RionWKSurfaceEventCallback eventCallback;
@property(nonatomic, assign) RionWKSurfaceContextDestructor contextDestructor;
@property(nonatomic, assign) BOOL quiesceRequested;
@property(nonatomic, strong) WKNavigation *blankNavigation;
@property(nonatomic, assign) BOOL isolationConfirmed;
@property(nonatomic, assign) BOOL terminalEventDelivered;
@property(nonatomic, assign) BOOL releaseFailureDelivered;
- (BOOL)dataStoreMatches;
- (void)emitIsolationEvent:(int32_t)event confirmed:(BOOL)confirmed;
- (void)emitReleaseFailure;
- (void)emitStaleEvent;
- (void)navigationDidFinish:(WKNavigation *)navigation;
- (void)navigation:(WKNavigation *)navigation didFailWithEvent:(int32_t)event;
- (void)webContentProcessDidTerminate;
- (void)finishContextAcknowledgingRelease:(BOOL)acknowledgeRelease;
@end

@implementation RionWKSurfaceLease
- (BOOL)dataStoreMatches {
  WKWebView *webView = _webView;
  if (!webView) return NO;
  uintptr_t currentDataStore = (uintptr_t)(__bridge void *)
      webView.configuration.websiteDataStore;
  return currentDataStore != 0 && currentDataStore == _dataStoreIdentity;
}

- (void)emitIsolationEvent:(int32_t)event confirmed:(BOOL)confirmed {
  if (_terminalEventDelivered) return;
  _terminalEventDelivered = YES;
  _isolationConfirmed = confirmed;
  if (_context && _eventCallback) _eventCallback(_context, event);
}

- (void)emitReleaseFailure {
  if (_releaseFailureDelivered) return;
  _releaseFailureDelivered = YES;
  if (_context && _eventCallback) {
    _eventCallback(_context, RionWKSurfaceReleaseFailed);
  }
}

- (void)emitStaleEvent {
  if (_context && _eventCallback) {
    _eventCallback(_context, RionWKSurfaceStaleEvent);
  }
}

- (void)navigationDidFinish:(WKNavigation *)navigation {
  if (!_quiesceRequested || !navigation) return;
  if (_terminalEventDelivered || navigation != _blankNavigation) {
    [self emitStaleEvent];
    return;
  }
  if (![self dataStoreMatches]) {
    [self navigation:navigation didFailWithEvent:RionWKSurfaceDataStoreMismatch];
    return;
  }
  [self emitIsolationEvent:RionWKSurfaceNavigationFinished confirmed:YES];
}

- (void)navigation:(WKNavigation *)navigation didFailWithEvent:(int32_t)event {
  if (!_quiesceRequested || !navigation) return;
  if (_terminalEventDelivered || navigation != _blankNavigation) {
    [self emitStaleEvent];
    return;
  }
  [self emitIsolationEvent:event confirmed:NO];
}

- (void)webContentProcessDidTerminate {
  if (!_quiesceRequested) return;
  if (_terminalEventDelivered) {
    [self emitStaleEvent];
    return;
  }
  [self emitIsolationEvent:RionWKSurfaceWebContentProcessTerminated
                 confirmed:YES];
}

- (void)finishContextAcknowledgingRelease:(BOOL)acknowledgeRelease {
  if (!_context) return;
  void *context = _context;
  RionWKSurfaceReleasedCallback releasedCallback = _releasedCallback;
  RionWKSurfaceContextDestructor contextDestructor = _contextDestructor;
  _context = NULL;
  _releasedCallback = NULL;
  _eventCallback = NULL;
  _contextDestructor = NULL;
  _blankNavigation = nil;
  if (acknowledgeRelease && releasedCallback) releasedCallback(context);
  if (contextDestructor) contextDestructor(context);
}

- (void)dealloc {
  if (_quiesceRequested && !_terminalEventDelivered) {
    [self emitIsolationEvent:RionWKSurfaceLeaseDestroyed confirmed:NO];
  }
  [self finishContextAcknowledgingRelease:NO];
}
@end

@interface RionWKNavigationDelegateProxy : NSObject <WKNavigationDelegate>
@property(nonatomic, weak) RionWKSurfaceLease *lease;
@property(nonatomic, strong) id<WKNavigationDelegate> downstream;
@end

@implementation RionWKNavigationDelegateProxy
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] ||
      [_downstream respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
  return [_downstream respondsToSelector:selector]
      ? _downstream
      : [super forwardingTargetForSelector:selector];
}

- (void)webView:(WKWebView *)webView
    didFinishNavigation:(WKNavigation *)navigation {
  [_lease navigationDidFinish:navigation];
  if ([_downstream respondsToSelector:_cmd]) {
    [_downstream webView:webView didFinishNavigation:navigation];
  }
}

- (void)webView:(WKWebView *)webView
    didFailNavigation:(WKNavigation *)navigation
             withError:(NSError *)error {
  [_lease navigation:navigation didFailWithEvent:RionWKSurfaceNavigationFailed];
  if ([_downstream respondsToSelector:_cmd]) {
    [_downstream webView:webView didFailNavigation:navigation withError:error];
  }
}

- (void)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(WKNavigation *)navigation
                       withError:(NSError *)error {
  [_lease navigation:navigation
      didFailWithEvent:RionWKSurfaceProvisionalNavigationFailed];
  if ([_downstream respondsToSelector:_cmd]) {
    [_downstream webView:webView
        didFailProvisionalNavigation:navigation
                           withError:error];
  }
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  [_lease webContentProcessDidTerminate];
  if ([_downstream respondsToSelector:_cmd]) {
    [_downstream webViewWebContentProcessDidTerminate:webView];
  }
}
@end

static char RionWKSurfaceLeaseKey;
static char RionWKNavigationDelegateProxyKey;

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
    RionWKSurfaceEventCallback eventCallback,
    RionWKSurfaceReleasedCallback releasedCallback,
    RionWKSurfaceContextDestructor contextDestructor) {
  if (!webView || dataStoreIdentity == 0 || !context || !releasedCallback ||
      !eventCallback || !contextDestructor) return 0;
  RionWKSurfaceLease *lease = [[RionWKSurfaceLease alloc] init];
  lease.webView = webView;
  lease.dataStoreIdentity = dataStoreIdentity;
  lease.token = RionWKNextSurfaceToken();
  lease.context = context;
  lease.releasedCallback = releasedCallback;
  lease.eventCallback = eventCallback;
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
    RionWKNavigationDelegateProxy *proxy =
        objc_getAssociatedObject(webView, &RionWKNavigationDelegateProxyKey);
    if (proxy && [webView respondsToSelector:@selector(navigationDelegate)] &&
        webView.navigationDelegate == proxy) {
      webView.navigationDelegate = proxy.downstream;
    }
    objc_setAssociatedObject(webView, &RionWKNavigationDelegateProxyKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(webView, &RionWKSurfaceLeaseKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  [RionWKSurfaceLeases() removeObjectForKey:@(token)];
  [lease finishContextAcknowledgingRelease:YES];
}

uint64_t rion_wk_track_surface(
    void *rawWebView, void *context,
    RionWKSurfaceEventCallback eventCallback,
    RionWKSurfaceReleasedCallback releasedCallback,
    RionWKSurfaceContextDestructor contextDestructor) {
  @autoreleasepool {
    if (!rawWebView) return 0;
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    uintptr_t dataStoreIdentity = (uintptr_t)(__bridge void *)
        webView.configuration.websiteDataStore;
    uint64_t token = RionWKAttachSurfaceLease(
        webView, dataStoreIdentity, context, eventCallback, releasedCallback,
        contextDestructor);
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    if (!lease) return 0;
    RionWKNavigationDelegateProxy *proxy =
        [[RionWKNavigationDelegateProxy alloc] init];
    proxy.lease = lease;
    proxy.downstream = webView.navigationDelegate;
    objc_setAssociatedObject(webView, &RionWKNavigationDelegateProxyKey, proxy,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    webView.navigationDelegate = proxy;
    return token;
  }
}

static bool RionWKQuiesceSurfaceOnMain(uint64_t token) {
  @autoreleasepool {
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    WKWebView *webView = lease.webView;
    if (!lease || !webView) return false;
    if (![lease dataStoreMatches]) {
      [lease emitIsolationEvent:RionWKSurfaceDataStoreMismatch confirmed:NO];
      return false;
    }
    @try {
      lease.quiesceRequested = YES;
      if (lease.isolationConfirmed) return true;
      // Script cleanup is an ordered best-effort submission. Isolation itself is
      // proven only by the exact WKNavigation delegate event below.
      @try {
        [webView
            evaluateJavaScript:
                @"try { globalThis.__rionPrepareForNativeClose?.(); } catch {}"
            completionHandler:nil];
      } @catch (__unused NSException *exception) {
      }
      [webView stopLoading];
      NSURL *blankURL = [NSURL URLWithString:@"about:blank"];
      if (!blankURL) {
        [lease emitIsolationEvent:RionWKSurfaceNavigationSubmissionFailed
                        confirmed:NO];
        return false;
      }
      WKNavigation *navigation =
          [webView loadRequest:[NSURLRequest requestWithURL:blankURL]];
      if (!navigation) {
        [lease emitIsolationEvent:RionWKSurfaceNavigationSubmissionFailed
                        confirmed:NO];
        return false;
      }
      lease.blankNavigation = navigation;
      if (lease.context && lease.eventCallback) {
        lease.eventCallback(lease.context, RionWKSurfaceBlankNavigationStarted);
      }
      return true;
    } @catch (__unused NSException *exception) {
      [lease emitIsolationEvent:RionWKSurfaceNavigationSubmissionFailed
                      confirmed:NO];
      return false;
    }
  }
}

bool rion_wk_quiesce_surface(uint64_t token) {
  if (NSThread.isMainThread) return RionWKQuiesceSurfaceOnMain(token);
  if (token == 0) return false;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!RionWKQuiesceSurfaceOnMain(token)) {
      RionWKSurfaceLease *lease =
          [RionWKSurfaceLeases() objectForKey:@(token)];
      if (lease && !lease.terminalEventDelivered) {
        [lease emitIsolationEvent:RionWKSurfaceNavigationSubmissionFailed
                        confirmed:NO];
      }
    }
  });
  return true;
}

static bool RionWKReleaseSurfaceOnMain(uint64_t token) {
  @autoreleasepool {
    RionWKSurfaceLease *lease = [RionWKSurfaceLeases() objectForKey:@(token)];
    if (!lease) return true;
    WKWebView *webView = lease.webView;
    if (!webView) {
      [lease emitReleaseFailure];
      return false;
    }
    if (!lease.isolationConfirmed || ![lease dataStoreMatches]) {
      [lease emitReleaseFailure];
      return false;
    }
    @try {
      [webView removeFromSuperview];
      RionWKFinishSurfaceLease(lease);
      return true;
    } @catch (__unused NSException *exception) {
      [lease emitReleaseFailure];
      return false;
    }
  }
}

bool rion_wk_release_surface(uint64_t token) {
  if (token == 0) return false;
  if (NSThread.isMainThread) return RionWKReleaseSurfaceOnMain(token);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!RionWKReleaseSurfaceOnMain(token)) {
      RionWKSurfaceLease *lease =
          [RionWKSurfaceLeases() objectForKey:@(token)];
      [lease emitReleaseFailure];
    }
  });
  return true;
}

static void RionWKNoopSurfaceEvent(void *context, int32_t event) {
  (void)context;
  (void)event;
}
static void RionWKNoopSurfaceContext(void *context) { (void)context; }
static void RionWKMarkSurfaceReleased(void *context) {
  if (context) (*(int *)context)++;
}

typedef struct {
  int eventCount;
  int staleEventCount;
  int terminalEventCount;
  int32_t lastTerminalEvent;
  int releaseCount;
} RionWKSurfaceTestContext;

static void RionWKRecordSurfaceEvent(void *context, int32_t event) {
  if (!context) return;
  RionWKSurfaceTestContext *record = context;
  record->eventCount++;
  if (event == RionWKSurfaceStaleEvent) {
    record->staleEventCount++;
  } else {
    record->terminalEventCount++;
    record->lastTerminalEvent = event;
  }
}

static void RionWKRecordSurfaceRelease(void *context) {
  if (context) ((RionWKSurfaceTestContext *)context)->releaseCount++;
}

@interface RionWKNavigationDelegateFixture : NSObject <WKNavigationDelegate>
@property(nonatomic, assign) int failureCount;
@end

@implementation RionWKNavigationDelegateFixture
- (void)webView:(WKWebView *)webView
    didFailNavigation:(WKNavigation *)navigation
             withError:(NSError *)error {
  (void)webView;
  (void)navigation;
  (void)error;
  _failureCount++;
}
@end

bool rion_wk_surface_lifecycle_self_test(void) {
  @autoreleasepool {
    NSObject *firstFixture = [[NSObject alloc] init];
    NSObject *secondFixture = [[NSObject alloc] init];
    WKWebView *first = (WKWebView *)firstFixture;
    WKWebView *second = (WKWebView *)secondFixture;
    int firstContext = 0;
    int secondContext = 0;
    uint64_t firstToken = RionWKAttachSurfaceLease(
        first, 101, &firstContext, RionWKNoopSurfaceEvent,
        RionWKMarkSurfaceReleased,
        RionWKNoopSurfaceContext);
    uint64_t secondToken = RionWKAttachSurfaceLease(
        second, 202, &secondContext, RionWKNoopSurfaceEvent,
        RionWKMarkSurfaceReleased,
        RionWKNoopSurfaceContext);
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

    RionWKSurfaceTestContext eventContext = {0};
    RionWKSurfaceLease *eventLease = [[RionWKSurfaceLease alloc] init];
    NSObject *exactNavigationFixture = [[NSObject alloc] init];
    NSObject *staleNavigationFixture = [[NSObject alloc] init];
    WKNavigation *exactNavigation = (WKNavigation *)exactNavigationFixture;
    eventLease.context = &eventContext;
    eventLease.eventCallback = RionWKRecordSurfaceEvent;
    eventLease.releasedCallback = RionWKRecordSurfaceRelease;
    eventLease.contextDestructor = RionWKNoopSurfaceContext;
    eventLease.quiesceRequested = YES;
    eventLease.blankNavigation = exactNavigation;
    [eventLease navigation:(WKNavigation *)staleNavigationFixture
          didFailWithEvent:RionWKSurfaceNavigationFailed];
    BOOL staleObserved = eventContext.eventCount == 1 &&
        eventContext.staleEventCount == 1 &&
        eventContext.terminalEventCount == 0;
    RionWKNavigationDelegateFixture *downstream =
        [[RionWKNavigationDelegateFixture alloc] init];
    RionWKNavigationDelegateProxy *proxy =
        [[RionWKNavigationDelegateProxy alloc] init];
    proxy.lease = eventLease;
    proxy.downstream = downstream;
    NSError *navigationError =
        [NSError errorWithDomain:@"RionWKSurfaceSelfTest" code:1 userInfo:nil];
    [proxy webView:first
        didFailNavigation:exactNavigation
                 withError:navigationError];
    [proxy webView:first
        didFailNavigation:exactNavigation
                 withError:navigationError];
    BOOL exactFailureOnce = eventContext.terminalEventCount == 1 &&
        eventContext.lastTerminalEvent == RionWKSurfaceNavigationFailed &&
        eventContext.staleEventCount == 2;
    BOOL delegateForwarded = downstream.failureCount == 2;
    [eventLease emitReleaseFailure];
    [eventLease emitReleaseFailure];
    BOOL releaseFailureOnce = eventContext.terminalEventCount == 2 &&
        eventContext.lastTerminalEvent == RionWKSurfaceReleaseFailed;
    [eventLease finishContextAcknowledgingRelease:YES];
    [eventLease finishContextAcknowledgingRelease:YES];
    BOOL releaseOnce = eventContext.releaseCount == 1;

    objc_setAssociatedObject(first, &RionWKSurfaceLeaseKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(second, &RionWKSurfaceLeaseKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return distinct && distinctDataStores && live && isolated && callbacksMatched &&
        firstRemoved && secondRemoved && staleObserved && exactFailureOnce &&
        delegateForwarded && releaseFailureOnce && releaseOnce;
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
