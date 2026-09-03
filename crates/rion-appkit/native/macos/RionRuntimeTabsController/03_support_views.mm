NS_ASSUME_NONNULL_BEGIN

@implementation RionRuntimeTabModel
@end

@implementation RionRuntimeDraggableView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeWindowNameField

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeStatusBackdropView

- (BOOL)wantsUpdateLayer {
  return YES;
}

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  }
  return self;
}

- (void)updateLayer {
  self.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
}

- (void)viewDidChangeEffectiveAppearance {
  [super viewDidChangeEffectiveAppearance];
  self.needsDisplay = YES;
}

@end

@implementation RionRuntimeBackdropView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeVerticallyCenteredTextFieldCell

- (NSRect)titleRectForBounds:(NSRect)bounds {
  NSRect titleRect = [super titleRectForBounds:bounds];
  NSFont *font = self.font;
  if (!font || NSHeight(bounds) <= 0) return titleRect;

  CGFloat metricHeight = ceil(font.ascender - font.descender + font.leading);
  CGFloat titleHeight = MIN(NSHeight(bounds), MAX(0, metricHeight));
  titleRect.origin.y =
      NSMinY(bounds) + (NSHeight(bounds) - titleHeight) / 2.0;
  titleRect.size.height = titleHeight;
  return titleRect;
}

- (void)drawInteriorWithFrame:(NSRect)cellFrame
                       inView:(NSView *)controlView {
  [super drawInteriorWithFrame:[self titleRectForBounds:cellFrame]
                        inView:controlView];
}

@end

@implementation RionRuntimeHorizontalScrollView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    // macOS 14 and later no longer clip subviews by default. Keep tab surfaces
    // inside the scrolling viewport; the viewport intentionally includes the
    // arrow fusion zones, while its outer container owns the final hard edge.
    self.contentView.clipsToBounds = YES;
  }
  return self;
}

- (void)scrollWheel:(NSEvent *)event {
  if (std::fabs(event.scrollingDeltaX) >= std::fabs(event.scrollingDeltaY)) {
    [super scrollWheel:event];
    return;
  }
  NSClipView *clipView = self.contentView;
  CGFloat scale = event.hasPreciseScrollingDeltas ? 1.0 : 14.0;
  CGFloat maximumOrigin =
      MAX(0, self.documentView.frame.size.width - clipView.bounds.size.width);
  CGFloat originX = MIN(
      maximumOrigin,
      MAX(0, clipView.bounds.origin.x - event.scrollingDeltaY * scale));
  [clipView scrollToPoint:NSMakePoint(originX, clipView.bounds.origin.y)];
  [self reflectScrolledClipView:clipView];
}

@end

@implementation RionRuntimeTabGroupView

@synthesize tabAccessibilityChildren = _tabAccessibilityChildren;

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    self.accessibilityElement = YES;
    self.accessibilityRole = NSAccessibilityTabGroupRole;
    self.accessibilityIdentifier = @"com.rionstudio.runtime.appkit-tab-group.v1";
    _tabAccessibilityChildren = @[];
  }
  return self;
}

- (void)setTabAccessibilityChildren:
    (NSArray<RionRuntimeTabItemView *> *)tabAccessibilityChildren {
  NSArray<RionRuntimeTabItemView *> *children =
      [tabAccessibilityChildren copy] ?: @[];
  if ([_tabAccessibilityChildren isEqualToArray:children]) return;

  for (RionRuntimeTabItemView *item in _tabAccessibilityChildren) {
    if (![children containsObject:item]) item.tabAccessibilityParent = nil;
  }
  _tabAccessibilityChildren = children;
  for (RionRuntimeTabItemView *item in _tabAccessibilityChildren) {
    item.tabAccessibilityParent = self;
  }
  NSAccessibilityPostNotification(
      self, NSAccessibilityLayoutChangedNotification);
}

- (nullable NSArray<RionRuntimeTabItemView *> *)accessibilityChildren {
  return (NSArray<RionRuntimeTabItemView *> *)
      NSAccessibilityUnignoredChildren(_tabAccessibilityChildren);
}

- (nullable NSArray<RionRuntimeTabItemView *> *)accessibilityChildrenInNavigationOrder {
  return self.accessibilityChildren;
}

- (NSRect)accessibilityFrame {
  return [super accessibilityFrame];
}

- (nullable id)accessibilityParent {
  id parent = self.titlebarAccessibilityParent ?: [super accessibilityParent];
  return parent ? NSAccessibilityUnignoredAncestor(parent) : nil;
}

- (nullable NSArray<RionRuntimeTabItemView *> *)accessibilityTabs {
  return self.accessibilityChildren;
}

- (nullable NSArray<RionRuntimeTabItemView *> *)accessibilityVisibleChildren {
  return self.accessibilityChildren;
}

@end

@interface RionRuntimeAccessibilityTabItemProbe
    : NSView <NSAccessibilityRadioButton>

@property(nonatomic, weak, nullable)
    RionRuntimeTabGroupView *tabAccessibilityParent;

@end

@implementation RionRuntimeAccessibilityTabItemProbe

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    self.accessibilityElement = YES;
    self.accessibilityRole = NSAccessibilityRadioButtonRole;
  }
  return self;
}

- (nullable id)accessibilityParent {
  return self.tabAccessibilityParent ?: [super accessibilityParent];
}

- (NSRect)accessibilityFrame {
  return [super accessibilityFrame];
}

- (nullable NSString *)accessibilityLabel {
  return @"Rion accessibility hierarchy probe";
}

- (BOOL)accessibilityPerformPress {
  return YES;
}

- (nullable NSNumber *)accessibilityValue {
  return @NO;
}

@end

bool rion_runtime_tabs_accessibility_hierarchy_self_test(void) {
  @autoreleasepool {
    RionRuntimeTabsRootView *root =
        [[RionRuntimeTabsRootView alloc] initWithFrame:NSMakeRect(0, 0, 640, 40)];
    NSView *glassWrapper = [[NSView alloc] initWithFrame:root.bounds];
    RionRuntimeTabGroupView *tabGroup =
        [[RionRuntimeTabGroupView alloc] initWithFrame:root.bounds];
    NSView *firstSurface = [[NSView alloc] initWithFrame:NSZeroRect];
    NSView *secondSurface = [[NSView alloc] initWithFrame:NSZeroRect];
    RionRuntimeAccessibilityTabItemProbe *first =
        [[RionRuntimeAccessibilityTabItemProbe alloc] initWithFrame:NSZeroRect];
    RionRuntimeAccessibilityTabItemProbe *second =
        [[RionRuntimeAccessibilityTabItemProbe alloc] initWithFrame:NSZeroRect];
    RionRuntimeWorkspaceDividerView *divider =
        [[RionRuntimeWorkspaceDividerView alloc]
            initWithProjectionKey:@"divider-probe"
                         windowID:@"window-probe"
                     actionHandler:^(NSDictionary<NSString *, id> *action) {
                       (void)action;
                     }];
    [divider applyProjection:@{
      @"attemptGeneration" : @"attempt-probe",
      @"axis" : @"vertical",
      @"dividerIndex" : @0,
      @"tabId" : @"tab-probe",
      @"visible" : @YES
    } localFrame:NSMakeRect(320, 40, 4, 600)];
    [root addSubview:glassWrapper];
    [glassWrapper addSubview:tabGroup];
    [tabGroup addSubview:firstSurface];
    [tabGroup addSubview:secondSurface];
    [firstSurface addSubview:first];
    [secondSurface addSubview:second];
    root.tabAccessibilityGroup = tabGroup;
    tabGroup.titlebarAccessibilityParent = root;
    tabGroup.tabAccessibilityChildren =
        (NSArray<RionRuntimeTabItemView *> *)(NSArray *)@[ first, second ];
    divider.workspaceDividerAccessibilityParent = root;
    root.workspaceDividerAccessibilityChildren = @[ divider ];

    NSArray *rootChildren = root.accessibilityChildren;
    NSArray *initialChildren = tabGroup.accessibilityChildren;
    BOOL initialHierarchy = root.isAccessibilityElement &&
        [root conformsToProtocol:@protocol(NSAccessibilityGroup)] &&
        [root.accessibilityRole isEqualToString:NSAccessibilityGroupRole] &&
        [root.accessibilityIdentifier
            isEqualToString:@"com.rionstudio.runtime.appkit-root.v1"] &&
        [rootChildren containsObject:tabGroup] &&
        [rootChildren containsObject:divider] &&
        tabGroup.isAccessibilityElement &&
        [tabGroup conformsToProtocol:@protocol(NSAccessibilityGroup)] &&
        [tabGroup.accessibilityRole
            isEqualToString:NSAccessibilityTabGroupRole] &&
        [tabGroup.accessibilityIdentifier
            isEqualToString:@"com.rionstudio.runtime.appkit-tab-group.v1"] &&
        initialChildren.count == 2 && initialChildren[0] == first &&
        initialChildren[1] == second &&
        first.accessibilityParent == tabGroup &&
        second.accessibilityParent == tabGroup &&
        [first conformsToProtocol:@protocol(NSAccessibilityRadioButton)] &&
        [second conformsToProtocol:@protocol(NSAccessibilityRadioButton)] &&
        [first.accessibilityRole
            isEqualToString:NSAccessibilityRadioButtonRole] &&
        [second.accessibilityRole
            isEqualToString:NSAccessibilityRadioButtonRole] &&
        divider.isAccessibilityElement &&
        [divider.accessibilityRole
            isEqualToString:NSAccessibilitySplitterRole] &&
        [divider.accessibilityLabel
            isEqualToString:@"Resize workspace columns"] &&
        divider.accessibilityParent == root;

    tabGroup.tabAccessibilityChildren =
        (NSArray<RionRuntimeTabItemView *> *)(NSArray *)@[ second, first ];
    NSArray *reorderedChildren = tabGroup.accessibilityChildren;
    BOOL reordered = reorderedChildren.count == 2 &&
        reorderedChildren[0] == second && reorderedChildren[1] == first;
    tabGroup.tabAccessibilityChildren =
        (NSArray<RionRuntimeTabItemView *> *)(NSArray *)@[ second ];
    NSArray *removedChildren = tabGroup.accessibilityChildren;
    BOOL removed = removedChildren.count == 1 &&
        removedChildren[0] == second &&
        first.tabAccessibilityParent == nil &&
        second.accessibilityParent == tabGroup;
    return initialHierarchy && reordered && removed;
  }
}

NS_ASSUME_NONNULL_END
