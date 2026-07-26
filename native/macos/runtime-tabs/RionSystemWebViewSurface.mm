#import "RionSystemWebViewSurface.h"

#import <Network/Network.h>
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

NSArray<nw_proxy_config_t> *_Nullable RionProxyConfigurations(
    NSString *server) API_AVAILABLE(macos(14.0)) {
  if (server.length == 0) return nil;
  NSURLComponents *components =
      [NSURLComponents componentsWithString:server];
  NSString *scheme = components.scheme.lowercaseString;
  NSString *host = components.host;
  if (!host || !scheme) return nil;
  NSNumber *port = components.port;
  if (!port) {
    if ([scheme isEqualToString:@"http"]) {
      port = @80;
    } else if ([scheme isEqualToString:@"https"]) {
      port = @443;
    } else if ([scheme isEqualToString:@"socks5"]) {
      port = @1080;
    } else {
      return nil;
    }
  }
  NSString *service = port.stringValue;
  nw_endpoint_t endpoint =
      nw_endpoint_create_host(host.UTF8String, service.UTF8String);
  if (!endpoint) return nil;
  nw_proxy_config_t proxy = nil;
  if ([scheme isEqualToString:@"socks5"]) {
    proxy = nw_proxy_config_create_socksv5(endpoint);
  } else if ([scheme isEqualToString:@"http"] ||
             [scheme isEqualToString:@"https"]) {
    nw_protocol_options_t tls =
        [scheme isEqualToString:@"https"] ? nw_tls_create_options() : nil;
    proxy = nw_proxy_config_create_http_connect(endpoint, tls);
  }
  if (!proxy) return nil;
  nw_proxy_config_set_failover_allowed(proxy, false);
  return @[ proxy ];
}

}  // namespace

@implementation RionSystemWebViewSurface {
  __weak NSView *_parentView;
  RionSystemWebViewEventHandler _eventHandler;
  BOOL _destroyed;
  BOOL _audioMuted;
  NSMutableArray<WKWebView *> *_popupWebViews;
  NSMapTable<WKWebView *, NSNumber *> *_audibleStates;
}

- (nullable instancetype)
    initWithParentView:(NSView *)parentView
    dataStoreIdentifier:(NSString *)dataStoreIdentifier
            proxyServer:(NSString *)proxyServer
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
    _popupWebViews = [NSMutableArray array];
    _audibleStates = [NSMapTable weakToStrongObjectsMapTable];

    WKWebViewConfiguration *configuration =
        [[WKWebViewConfiguration alloc] init];
    WKWebsiteDataStore *dataStore =
        [WKWebsiteDataStore dataStoreForIdentifier:identifier];
    if (proxyServer.length > 0) {
      NSArray<nw_proxy_config_t> *proxyConfigurations =
          RionProxyConfigurations(proxyServer);
      if (!proxyConfigurations) return nil;
      dataStore.proxyConfigurations = proxyConfigurations;
    }
    configuration.websiteDataStore = dataStore;
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

- (void)addDocumentStartScript:(NSString *)source
                     requestID:(NSString *)requestID {
  if (_destroyed) return;
  if (source.length == 0) {
    [self emit:@{
      @"type" : @"documentStartScriptAdded",
      @"requestId" : requestID,
      @"error" : @"The document-start script is empty."
    }];
    return;
  }
  WKUserScript *script = [[WKUserScript alloc]
        initWithSource:source
         injectionTime:WKUserScriptInjectionTimeAtDocumentStart
      forMainFrameOnly:NO];
  [_webView.configuration.userContentController addUserScript:script];
  [self emit:@{
    @"type" : @"documentStartScriptAdded",
    @"requestId" : requestID
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

- (void)setFrameFromTopLeftRect:(NSRect)rect {
  if (_destroyed) return;
  NSView *parent = _parentView;
  if (!parent) return;
  CGFloat y = parent.isFlipped
                  ? rect.origin.y
                  : NSHeight(parent.bounds) - rect.origin.y - rect.size.height;
  _webView.frame = NSMakeRect(rect.origin.x, y, rect.size.width,
                              rect.size.height);
  for (WKWebView *popup in _popupWebViews) {
    popup.frame = _webView.frame;
  }
}

- (void)setVisible:(BOOL)visible {
  if (_destroyed) return;
  _webView.hidden = !visible;
  for (WKWebView *popup in _popupWebViews) {
    popup.hidden = !visible;
  }
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
  for (WKWebView *popup in _popupWebViews) {
    if (![popup respondsToSelector:selector]) return NO;
    reinterpret_cast<SetMuted>(objc_msgSend)(popup, selector, muted);
  }
  _audioMuted = muted;
  return YES;
}

- (void)focus {
  if (_destroyed) return;
  WKWebView *target = _popupWebViews.lastObject ?: _webView;
  [target.window makeFirstResponder:target];
}

- (void)destroy {
  if (_destroyed) return;
  _destroyed = YES;
  for (WKWebView *popup in [_popupWebViews copy]) {
    [popup stopLoading];
    popup.navigationDelegate = nil;
    popup.UIDelegate = nil;
    [popup removeFromSuperview];
  }
  [_popupWebViews removeAllObjects];
  [_audibleStates removeAllObjects];
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
  if (webView != _webView) return;
  [self emit:@{
    @"type" : @"navigationCompleted",
    @"url" : webView.URL.absoluteString ?: @""
  }];
}

- (void)webView:(WKWebView *)webView
    didFailNavigation:(WKNavigation *)navigation
             withError:(NSError *)error {
  (void)navigation;
  if (webView != _webView) return;
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

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationResponse:(WKNavigationResponse *)navigationResponse
                      decisionHandler:
                          (void (^)(WKNavigationResponsePolicy))decisionHandler {
  (void)webView;
  decisionHandler(navigationResponse.canShowMIMEType
                      ? WKNavigationResponsePolicyAllow
                      : WKNavigationResponsePolicyDownload);
}

- (void)webView:(WKWebView *)webView
    navigationAction:(WKNavigationAction *)navigationAction
    didBecomeDownload:(WKDownload *)download {
  (void)webView;
  download.delegate = self;
  [self emit:@{
    @"type" : @"downloadStarted",
    @"filename" : navigationAction.request.URL.lastPathComponent ?: @""
  }];
}

- (void)webView:(WKWebView *)webView
    navigationResponse:(WKNavigationResponse *)navigationResponse
    didBecomeDownload:(WKDownload *)download {
  (void)webView;
  download.delegate = self;
  [self emit:@{
    @"type" : @"downloadStarted",
    @"filename" : navigationResponse.response.suggestedFilename ?: @""
  }];
}

- (void)download:(WKDownload *)download
    decideDestinationUsingResponse:(NSURLResponse *)response
                 suggestedFilename:(NSString *)suggestedFilename
                 completionHandler:
                     (void (^)(NSURL *_Nullable destination))completionHandler {
  (void)download;
  NSSavePanel *panel = [NSSavePanel savePanel];
  panel.canCreateDirectories = YES;
  panel.nameFieldStringValue =
      suggestedFilename.length > 0
          ? suggestedFilename
          : response.suggestedFilename ?: @"download";
  NSWindow *window = _webView.window;
  if (!window) {
    completionHandler(nil);
    return;
  }
  [panel beginSheetModalForWindow:window
               completionHandler:^(NSModalResponse result) {
    completionHandler(result == NSModalResponseOK ? panel.URL : nil);
  }];
}

- (void)downloadDidFinish:(WKDownload *)download {
  (void)download;
  [self emit:@{ @"type" : @"downloadCompleted" }];
}

- (void)download:(WKDownload *)download
    didFailWithError:(NSError *)error
          resumeData:(nullable NSData *)resumeData {
  (void)download;
  (void)resumeData;
  [self emit:@{
    @"type" : @"downloadFailed",
    @"reason" : error.localizedDescription ?: @"The download failed."
  }];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  (void)webView;
  [self emit:@{
    @"type" : @"crashed",
    @"reason" : @"web-content-process-terminated"
  }];
}

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:
                 (void (^)(NSArray<NSURL *> *_Nullable URLs))completionHandler {
  (void)frame;
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  panel.canChooseDirectories = parameters.allowsDirectories;
  panel.canChooseFiles = YES;
  panel.resolvesAliases = YES;
  NSWindow *window = webView.window ?: _webView.window;
  if (!window) {
    completionHandler(nil);
    return;
  }
  [panel beginSheetModalForWindow:window
               completionHandler:^(NSModalResponse result) {
    completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
  }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = message ?: @"";
  [alert addButtonWithTitle:NSLocalizedString(@"OK", nil)];
  NSWindow *window = webView.window ?: _webView.window;
  if (!window) {
    completionHandler();
    return;
  }
  [alert beginSheetModalForWindow:window
                completionHandler:^(__unused NSModalResponse result) {
    completionHandler();
  }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:
                           (void (^)(BOOL result))completionHandler {
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = message ?: @"";
  [alert addButtonWithTitle:NSLocalizedString(@"OK", nil)];
  [alert addButtonWithTitle:NSLocalizedString(@"Cancel", nil)];
  NSWindow *window = webView.window ?: _webView.window;
  if (!window) {
    completionHandler(NO);
    return;
  }
  [alert beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse result) {
    completionHandler(result == NSAlertFirstButtonReturn);
  }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
                             defaultText:(nullable NSString *)defaultText
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:
                           (void (^)(NSString *_Nullable result))
                               completionHandler {
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = prompt ?: @"";
  [alert addButtonWithTitle:NSLocalizedString(@"OK", nil)];
  [alert addButtonWithTitle:NSLocalizedString(@"Cancel", nil)];
  NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
  input.stringValue = defaultText ?: @"";
  alert.accessoryView = input;
  NSWindow *window = webView.window ?: _webView.window;
  if (!window) {
    completionHandler(nil);
    return;
  }
  [alert beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse result) {
    completionHandler(result == NSAlertFirstButtonReturn
                          ? input.stringValue
                          : nil);
  }];
}

- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                     type:(WKMediaCaptureType)type
                          decisionHandler:
                              (void (^)(WKPermissionDecision decision))
                                  decisionHandler {
  (void)webView;
  (void)origin;
  (void)frame;
  (void)type;
  decisionHandler(WKPermissionDecisionDeny);
}

- (void)webView:(WKWebView *)webView
    didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge
                    completionHandler:
                        (void (^)(NSURLSessionAuthChallengeDisposition disposition,
                                  NSURLCredential *_Nullable credential))
                            completionHandler {
  (void)webView;
  (void)challenge;
  completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
}

- (nullable WKWebView *)
          webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
  (void)webView;
  (void)windowFeatures;
  if (_destroyed) return nil;
  WKWebView *popup = [[WKWebView alloc] initWithFrame:_webView.frame
                                        configuration:configuration];
  if (!popup) {
    [self emit:@{
      @"type" : @"popupRequested",
      @"url" : navigationAction.request.URL.absoluteString ?: @""
    }];
    return nil;
  }
  popup.navigationDelegate = self;
  popup.UIDelegate = self;
  popup.hidden = _webView.hidden;
  popup.autoresizingMask = NSViewNotSizable;
  [_parentView addSubview:popup positioned:NSWindowAbove relativeTo:nil];
  [_popupWebViews addObject:popup];
  if (_audioMuted) (void)[self setAudioMuted:YES];
  [self emit:@{
    @"type" : @"popupCreated",
    @"url" : navigationAction.request.URL.absoluteString ?: @""
  }];
  return popup;
}

- (void)webViewDidClose:(WKWebView *)webView {
  if (_destroyed || webView == _webView ||
      ![_popupWebViews containsObject:webView]) {
    return;
  }
  NSString *url = webView.URL.absoluteString ?: @"";
  [webView stopLoading];
  webView.navigationDelegate = nil;
  webView.UIDelegate = nil;
  [webView removeFromSuperview];
  [_popupWebViews removeObject:webView];
  [_audibleStates removeObjectForKey:webView];
  [self emit:@{
    @"type" : @"popupClosed",
    @"url" : url
  }];
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
    WKWebView *source = message.webView ?: _webView;
    [_audibleStates setObject:body[@"audible"] forKey:source];
    BOOL audible = NO;
    for (WKWebView *candidate in _audibleStates) {
      audible = audible ||
          [[_audibleStates objectForKey:candidate] boolValue];
    }
    [self emit:@{
      @"type" : @"audioChanged",
      @"audible" : @(audible)
    }];
    return;
  }
  if ([body[@"type"] isEqual:@"overlayRequest"]) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:body
                                                   options:0
                                                     error:&error];
    NSString *messageJSON =
        data && !error
            ? [[NSString alloc] initWithData:data
                                    encoding:NSUTF8StringEncoding]
            : nil;
    if (messageJSON) {
      [self emit:@{
        @"type" : @"bridgeMessage",
        @"messageJson" : messageJSON
      }];
    }
  }
}

@end
