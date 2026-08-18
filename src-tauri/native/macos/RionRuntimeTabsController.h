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
@property(nonatomic) BOOL automaticInputPaused;
@property(nonatomic) BOOL automaticInputRestartRequired;
@property(nonatomic, copy, nullable) NSString *iconDataURL;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSString *phase;
@property(nonatomic, copy) NSString *failureBody;
@property(nonatomic, copy) NSString *failureTitle;
@property(nonatomic, copy) NSString *loadingAccessibilityLabel;
@property(nonatomic, copy) NSString *retryLabel;
@property(nonatomic, copy, nullable) NSDictionary<NSString *, id> *statusIdentity;
@property(nonatomic, copy) NSString *tooltip;
@property(nonatomic, copy) NSString *type;
@property(nonatomic, copy, nullable) NSString *workspaceTemplate;

@end

@interface RionRuntimeTabsController : NSObject

@property(nonatomic, readonly) BOOL alwaysShowInFullScreen;
@property(nonatomic, readonly) NSUInteger renderedTabCount;
@property(nonatomic, readonly) BOOL revealLocked;

- (nullable instancetype)initWithWindow:(NSWindow *)window
                       windowIdentifier:(NSString *)windowIdentifier
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler
                    contentLayoutHandler:
                        (RionRuntimeContentLayoutHandler)contentLayoutHandler;
- (RionRuntimeContentLayout)contentLayout;
- (void)destroy;
- (void)prepareForFullscreenTransition:(BOOL)fullScreen;
- (void)setAlwaysShowInFullScreen:(BOOL)alwaysShow;
- (void)setRevealLocked:(BOOL)locked;
- (void)setWindowName:(nullable NSString *)windowName;
- (void)setActiveTabIdentifier:(nullable NSString *)tabIdentifier;
- (BOOL)performAccessibilityPressForTabIdentifier:(NSString *)tabIdentifier;
- (BOOL)performAccessibilityCloseForTabIdentifier:(NSString *)tabIdentifier;
#if defined(RION_DESKTOP_E2E)
- (BOOL)performAccessibilityShowMenuForTabIdentifier:(NSString *)tabIdentifier;
- (BOOL)performDesktopE2EDragForTabIdentifier:(NSString *)tabIdentifier
                             targetController:(RionRuntimeTabsController *)targetController
                           beforeTabIdentifier:(NSString *)beforeTabIdentifier;
- (NSInteger)statusPresentation;
#endif
- (void)hideStatus;
- (void)ensureTabIdentifier:(NSString *)tabIdentifier
                       name:(NSString *)name
                       type:(NSString *)type
          workspaceTemplate:(nullable NSString *)workspaceTemplate
           windowIdentifier:(NSString *)windowIdentifier;
- (void)reserveTabIdentifier:(NSString *)tabIdentifier
                        name:(NSString *)name
                        type:(NSString *)type
           workspaceTemplate:(nullable NSString *)workspaceTemplate
            windowIdentifier:(NSString *)windowIdentifier;
- (void)removeTabIdentifier:(NSString *)tabIdentifier
         activeTabIdentifier:(nullable NSString *)activeTabIdentifier;
- (void)reorderTabIdentifiers:(NSArray<NSString *> *)tabIdentifiers;
- (void)updateTabMetadata:(RionRuntimeTabModel *)tab
       hideTabCloseButton:(BOOL)hideTabCloseButton
                 addLabel:(NSString *)addLabel
               closeLabel:(NSString *)closeLabel
        audioPlayingLabel:(NSString *)audioPlayingLabel
           audioMutedLabel:(NSString *)audioMutedLabel
          scrollLeftLabel:(NSString *)scrollLeftLabel
         scrollRightLabel:(NSString *)scrollRightLabel;

@end

typedef struct {
  bool active;
  bool audible;
  bool audioMuted;
  bool automaticInputPaused;
  bool automaticInputRestartRequired;
  const char *identifier;
  const char *name;
  const char *phase;
  const char *failureBody;
  const char *failureTitle;
  const char *loadingAccessibilityLabel;
  const char *retryLabel;
  const char * _Nullable statusIdentityJSON;
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
    const char * _Nullable beforeTabIdentifier,
    const char * _Nullable orderedTabIdentifiersJSON,
    const char * _Nullable statusIdentityJSON, double screenX,
    double screenY, double grabRatioX, double grabRatioY,
    double tabWidth, double tabHeight, bool cancelled);
typedef void (*RionRuntimeTabsCLayoutHandler)(
    void *context, double heightInset, double yOffset, bool valid);

#ifdef __cplusplus
extern "C" {
#endif

void * _Nullable rion_runtime_tabs_create(
    void *window, const char *windowIdentifier, void *context,
    RionRuntimeTabsCActionHandler actionHandler,
    RionRuntimeTabsCLayoutHandler layoutHandler);
bool rion_runtime_tabs_install_safe_tao_event_dispatch(void);
void rion_runtime_tabs_destroy(void * _Nullable controller);
void rion_runtime_tabs_prepare_fullscreen(
    void * _Nullable controller, bool fullscreen);
void rion_runtime_tabs_set_fullscreen_policy(
    void * _Nullable controller, bool alwaysShow);
bool rion_runtime_tabs_is_main_thread(void);
bool rion_runtime_tabs_set_window_interaction(
    void * _Nullable window, bool pointerPassthrough, bool focusWindow);
void rion_runtime_tabs_set_reveal_locked(
    void * _Nullable controller, bool locked);
void rion_runtime_tabs_set_window_name(
    void * _Nullable controller, const char * _Nullable windowName);
void rion_runtime_tabs_set_active(
    void * _Nullable controller, const char * _Nullable tabIdentifier);
bool rion_runtime_tabs_accessibility_press(
    void * _Nullable controller, const char *tabIdentifier);
bool rion_runtime_tabs_accessibility_close(
    void * _Nullable controller, const char *tabIdentifier);
#if defined(RION_DESKTOP_E2E)
bool rion_runtime_tabs_accessibility_show_menu(
    void * _Nullable controller, const char *tabIdentifier);
bool rion_runtime_tabs_desktop_e2e_drag(
    void * _Nullable sourceController, const char *tabIdentifier,
    void * _Nullable targetController, const char *beforeTabIdentifier);
bool rion_runtime_tabs_desktop_e2e_select_menu_item(
    int action, unsigned long targetRank);
int rion_runtime_tabs_desktop_e2e_status_presentation(
    void * _Nullable controller);
#endif
void rion_runtime_tabs_hide_status(void * _Nullable controller);
void rion_runtime_tabs_ensure(
    void * _Nullable controller, const char *tabIdentifier,
    const char *name, const char *type,
    const char * _Nullable workspaceTemplate, const char *windowIdentifier);
void rion_runtime_tabs_reserve(
    void * _Nullable controller, const char *tabIdentifier,
    const char *name, const char *type,
    const char * _Nullable workspaceTemplate, const char *windowIdentifier);
void rion_runtime_tabs_remove(
    void * _Nullable controller, const char *tabIdentifier,
    const char * _Nullable activeTabIdentifier);
void rion_runtime_tabs_reorder(
    void * _Nullable controller, const char *tabIdentifiersJSON);
void rion_runtime_tabs_update_metadata(
    void * _Nullable controller, const RionRuntimeTabInput *tab,
    bool alwaysHideTabCloseButton, const char *audioMutedLabel,
    const char *audioPlayingLabel, const char *closeLabel,
    const char *addLabel, const char *scrollLeftLabel,
    const char *scrollRightLabel);
RionRuntimeContentLayout rion_runtime_tabs_content_layout(
    void * _Nullable controller);
bool rion_runtime_tabs_control_row_contains(
    void * _Nullable controller, double screenX, double screenY);
bool rion_runtime_tabs_drag_anchor(
    void * _Nullable controller, const char *tabIdentifier,
    double grabRatioX, double grabRatioY, double *windowOffsetX,
    double *windowOffsetY);
bool rion_runtime_tabs_action_scope_self_test(void);
bool rion_runtime_tabs_drag_hysteresis_self_test(void);
bool rion_runtime_tabs_overflow_layout_self_test(void);
bool rion_runtime_tabs_shortcut_self_test(void);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
