// The native menu-bar animation is authoritative. The retained accessory's
// toolbar fraction follows that animation, or stays one while pinned. Nothing
// here sets the menu-bar fraction or interprets a physical pointer threshold.
static void RionSetFullscreenToolbarReveal(NSWindow *window, double reveal);
static char RionFullscreenRevealObservationKey;
static char RionFullscreenRevealPropertyContext;

@interface RionRuntimeFullscreenRevealObservation : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, weak) NSObject *companion;
@property(nonatomic) BOOL active;
@property(nonatomic) BOOL pinned;
@property(nonatomic) BOOL delivering;
@property(nonatomic) double menuBarReveal;
@property(nonatomic) double toolbarReveal;
@property(nonatomic) uint32_t sequence;
@property(nonatomic, copy) void (^handler)(void);
@property(nonatomic, strong) NSMutableArray<NSString *> *observedKeys;
- (BOOL)start;
- (void)stop;
- (void)reconcile;
@end

@implementation RionRuntimeFullscreenRevealObservation
- (BOOL)start {
  self.observedKeys = [NSMutableArray array];
  @try {
    for (NSString *key in @[@"menuBarReveal", @"toolbarWindowReveal"]) {
      NSMethodSignature *signature =
          [self.companion methodSignatureForSelector:NSSelectorFromString(key)];
      if (!signature || signature.numberOfArguments != 2 ||
          strcmp(signature.methodReturnType, @encode(double)) != 0) {
        [self stop];
        return NO;
      }
      [self.companion addObserver:self forKeyPath:key
                         options:NSKeyValueObservingOptionNew
                         context:&RionFullscreenRevealPropertyContext];
      [self.observedKeys addObject:key];
    }
  } @catch (NSException *exception) {
    [self stop];
    NSLog(@"Rion Studio could not observe native toolbar reveal: %@", exception.reason);
    return NO;
  }
  return YES;
}

- (void)stop {
  self.active = NO;
  self.handler = nil;
  for (NSString *key in self.observedKeys) {
    [self.companion removeObserver:self forKeyPath:key
                           context:&RionFullscreenRevealPropertyContext];
  }
  [self.observedKeys removeAllObjects];
}

- (void)reconcile {
  if (!self.active || self.delivering || !self.window || !self.companion) return;
  self.delivering = YES;
  double menuBar = [[self.companion valueForKey:@"menuBarReveal"] doubleValue];
  double toolbar = [[self.companion valueForKey:@"toolbarWindowReveal"] doubleValue];
  double desired = self.pinned ? 1.0 : menuBar;
  if (std::isfinite(menuBar) && std::isfinite(toolbar)) {
    desired = MIN(1.0, MAX(0.0, desired));
    if (fabs(toolbar - desired) > 0.0001) {
      RionSetFullscreenToolbarReveal(self.window, desired);
      toolbar = [[self.companion valueForKey:@"toolbarWindowReveal"] doubleValue];
    }
    BOOL changed = self.sequence == 0 || self.menuBarReveal != menuBar ||
        self.toolbarReveal != toolbar;
    self.menuBarReveal = menuBar;
    self.toolbarReveal = toolbar;
    if (changed) {
      self.sequence += 1;
      if (self.handler) self.handler();
    }
  }
  self.delivering = NO;
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                       change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                      context:(void *)context {
  if (context == &RionFullscreenRevealPropertyContext) {
    [self reconcile];
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)dealloc { [self stop]; }
@end

static void RionBindFullscreenReveal(NSWindow *window, BOOL active, BOOL pinned,
                                     void (^handler)(void)) {
  if (!window) return;
  NSObject *companion = active ? RionFullscreenToolbarCompanionController(window) : nil;
  RionRuntimeFullscreenRevealObservation *observation =
      objc_getAssociatedObject(window, &RionFullscreenRevealObservationKey);
  if (observation && observation.companion != companion) {
    [observation stop];
    objc_setAssociatedObject(window, &RionFullscreenRevealObservationKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    observation = nil;
  }
  if (!active || !companion) return;
  if (!observation) {
    observation = [[RionRuntimeFullscreenRevealObservation alloc] init];
    observation.window = window;
    observation.companion = companion;
    if (![observation start]) return;
    objc_setAssociatedObject(window, &RionFullscreenRevealObservationKey,
                             observation, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  observation.active = YES;
  observation.pinned = pinned;
  observation.handler = handler;
  [observation reconcile];
}
