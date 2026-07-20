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

@property(nonatomic) NSInteger displayID;
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


NS_ASSUME_NONNULL_END
