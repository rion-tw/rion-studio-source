#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^RionSystemWebViewEventHandler)(
    NSDictionary<NSString *, id> *event);

/// A macOS 14+ WKWebView child surface with a role-isolated persistent store.
///
/// The Node addon owns one instance per role. No WKWebView or AppKit object
/// crosses the native boundary.
@interface RionSystemWebViewSurface
    : NSObject <WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate>

@property(nonatomic, copy, readonly) NSString *dataStoreIdentifier;
@property(nonatomic, readonly, getter=isDestroyed) BOOL destroyed;
@property(nonatomic, strong, readonly, nullable) WKWebView *webView;

- (nullable instancetype)
    initWithParentView:(NSView *)parentView
    dataStoreIdentifier:(NSString *)dataStoreIdentifier
           eventHandler:(RionSystemWebViewEventHandler)eventHandler;
- (void)clearWebsiteDataForRequest:(NSString *)requestID;
- (void)destroy;
- (void)evaluateJavaScript:(NSString *)source requestID:(NSString *)requestID;
- (void)focus;
- (void)getCookiesForRequest:(NSString *)requestID;
- (void)loadURL:(NSString *)url;
- (BOOL)setAudioMuted:(BOOL)muted;
- (void)setFrameFromTopLeftRect:(NSRect)rect;
- (void)setPageZoom:(CGFloat)zoom;
- (void)setCookiesFromJSON:(NSString *)cookiesJSON
                 requestID:(NSString *)requestID;
- (void)setVisible:(BOOL)visible;

@end

NS_ASSUME_NONNULL_END
