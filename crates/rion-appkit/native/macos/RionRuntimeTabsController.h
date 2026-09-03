#import <AppKit/AppKit.h>
#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^RionRuntimeTabsActionHandler)(NSDictionary<NSString *, id> *action);

typedef struct {
  CGFloat heightInset;
  CGFloat yOffset;
  BOOL valid;
} RionRuntimeContentLayout;

#define RION_APPKIT_VIEW_CLASS_NAME_CAPACITY 96

typedef struct {
  uintptr_t address;
  uintptr_t parentAddress;
  uint32_t depth;
  uint8_t hidden;
  uint8_t acceptsFirstResponder;
  uint8_t attachedToWindow;
  char className[RION_APPKIT_VIEW_CLASS_NAME_CAPACITY];
  double x;
  double y;
  double width;
  double height;
} RionAppKitNativeViewTreeNode;

typedef struct {
  uint8_t dispatched;
  uint8_t targetAttached;
  uint8_t keyWindowPreserved;
  uint8_t keyWindowFirstResponderPreserved;
  uint8_t targetFirstResponderPreserved;
} RionAppKitKeyDispatchProbeResult;

typedef struct {
  uint8_t dispatched;
  uint8_t targetAttached;
  uint8_t keyWindowPreserved;
  uint8_t keyWindowFirstResponderPreserved;
  uint8_t targetFirstResponderPreserved;
} RionAppKitMouseDispatchProbeResult;

typedef struct {
  uint8_t dispatchedEventCount;
  uint8_t targetAttached;
  uint8_t focusNeutral;
  uint8_t keyWindowPreserved;
  uint8_t keyWindowFirstResponderPreserved;
  uint8_t targetFirstResponderPreserved;
  uint16_t virtualKeyCode;
  uint64_t modifierFlags;
  double targetX;
  double targetY;
  double targetWidth;
  double targetHeight;
} RionAppKitChromiumKeyDispatchResult;

typedef struct {
  uint8_t dispatchedEventCount;
  uint8_t targetAttached;
  uint8_t focusNeutral;
  uint8_t keyWindowPreserved;
  uint8_t keyWindowFirstResponderPreserved;
  uint8_t targetFirstResponderPreserved;
  uint8_t button;
  uint64_t modifierFlags;
  double clientX;
  double clientY;
  double zoomFactor;
  double appKitPointX;
  double appKitPointY;
  double windowPointX;
  double windowPointY;
  uint8_t targetFlipped;
  double targetX;
  double targetY;
  double targetWidth;
  double targetHeight;
} RionAppKitChromiumMouseDispatchResult;

typedef void (^RionRuntimeContentLayoutHandler)(RionRuntimeContentLayout layout);

#if defined(RION_DESKTOP_E2E)
typedef struct {
  double rootMinX;
  double rootWidth;
  double tabMinX;
  double tabMinY;
  double tabMaxX;
  double tabMaxY;
  double windowNameMaxX;
  double trafficLightsMaxX;
  double fullscreenControlMinX;
  double fullscreenControlMinY;
  double fullscreenControlWidth;
  double fullscreenControlHeight;
  bool titleHidden;
  bool valid;
} RionRuntimeTabsDesktopE2ETitlebarGeometry;

typedef struct {
  double accessoryVisibleHeight;
  bool alwaysHideTabCloseButton;
  bool alwaysShowInFullScreen;
  bool accessoryOnScreen;
  bool fullscreen;
  bool fullscreenHostReady;
  bool presentationAutoHideToolbar;
  bool revealLocked;
  bool tabStripOnScreen;
  bool toolbarPinned;
  uint32_t tabCloseButtonEnabledCount;
  uint32_t visibleTrafficLightCount;
  bool valid;
} RionRuntimeTabsDesktopE2EFullscreenToolbarState;
#endif

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

@property(nonatomic, readonly) BOOL alwaysHideTabCloseButton;
@property(nonatomic, readonly) BOOL alwaysShowInFullScreen;
@property(nonatomic, readonly) NSUInteger renderedTabCount;
@property(nonatomic, readonly) BOOL revealLocked;
@property(nonatomic, copy, readonly, nullable) NSString *windowName;

- (nullable instancetype)initWithWindow:(NSWindow *)window
                       windowIdentifier:(NSString *)windowIdentifier
                           actionHandler:(RionRuntimeTabsActionHandler)actionHandler
                    contentLayoutHandler:
                        (RionRuntimeContentLayoutHandler)contentLayoutHandler;
- (RionRuntimeContentLayout)contentLayout;
- (void)destroy;
- (void)prepareForFullscreenTransition:(BOOL)fullScreen;
- (void)setAlwaysShowInFullScreen:(BOOL)alwaysShow;
- (void)setAlwaysHideTabCloseButton:(BOOL)alwaysHide;
- (void)setRevealLocked:(BOOL)locked;
- (void)setWindowName:(nullable NSString *)windowName;
- (void)setActiveTabIdentifier:(nullable NSString *)tabIdentifier;
- (BOOL)matchesTabIdentifiers:(NSArray<NSString *> *)tabIdentifiers
          activeTabIdentifier:(nullable NSString *)activeTabIdentifier;
- (BOOL)matchesTabPhases:(NSDictionary<NSString *, NSString *> *)phases;
- (BOOL)performAccessibilityPressForTabIdentifier:(NSString *)tabIdentifier;
- (BOOL)performAccessibilityCloseForTabIdentifier:(NSString *)tabIdentifier;
#if defined(RION_DESKTOP_E2E)
- (BOOL)performAccessibilityShowMenuForTabIdentifier:(NSString *)tabIdentifier;
- (BOOL)performDesktopE2EDragForTabIdentifier:(NSString *)tabIdentifier
                             targetController:(RionRuntimeTabsController *)targetController
                           beforeTabIdentifier:(NSString *)beforeTabIdentifier;
- (BOOL)desktopE2ETitlebarGeometry:
    (RionRuntimeTabsDesktopE2ETitlebarGeometry *)geometry;
- (BOOL)desktopE2EFullscreenToolbarState:
    (RionRuntimeTabsDesktopE2EFullscreenToolbarState *)state;
- (NSInteger)statusPresentation;
#endif
- (void)hideStatus;
- (void)ensureTabIdentifier:(NSString *)tabIdentifier
                       name:(NSString *)name
                      phase:(NSString *)phase
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
- (BOOL)applyWorkspaceDividerProjection:
    (NSDictionary<NSString *, id> *)projection;
- (BOOL)matchesWorkspaceDividerProjection:
    (NSDictionary<NSString *, id> *)projection;

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
    double tabWidth, double tabHeight, uint32_t modifierCount,
    bool cancelled, bool focused, bool minimized, bool visible);
typedef void (*RionRuntimeTabsCLayoutHandler)(
    void *context, double heightInset, double yOffset, bool valid);

#ifdef __cplusplus
extern "C" {
#endif

void * _Nullable rion_runtime_tabs_create(
    void *window, const char *windowIdentifier, void *context,
    RionRuntimeTabsCActionHandler actionHandler,
    RionRuntimeTabsCLayoutHandler layoutHandler);
uint32_t rion_appkit_runtime_tabs_abi_version(void);
// `nativeView` must be the live NSView pointer returned by Electron's
// getNativeWindowHandle(). The owning NSWindow is borrowed and may only be used
// on the AppKit main thread while the source view remains alive.
int32_t rion_appkit_resolve_electron_native_view_window(
    void * _Nullable nativeView, void * _Nullable * _Nullable nativeWindow);
int32_t rion_appkit_snapshot_native_view_tree(
    void * _Nullable nativeView,
    RionAppKitNativeViewTreeNode * _Nullable nodes,
    uintptr_t capacity, uintptr_t * _Nullable count, bool * _Nullable truncated);
int32_t rion_appkit_probe_dispatch_key(
    void * _Nullable nativeView, uintptr_t targetAddress, uint16_t keyCode,
    const char * _Nullable characters, uint64_t modifierFlags,
    uint8_t dispatchMode,
    RionAppKitKeyDispatchProbeResult * _Nullable result);
int32_t rion_appkit_probe_dispatch_mouse(
    void * _Nullable nativeView, uintptr_t targetAddress, double x, double y,
    uint8_t button, uint64_t modifierFlags,
    RionAppKitMouseDispatchProbeResult * _Nullable result);
int32_t rion_appkit_dispatch_chromium_key(
    void * _Nullable nativeView, uintptr_t webContentsRootAddress,
    const char * _Nullable code, bool keyDown, uint64_t modifierFlags,
    bool repeat, RionAppKitChromiumKeyDispatchResult * _Nullable result);
int32_t rion_appkit_dispatch_chromium_mouse(
    void * _Nullable nativeView, uintptr_t webContentsRootAddress,
    double clientX, double clientY, double zoomFactor, uint8_t button,
    uint64_t modifierFlags,
    RionAppKitChromiumMouseDispatchResult * _Nullable result);
void rion_runtime_tabs_destroy(void * _Nullable controller);
void rion_runtime_tabs_prepare_fullscreen(
    void * _Nullable controller, bool fullscreen);
bool rion_runtime_tabs_set_fullscreen_policy(
    void * _Nullable controller, bool alwaysShow);
bool rion_runtime_tabs_set_tab_close_buttons_hidden(
    void * _Nullable controller, bool alwaysHide);
bool rion_runtime_tabs_is_main_thread(void);
bool rion_runtime_tabs_set_window_interaction(
    void * _Nullable window, bool pointerPassthrough, bool focusWindow);
bool rion_runtime_tabs_set_reveal_locked(
    void * _Nullable controller, bool locked);
bool rion_runtime_tabs_set_window_name(
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
bool rion_runtime_tabs_desktop_e2e_titlebar_geometry(
    void * _Nullable controller,
    RionRuntimeTabsDesktopE2ETitlebarGeometry *geometry);
bool rion_runtime_tabs_desktop_e2e_fullscreen_toolbar_state(
    void * _Nullable controller,
    RionRuntimeTabsDesktopE2EFullscreenToolbarState *state);
#endif
void rion_runtime_tabs_hide_status(void * _Nullable controller);
bool rion_runtime_tabs_ensure(
    void * _Nullable controller, const char *tabIdentifier,
    const char *name, const char *phase, const char *type,
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
bool rion_runtime_tabs_matches_projection(
    void * _Nullable controller, const char *tabIdentifiersJSON,
    const char * _Nullable activeTabIdentifier);
bool rion_runtime_tabs_matches_phases(
    void * _Nullable controller, const char *tabPhasesJSON);
bool rion_runtime_tabs_apply_workspace_divider_projection(
    void * _Nullable controller, const char *projectionJSON);
bool rion_runtime_tabs_matches_workspace_divider_projection(
    void * _Nullable controller, const char *projectionJSON);
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
bool rion_runtime_tabs_accessibility_hierarchy_self_test(void);
bool rion_runtime_tabs_drag_hysteresis_self_test(void);
bool rion_runtime_tabs_fullscreen_toolbar_policy_self_test(void);
bool rion_runtime_tabs_macro_fallback_event_self_test(void);
bool rion_runtime_tabs_overflow_layout_self_test(void);
bool rion_runtime_tabs_shortcut_self_test(void);
bool rion_runtime_tabs_modifier_focus_self_test(void);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
