NS_ASSUME_NONNULL_BEGIN

typedef void (^RionRuntimeWorkspaceDividerActionHandler)(
    NSDictionary<NSString *, id> *action);

@interface RionRuntimeWorkspaceDividerOverlayView
    : NSView <NSAccessibilityGroup>
@end

@interface RionRuntimeWorkspaceDividerView : NSView

@property(nonatomic, copy, readonly) NSString *projectionKey;
@property(nonatomic, weak, nullable)
    NSView *workspaceDividerAccessibilityParent;

- (instancetype)initWithProjectionKey:(NSString *)projectionKey
                         windowID:(NSString *)windowID
                     actionHandler:
                         (RionRuntimeWorkspaceDividerActionHandler)actionHandler;
- (void)applyProjection:(NSDictionary<NSString *, id> *)projection
             localFrame:(NSRect)localFrame;
- (void)cancelActiveGesture;

@end

@implementation RionRuntimeWorkspaceDividerOverlayView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    self.accessibilityElement = YES;
    self.accessibilityRole = NSAccessibilityGroupRole;
    self.accessibilityLabel = @"Workspace layout controls";
  }
  return self;
}

- (nullable NSArray *)accessibilityChildren {
  return NSAccessibilityUnignoredChildren(
      [super accessibilityChildren] ?: @[]);
}

- (nullable NSArray *)accessibilityChildrenInNavigationOrder {
  return self.accessibilityChildren;
}

- (nullable NSArray *)accessibilityVisibleChildren {
  return self.accessibilityChildren;
}

- (BOOL)isFlipped {
  return YES;
}

- (nullable NSView *)hitTest:(NSPoint)point {
  if (self.hidden || !NSPointInRect(point, self.bounds)) return nil;
  // The full-size overlay is presentation-only. Only exact Core-projected
  // native divider hit rects may consume pointer input; every other point
  // falls through to the retained Chromium content surfaces below it.
  for (NSView *subview in self.subviews.reverseObjectEnumerator) {
    if (!subview.hidden && NSPointInRect(point, subview.frame)) {
      NSPoint local = [subview convertPoint:point fromView:self];
      return [subview hitTest:local];
    }
  }
  return nil;
}

@end

@implementation RionRuntimeWorkspaceDividerView {
  NSString *_projectionKey;
  NSString *_windowID;
  NSString *_tabID;
  NSString *_attemptGeneration;
  NSString *_axis;
  NSUInteger _dividerIndex;
  NSString *_gestureID;
  NSUInteger _pointerSequence;
  BOOL _gestureActive;
  RionRuntimeWorkspaceDividerActionHandler _actionHandler;
  NSTrackingArea *_trackingArea;
}

- (instancetype)initWithProjectionKey:(NSString *)projectionKey
                              windowID:(NSString *)windowID
                          actionHandler:
                              (RionRuntimeWorkspaceDividerActionHandler)actionHandler {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  _projectionKey = [projectionKey copy];
  _windowID = [windowID copy];
  _actionHandler = [actionHandler copy];
  self.wantsLayer = YES;
  self.layer.backgroundColor = NSColor.clearColor.CGColor;
  self.accessibilityElement = YES;
  self.accessibilityRole = NSAccessibilitySplitterRole;
  return self;
}

- (NSString *)projectionKey {
  return _projectionKey;
}

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)acceptsFirstResponder {
  return NO;
}

- (BOOL)isAccessibilityElement {
  return YES;
}

- (nullable NSAccessibilityRole)accessibilityRole {
  return NSAccessibilitySplitterRole;
}

- (nullable NSString *)accessibilityLabel {
  return [_axis isEqualToString:@"vertical"]
      ? @"Resize workspace columns"
      : @"Resize workspace rows";
}

- (nullable id)accessibilityParent {
  return self.workspaceDividerAccessibilityParent ?: [super accessibilityParent];
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  if ([_axis isEqualToString:@"vertical"]) {
    [NSCursor.resizeLeftRightCursor push];
  } else {
    [NSCursor.resizeUpDownCursor push];
  }
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  [NSCursor pop];
}

- (void)applyProjection:(NSDictionary<NSString *, id> *)projection
             localFrame:(NSRect)localFrame {
  _tabID = [projection[@"tabId"] copy];
  _attemptGeneration = [projection[@"attemptGeneration"] copy];
  _axis = [projection[@"axis"] copy];
  _dividerIndex = [projection[@"dividerIndex"] unsignedIntegerValue];
  self.frame = localFrame;
  self.hidden = ![projection[@"visible"] boolValue];
  self.accessibilityValue = @(_dividerIndex);
}

- (void)emitPhase:(NSString *)phase
 requestedPosition:(nullable NSNumber *)requestedPosition {
  if (!_actionHandler || !_gestureID || !_tabID || !_attemptGeneration) return;
  _pointerSequence += 1;
  NSMutableDictionary<NSString *, id> *statusIdentity =
      [@{ @"phase" : phase,
          @"pointerSequence" : @(_pointerSequence),
          @"attemptGeneration" : _attemptGeneration,
          @"dividerIndex" : @(_dividerIndex),
          @"axis" : _axis } mutableCopy];
  if (requestedPosition) {
    statusIdentity[@"requestedPosition"] = requestedPosition;
  }
  _actionHandler(@{
    @"type" : @"workspaceDividerPointer",
    @"sessionId" : _gestureID,
    @"tabId" : _tabID,
    @"sourceWindowId" : _windowID,
    @"statusIdentity" : statusIdentity
  });
}

- (void)mouseDown:(NSEvent *)event {
  (void)event;
  if (self.hidden || _gestureActive) return;
  _gestureID = NSUUID.UUID.UUIDString.lowercaseString;
  _pointerSequence = 0;
  _gestureActive = YES;
  [self emitPhase:@"start" requestedPosition:nil];
}

- (void)mouseDragged:(NSEvent *)event {
  if (!_gestureActive || !self.superview) return;
  NSPoint point = [self.superview convertPoint:event.locationInWindow fromView:nil];
  NSRect bounds = self.superview.bounds;
  CGFloat extent = [_axis isEqualToString:@"vertical"]
      ? NSWidth(bounds)
      : NSHeight(bounds);
  CGFloat coordinate = [_axis isEqualToString:@"vertical"]
      ? point.x - NSMinX(bounds)
      : point.y - NSMinY(bounds);
  if (!std::isfinite(extent) || extent <= 0 || !std::isfinite(coordinate)) {
    [self cancelActiveGesture];
    return;
  }
  double requested = MIN(1.0, MAX(0.0, coordinate / extent));
  [self emitPhase:@"move" requestedPosition:@(requested)];
}

- (void)mouseUp:(NSEvent *)event {
  (void)event;
  if (!_gestureActive) return;
  [self emitPhase:@"end" requestedPosition:nil];
  _gestureActive = NO;
  _gestureID = nil;
}

- (void)cancelOperation:(nullable id)sender {
  (void)sender;
  [self cancelActiveGesture];
}

- (void)cancelActiveGesture {
  if (!_gestureActive) return;
  [self emitPhase:@"cancel" requestedPosition:nil];
  _gestureActive = NO;
  _gestureID = nil;
}

- (void)viewWillMoveToWindow:(nullable NSWindow *)newWindow {
  if (!newWindow && self.window) [self cancelActiveGesture];
  [super viewWillMoveToWindow:newWindow];
}

@end

static NSString *RionRuntimeWorkspaceDividerProjectionKey(
    NSDictionary<NSString *, id> *divider) {
  NSString *tabID = divider[@"tabId"];
  NSString *attempt = divider[@"attemptGeneration"];
  NSNumber *index = divider[@"dividerIndex"];
  return [NSString stringWithFormat:@"%lu:%@%lu:%@:%u",
                                    (unsigned long)tabID.length, tabID,
                                    (unsigned long)attempt.length, attempt,
                                    index.unsignedIntValue];
}

static BOOL RionRuntimeWorkspaceDividerExactKeys(
    NSDictionary<NSString *, id> *value, NSArray<NSString *> *keys) {
  return value.count == keys.count &&
      [[NSSet setWithArray:value.allKeys]
          isEqualToSet:[NSSet setWithArray:keys]];
}

static BOOL RionRuntimeWorkspaceDividerIdentifier(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *trimmed = [value
      stringByTrimmingCharactersInSet:
          NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (value.length == 0 || value.length > 256 ||
      ![value isEqualToString:trimmed] ||
      [value containsString:@"/"] || [value containsString:@"\\"]) {
    return NO;
  }
  return [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location ==
      NSNotFound;
}

static BOOL RionRuntimeWorkspaceDividerInteger(NSNumber *value,
                                                long long minimum,
                                                long long maximum,
                                                long long *output) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  double raw = value.doubleValue;
  long long integer = value.longLongValue;
  if (!std::isfinite(raw) || raw != (double)integer || integer < minimum ||
      integer > maximum) {
    return NO;
  }
  if (output) *output = integer;
  return YES;
}

static NSDictionary<NSString *, NSNumber *> * _Nullable
RionRuntimeWorkspaceDividerBounds(id rawBounds, BOOL positiveSize) {
  if (![rawBounds isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary<NSString *, id> *bounds = rawBounds;
  if (!RionRuntimeWorkspaceDividerExactKeys(
          bounds, @[ @"x", @"y", @"width", @"height" ])) {
    return nil;
  }
  long long x = 0;
  long long y = 0;
  long long width = 0;
  long long height = 0;
  constexpr long long kMaximumCoordinate = 10'000'000;
  if (!RionRuntimeWorkspaceDividerInteger(bounds[@"x"], 0,
                                           kMaximumCoordinate, &x) ||
      !RionRuntimeWorkspaceDividerInteger(bounds[@"y"], 0,
                                           kMaximumCoordinate, &y) ||
      !RionRuntimeWorkspaceDividerInteger(bounds[@"width"],
                                           positiveSize ? 1 : 0,
                                           kMaximumCoordinate, &width) ||
      !RionRuntimeWorkspaceDividerInteger(bounds[@"height"],
                                           positiveSize ? 1 : 0,
                                           kMaximumCoordinate, &height) ||
      x + width > kMaximumCoordinate || y + height > kMaximumCoordinate) {
    return nil;
  }
  return @{ @"x" : @(x), @"y" : @(y), @"width" : @(width),
            @"height" : @(height) };
}

static NSDictionary<NSString *, id> * _Nullable
RionRuntimeValidatedWorkspaceDividerProjection(id rawProjection) {
  if (![rawProjection isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary<NSString *, id> *projection = rawProjection;
  if (!RionRuntimeWorkspaceDividerExactKeys(
          projection, @[ @"contentBounds", @"dividers" ])) {
    return nil;
  }
  NSDictionary<NSString *, NSNumber *> *contentBounds =
      RionRuntimeWorkspaceDividerBounds(projection[@"contentBounds"], YES);
  NSArray *rawDividers = projection[@"dividers"];
  if (!contentBounds || ![rawDividers isKindOfClass:NSArray.class] ||
      rawDividers.count > 128) {
    return nil;
  }
  const long long contentMinX = contentBounds[@"x"].longLongValue;
  const long long contentMinY = contentBounds[@"y"].longLongValue;
  const long long contentMaxX =
      contentMinX + contentBounds[@"width"].longLongValue;
  const long long contentMaxY =
      contentMinY + contentBounds[@"height"].longLongValue;
  NSMutableArray<NSDictionary<NSString *, id> *> *dividers =
      [NSMutableArray arrayWithCapacity:rawDividers.count];
  NSMutableSet<NSString *> *keys = [NSMutableSet set];
  for (id rawDivider in rawDividers) {
    if (![rawDivider isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary<NSString *, id> *divider = rawDivider;
    if (!RionRuntimeWorkspaceDividerExactKeys(
            divider, @[ @"tabId", @"attemptGeneration", @"dividerIndex",
                        @"axis", @"bounds", @"visible" ])) {
      return nil;
    }
    NSString *tabID = divider[@"tabId"];
    NSString *attempt = divider[@"attemptGeneration"];
    NSString *axis = divider[@"axis"];
    NSNumber *visible = divider[@"visible"];
    long long index = 0;
    NSDictionary<NSString *, NSNumber *> *bounds =
        RionRuntimeWorkspaceDividerBounds(divider[@"bounds"], YES);
    if (!RionRuntimeWorkspaceDividerIdentifier(tabID) ||
        !RionRuntimeWorkspaceDividerIdentifier(attempt) ||
        ![axis isKindOfClass:NSString.class] ||
        ![@[ @"horizontal", @"vertical" ] containsObject:axis] ||
        !RionRuntimeWorkspaceDividerInteger(divider[@"dividerIndex"], 0,
                                             UINT32_MAX, &index) ||
        ![visible isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)visible) != CFBooleanGetTypeID() ||
        !bounds) {
      return nil;
    }
    long long minX = bounds[@"x"].longLongValue;
    long long minY = bounds[@"y"].longLongValue;
    long long maxX = minX + bounds[@"width"].longLongValue;
    long long maxY = minY + bounds[@"height"].longLongValue;
    if (minX < contentMinX || minY < contentMinY || maxX > contentMaxX ||
        maxY > contentMaxY) {
      return nil;
    }
    NSDictionary<NSString *, id> *canonical = @{
      @"tabId" : tabID,
      @"attemptGeneration" : attempt,
      @"dividerIndex" : @(index),
      @"axis" : axis,
      @"bounds" : bounds,
      @"visible" : @(visible.boolValue)
    };
    NSString *key = RionRuntimeWorkspaceDividerProjectionKey(canonical);
    if ([keys containsObject:key]) return nil;
    [keys addObject:key];
    [dividers addObject:canonical];
  }
  return @{ @"contentBounds" : contentBounds,
            @"dividers" : [dividers copy] };
}

NS_ASSUME_NONNULL_END
