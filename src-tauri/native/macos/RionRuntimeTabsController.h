#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^RionRuntimeTabsActionHandler)(NSDictionary<NSString *, id> *action);

typedef struct {
  CGFloat heightInset;
  CGFloat yOffset;
  BOOL valid;
} RionRuntimeContentLayout;

typedef void (^RionRuntimeContentLayoutHandler)(RionRuntimeContentLayout layout);

RionRuntimeContentLayout RionRuntimeContentLayoutForRects(
    NSRect contentBounds, NSRect contentLayoutRect, BOOL contentViewFlipped);

@interface RionRuntimeTabModel : NSObject

@property(nonatomic) BOOL active;
@property(nonatomic) BOOL audible;
@property(nonatomic) BOOL audioMuted;
@property(nonatomic, copy, nullable) NSString *iconDataURL;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSString *tooltip;
@property(nonatomic, copy) NSString *type;
@property(nonatomic, copy, nullable) NSString *workspaceTemplate;

@end

@interface RionRuntimeTabsState : NSObject

@property(nonatomic, copy) NSString *windowID;
@property(nonatomic, copy) NSString *addLabel;
@property(nonatomic, copy) NSString *audioMutedLabel;
@property(nonatomic, copy) NSString *audioPlayingLabel;
@property(nonatomic, copy) NSString *closeLabel;
@property(nonatomic, copy) NSArray<RionRuntimeTabModel *> *tabs;

@end

@interface RionRuntimeTabsController : NSObject

@property(nonatomic, readonly) BOOL alwaysShowInFullScreen;
@property(nonatomic, readonly) NSUInteger renderedTabCount;
@property(nonatomic, readonly) BOOL revealLocked;

- (nullable instancetype)initWithWindow:(NSWindow *)window
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler
                    contentLayoutHandler:
                        (RionRuntimeContentLayoutHandler)contentLayoutHandler;
- (RionRuntimeContentLayout)contentLayout;
- (void)destroy;
- (void)prepareForFullscreenTransition:(BOOL)fullScreen;
- (void)setAlwaysShowInFullScreen:(BOOL)alwaysShow;
- (void)setRevealLocked:(BOOL)locked;
- (void)updateState:(RionRuntimeTabsState *)state;

@end

typedef struct {
  bool active;
  bool audible;
  bool audioMuted;
  const char *identifier;
  const char *name;
  const char *tooltip;
  const char *type;
  const char * _Nullable iconDataURL;
  const char * _Nullable workspaceTemplate;
} RionRuntimeTabInput;

typedef void (*RionRuntimeTabsCActionHandler)(
    void *context, const char *type, const char * _Nullable sessionIdentifier,
    const char * _Nullable tabIdentifier,
    const char * _Nullable sourceWindowID,
    const char * _Nullable targetWindowID,
    const char * _Nullable beforeTabIdentifier, double screenX,
    double screenY, bool cancelled);
typedef void (*RionRuntimeTabsCLayoutHandler)(
    void *context, double heightInset, double yOffset, bool valid);

#ifdef __cplusplus
extern "C" {
#endif

void * _Nullable rion_runtime_tabs_create(
    void *window, void *context, RionRuntimeTabsCActionHandler actionHandler,
    RionRuntimeTabsCLayoutHandler layoutHandler);
void rion_runtime_tabs_destroy(void * _Nullable controller);
void rion_runtime_tabs_update(
    void * _Nullable controller, const char *windowID,
    const RionRuntimeTabInput *tabs, size_t tabCount,
    const char *addLabel, const char *audioMutedLabel,
    const char *audioPlayingLabel, const char *closeLabel);
void rion_runtime_tabs_prepare_fullscreen(
    void * _Nullable controller, bool fullscreen);
void rion_runtime_tabs_set_fullscreen_policy(
    void * _Nullable controller, bool alwaysShow);
void rion_runtime_tabs_set_reveal_locked(
    void * _Nullable controller, bool locked);
RionRuntimeContentLayout rion_runtime_tabs_content_layout(
    void * _Nullable controller);
bool rion_runtime_tabs_action_scope_self_test(void);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
