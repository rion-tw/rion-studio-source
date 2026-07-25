#import "RionSystemWebViewSurface.h"

#import <objc/message.h>

namespace {

NSString *const kRionSystemMessageHandler = @"rionSystemSurface";

NSString *RionJSONString(id _Nullable value) {
  if (!value || value == NSNull.null) return @"null";
  id object = [NSJSONSerialization isValidJSONObject:value] ? value : @[ value ];
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:0
                                                   error:&error];
  if (!data || error) return @"null";
  NSString *json = [[NSString alloc] initWithData:data
                                         encoding:NSUTF8StringEncoding];
  if (object != value && json.length >= 2) {
    return [json substringWithRange:NSMakeRange(1, json.length - 2)];
  }
  return json ?: @"null";
}

NSString *RionAudioObserverScript() {
  return
      @"(() => {"
       "if (globalThis.__rionSystemAudioObserverInstalled) return;"
       "globalThis.__rionSystemAudioObserverInstalled = true;"
       "const publish = () => {"
       " const media = [...document.querySelectorAll('audio,video')];"
       " const audible = media.some((item) => !item.paused && !item.muted && "
       "item.volume > 0);"
       " globalThis.webkit?.messageHandlers?.rionSystemSurface?.postMessage({"
       "type:'audioChanged',audible});"
       "};"
       "document.addEventListener('play', publish, true);"
       "document.addEventListener('pause', publish, true);"
       "document.addEventListener('volumechange', publish, true);"
       "document.addEventListener('ended', publish, true);"
       "})();";
}

NSDictionary<NSString *, id> *RionCookieDictionary(NSHTTPCookie *cookie) {
  NSMutableDictionary<NSString *, id> *value = [@{
    @"name" : cookie.name,
    @"value" : cookie.value,
    @"domain" : cookie.domain,
    @"path" : cookie.path,
    @"secure" : @(cookie.secure),
    @"httpOnly" : @(cookie.HTTPOnly),
    @"url" : [NSString
        stringWithFormat:@"%@://%@%@",
                         cookie.secure ? @"https" : @"http",
                         [cookie.domain hasPrefix:@"."]
                             ? [cookie.domain substringFromIndex:1]
                             : cookie.domain,
                         cookie.path]
  } mutableCopy];
  if (cookie.expiresDate) {
    value[@"expirationDate"] = @(cookie.expiresDate.timeIntervalSince1970);
  }
  if ([cookie.sameSitePolicy isEqual:NSHTTPCookieSameSiteLax]) {
    value[@"sameSite"] = @"lax";
  } else if ([cookie.sameSitePolicy isEqual:NSHTTPCookieSameSiteStrict]) {
    value[@"sameSite"] = @"strict";
  } else {
    value[@"sameSite"] = @"unspecified";
  }
  return value;
}

NSHTTPCookie *_Nullable RionCookieFromDictionary(
    NSDictionary<NSString *, id> *value) {
  NSString *name = [value[@"name"] isKindOfClass:NSString.class]
                       ? value[@"name"]
                       : nil;
  NSString *cookieValue = [value[@"value"] isKindOfClass:NSString.class]
                              ? value[@"value"]
                              : nil;
  NSString *domain = [value[@"domain"] isKindOfClass:NSString.class]
                         ? value[@"domain"]
                         : nil;
  NSString *path = [value[@"path"] isKindOfClass:NSString.class]
                       ? value[@"path"]
                       : @"/";
  if (!name || !cookieValue || !domain) return nil;
  NSMutableDictionary<NSHTTPCookiePropertyKey, id> *properties =
      [@{
        NSHTTPCookieName : name,
        NSHTTPCookieValue : cookieValue,
        NSHTTPCookieDomain : domain,
        NSHTTPCookiePath : path
      } mutableCopy];
  if ([value[@"secure"] boolValue]) properties[NSHTTPCookieSecure] = @"TRUE";
  if ([value[@"httpOnly"] boolValue]) properties[@"HttpOnly"] = @"TRUE";
  if ([value[@"expirationDate"] isKindOfClass:NSNumber.class]) {
    properties[NSHTTPCookieExpires] =
        [NSDate dateWithTimeIntervalSince1970:[value[@"expirationDate"]
                                                 doubleValue]];
  }
  if ([value[@"sameSite"] isEqual:@"lax"]) {
    properties[NSHTTPCookieSameSitePolicy] = NSHTTPCookieSameSiteLax;
  } else if ([value[@"sameSite"] isEqual:@"strict"]) {
    properties[NSHTTPCookieSameSitePolicy] = NSHTTPCookieSameSiteStrict;
  }
  return [NSHTTPCookie cookieWithProperties:properties];
}

}  // namespace

@implementation RionSystemWebViewSurface {
  __weak NSView *_parentView;
  RionSystemWebViewEventHandler _eventHandler;
  BOOL _destroyed;
}

- (nullable instancetype)
    initWithParentView:(NSView *)parentView
    dataStoreIdentifier:(NSString *)dataStoreIdentifier
           eventHandler:(RionSystemWebViewEventHandler)eventHandler {
  self = [super init];
  if (!self) return nil;
  if (@available(macOS 14.0, *)) {
    NSUUID *identifier =
        [[NSUUID alloc] initWithUUIDString:dataStoreIdentifier];
    if (!identifier) return nil;

    _parentView = parentView;
    _dataStoreIdentifier = [dataStoreIdentifier copy];
    _eventHandler = [eventHandler copy];

    WKWebViewConfiguration *configuration =
        [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore =
        [WKWebsiteDataStore dataStoreForIdentifier:identifier];
    configuration.mediaTypesRequiringUserActionForPlayback =
        WKAudiovisualMediaTypeNone;
    [configuration.userContentController
        addScriptMessageHandler:self
                           name:kRionSystemMessageHandler];
    WKUserScript *audioObserver = [[WKUserScript alloc]
          initWithSource:RionAudioObserverScript()
           injectionTime:WKUserScriptInjectionTimeAtDocumentStart
        forMainFrameOnly:NO];
    [configuration.userContentController addUserScript:audioObserver];

    _webView = [[WKWebView alloc] initWithFrame:parentView.bounds
                                  configuration:configuration];
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    _webView.hidden = YES;
    _webView.autoresizingMask = NSViewNotSizable;
    [parentView addSubview:_webView];
    return self;
  }
  return nil;
}

- (BOOL)isDestroyed {
  return _destroyed;
}

- (void)emit:(NSDictionary<NSString *, id> *)event {
  if (!_destroyed && _eventHandler) _eventHandler(event);
}

- (void)loadURL:(NSString *)url {
  if (_destroyed) return;
  NSURL *parsed = [NSURL URLWithString:url];
  if (!parsed) {
    [self emit:@{
      @"type" : @"navigationFailed",
      @"url" : url,
      @"errorCode" : @"INVALID_URL"
    }];
    return;
  }
  [_webView loadRequest:[NSURLRequest requestWithURL:parsed]];
}

- (void)evaluateJavaScript:(NSString *)source requestID:(NSString *)requestID {
  if (_destroyed) return;
  __weak RionSystemWebViewSurface *weakSelf = self;
  [_webView evaluateJavaScript:source
             completionHandler:^(id result, NSError *error) {
    RionSystemWebViewSurface *strongSelf = weakSelf;
    if (!strongSelf || strongSelf.destroyed) return;
    if (error) {
      [strongSelf emit:@{
        @"type" : @"evaluationCompleted",
        @"requestId" : requestID,
        @"error" : error.localizedDescription ?: @"JavaScript evaluation failed."
      }];
      return;
    }
    [strongSelf emit:@{
      @"type" : @"evaluationCompleted",
      @"requestId" : requestID,
      @"valueJson" : RionJSONString(result)
    }];
  }];
}

- (void)clearWebsiteDataForRequest:(NSString *)requestID {
  if (_destroyed) return;
  WKWebsiteDataStore *store = _webView.configuration.websiteDataStore;
  NSSet<NSString *> *types = WKWebsiteDataStore.allWebsiteDataTypes;
  __weak RionSystemWebViewSurface *weakSelf = self;
  [store removeDataOfTypes:types
             modifiedSince:NSDate.distantPast
         completionHandler:^{
    RionSystemWebViewSurface *strongSelf = weakSelf;
    if (!strongSelf || strongSelf.destroyed) return;
    [strongSelf emit:@{
      @"type" : @"websiteDataCleared",
      @"requestId" : requestID
    }];
  }];
}

- (void)getCookiesForRequest:(NSString *)requestID {
  if (_destroyed) return;
  __weak RionSystemWebViewSurface *weakSelf = self;
  [_webView.configuration.websiteDataStore.httpCookieStore
      getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    RionSystemWebViewSurface *strongSelf = weakSelf;
    if (!strongSelf || strongSelf.destroyed) return;
    NSMutableArray<NSDictionary<NSString *, id> *> *values =
        [NSMutableArray arrayWithCapacity:cookies.count];
    for (NSHTTPCookie *cookie in cookies) {
      [values addObject:RionCookieDictionary(cookie)];
    }
    [strongSelf emit:@{
      @"type" : @"cookiesRead",
      @"requestId" : requestID,
      @"cookiesJson" : RionJSONString(values)
    }];
  }];
}

- (void)setCookiesFromJSON:(NSString *)cookiesJSON
                 requestID:(NSString *)requestID {
  if (_destroyed) return;
  NSError *decodeError = nil;
  id decoded = [NSJSONSerialization
      JSONObjectWithData:[cookiesJSON dataUsingEncoding:NSUTF8StringEncoding]
                 options:0
                   error:&decodeError];
  if (decodeError || ![decoded isKindOfClass:NSArray.class]) {
    [self emit:@{
      @"type" : @"cookiesWritten",
      @"requestId" : requestID,
      @"error" : @"The cookie migration payload is invalid."
    }];
    return;
  }
  NSMutableArray<NSHTTPCookie *> *cookies = [NSMutableArray array];
  for (id value in (NSArray *)decoded) {
    if (![value isKindOfClass:NSDictionary.class]) continue;
    NSHTTPCookie *cookie = RionCookieFromDictionary(value);
    if (cookie) [cookies addObject:cookie];
  }
  WKHTTPCookieStore *store =
      _webView.configuration.websiteDataStore.httpCookieStore;
  if (cookies.count == 0) {
    [self emit:@{
      @"type" : @"cookiesWritten",
      @"requestId" : requestID,
      @"count" : @0
    }];
    return;
  }
  __block NSUInteger remaining = cookies.count;
  __weak RionSystemWebViewSurface *weakSelf = self;
  for (NSHTTPCookie *cookie in cookies) {
    [store setCookie:cookie
        completionHandler:^{
      remaining -= 1;
      if (remaining != 0) return;
      RionSystemWebViewSurface *strongSelf = weakSelf;
      if (!strongSelf || strongSelf.destroyed) return;
      [strongSelf emit:@{
        @"type" : @"cookiesWritten",
        @"requestId" : requestID,
        @"count" : @(cookies.count)
      }];
    }];
  }
}

- (void)setFrameFromTopLeftRect:(NSRect)rect {
  if (_destroyed) return;
  NSView *parent = _parentView;
  if (!parent) return;
  CGFloat y = parent.isFlipped
                  ? rect.origin.y
                  : NSHeight(parent.bounds) - rect.origin.y - rect.size.height;
  _webView.frame = NSMakeRect(rect.origin.x, y, rect.size.width,
                              rect.size.height);
}

- (void)setVisible:(BOOL)visible {
  if (!_destroyed) _webView.hidden = !visible;
}

- (void)setPageZoom:(CGFloat)zoom {
  if (!_destroyed) _webView.pageZoom = MAX(0.25, MIN(5.0, zoom));
}

- (BOOL)setAudioMuted:(BOOL)muted {
  if (_destroyed) return NO;
  SEL selector = NSSelectorFromString(@"_setMuted:");
  if (![_webView respondsToSelector:selector]) return NO;
  using SetMuted = void (*)(id, SEL, BOOL);
  reinterpret_cast<SetMuted>(objc_msgSend)(_webView, selector, muted);
  return YES;
}

- (void)focus {
  if (_destroyed) return;
  [_webView.window makeFirstResponder:_webView];
}

- (void)destroy {
  if (_destroyed) return;
  _destroyed = YES;
  [_webView stopLoading];
  _webView.navigationDelegate = nil;
  _webView.UIDelegate = nil;
  [_webView.configuration.userContentController
      removeScriptMessageHandlerForName:kRionSystemMessageHandler];
  [_webView removeFromSuperview];
  _webView = nil;
  _eventHandler = nil;
}

- (void)webView:(WKWebView *)webView
    didFinishNavigation:(WKNavigation *)navigation {
  (void)navigation;
  [self emit:@{
    @"type" : @"navigationCompleted",
    @"url" : webView.URL.absoluteString ?: @""
  }];
}

- (void)webView:(WKWebView *)webView
    didFailNavigation:(WKNavigation *)navigation
             withError:(NSError *)error {
  (void)navigation;
  [self emit:@{
    @"type" : @"navigationFailed",
    @"url" : webView.URL.absoluteString ?: @"",
    @"errorCode" : @(error.code).stringValue
  }];
}

- (void)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(WKNavigation *)navigation
                       withError:(NSError *)error {
  [self webView:webView didFailNavigation:navigation withError:error];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  (void)webView;
  [self emit:@{
    @"type" : @"crashed",
    @"reason" : @"web-content-process-terminated"
  }];
}

- (nullable WKWebView *)
          webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
  (void)webView;
  (void)configuration;
  (void)windowFeatures;
  [self emit:@{
    @"type" : @"popupRequested",
    @"url" : navigationAction.request.URL.absoluteString ?: @""
  }];
  return nil;
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
  (void)userContentController;
  if (![message.name isEqualToString:kRionSystemMessageHandler] ||
      ![message.body isKindOfClass:NSDictionary.class]) {
    return;
  }
  NSDictionary *body = (NSDictionary *)message.body;
  if ([body[@"type"] isEqual:@"audioChanged"] &&
      [body[@"audible"] isKindOfClass:NSNumber.class]) {
    [self emit:@{
      @"type" : @"audioChanged",
      @"audible" : body[@"audible"]
    }];
  }
}

@end
