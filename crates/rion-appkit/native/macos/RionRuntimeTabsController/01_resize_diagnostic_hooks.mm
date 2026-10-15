#if defined(RION_DESKTOP_E2E)
#include <initializer_list>

NS_ASSUME_NONNULL_BEGIN

// Disposable diagnostic branch. These wrappers only witness existing calls.
@interface RionRuntimeTabsController (RionResizeMethodDiagnostics)
- (BOOL)resizeDiagnosticOwnsWindow:(NSWindow *)window;
- (void)recordResizeDiagnostic:(NSString *)reason
                         event:(nullable NSEvent *)event
                       details:(nullable NSDictionary *)details;
@end

@interface RionResizeDiagnosticOwner : NSObject
@property(nonatomic, weak, nullable) RionRuntimeTabsController *controller;
@property(nonatomic, weak, nullable) NSWindow *window;
@property(nonatomic, weak, nullable) id delegate;
@property(nonatomic) BOOL hadDelegate;
@property(nonatomic) uint64_t bindingSequence;
@end
@implementation RionResizeDiagnosticOwner
@end

@interface RionResizeDiagnosticCall : NSObject
@property(nonatomic, strong) RionResizeDiagnosticOwner *owner;
@property(nonatomic, weak, nullable) NSWindow *window;
@property(nonatomic, weak, nullable) id delegate;
@property(nonatomic) BOOL requiresDelegate;
@property(nonatomic, strong, nullable) NSEvent *event;
@property(nonatomic, copy) NSDictionary *details;
@end
@implementation RionResizeDiagnosticCall
@end

static char RionResizeDiagnosticOwnerKey;
static uint64_t RionResizeDiagnosticBindingSequence;

static NSDictionary *RionResizeRect(NSRect rect) {
  return @{ @"x" : @(rect.origin.x), @"y" : @(rect.origin.y),
            @"width" : @(rect.size.width), @"height" : @(rect.size.height) };
}

static NSDictionary *RionResizeSize(NSSize size) {
  return @{ @"width" : @(size.width), @"height" : @(size.height) };
}

static NSDictionary *RionResizeExistingViewMetadata(NSView * _Nullable content,
                                                   NSView * _Nullable accessoryRoot) {
  @try {
    NSMutableArray<NSView *> *roots = [NSMutableArray array];
    NSView * _Nullable candidates[] = {
      content, content.superview, accessoryRoot, accessoryRoot.superview
    };
    for (NSView *candidate : candidates) {
      if (candidate && [roots indexOfObjectIdenticalTo:candidate] == NSNotFound) [roots addObject:candidate];
    }
    NSMutableArray<NSView *> *views = [roots mutableCopy];
    NSUInteger omittedChildReferences = 0;
    for (NSView *root in roots) {
      NSArray<NSView *> *children = root.subviews;
      const NSUInteger inspected = MIN(children.count, (NSUInteger)8);
      omittedChildReferences += children.count - inspected;
      for (NSUInteger index = 0; index < inspected; ++index) {
        NSView *child = children[index];
        if ([views indexOfObjectIdenticalTo:child] != NSNotFound) continue;
        if (views.count == 8) { ++omittedChildReferences; continue; }
        [views addObject:child];
      }
    }
    NSMutableArray *records = [NSMutableArray array];
    NSUInteger omittedConstraints = 0;
    for (NSView *view in views) {
      NSArray<NSLayoutConstraint *> *existing = view.constraints;
      const NSUInteger count = MIN(existing.count, (NSUInteger)8);
      omittedConstraints += existing.count - count;
      NSMutableArray *constraints = [NSMutableArray array];
      for (NSUInteger index = 0; index < count; ++index) {
        NSLayoutConstraint *constraint = existing[index];
        id first = constraint.firstItem;
        id second = constraint.secondItem;
        [constraints addObject:@{
          @"firstItemClass" : first ? NSStringFromClass(object_getClass(first)) : @"",
          @"firstItemPointer" : [NSString stringWithFormat:@"%p", first],
          @"secondItemClass" : second ? NSStringFromClass(object_getClass(second)) : @"",
          @"secondItemPointer" : [NSString stringWithFormat:@"%p", second],
          @"firstAttribute" : @(constraint.firstAttribute), @"secondAttribute" : @(constraint.secondAttribute),
          @"relation" : @(constraint.relation), @"constant" : @(constraint.constant),
          @"multiplier" : @(constraint.multiplier), @"priority" : @(constraint.priority),
          @"active" : @(constraint.active)
        }];
      }
      [records addObject:@{
        @"class" : NSStringFromClass(object_getClass(view)),
        @"pointer" : [NSString stringWithFormat:@"%p", view], @"frame" : RionResizeRect(view.frame),
        @"translatesAutoresizingMaskIntoConstraints" : @(view.translatesAutoresizingMaskIntoConstraints),
        @"autoresizingMask" : @(view.autoresizingMask), @"constraints" : constraints,
        @"omittedConstraints" : @(existing.count - count)
      }];
    }
    return @{ @"viewCapacity" : @8, @"constraintCapacityPerView" : @8,
              @"omittedChildReferences" : @(omittedChildReferences),
              @"omittedConstraints" : @(omittedConstraints), @"views" : records };
  } @catch (__unused NSException *exception) {
    return @{ @"error" : @"existing-view-getter-failed" };
  }
}

static RionResizeDiagnosticOwner * _Nullable RionResizeOwner(
    NSWindow * _Nullable window, id _Nullable delegate) {
  if (!NSThread.isMainThread || !window) return nil;
  RionResizeDiagnosticOwner *owner =
      objc_getAssociatedObject(window, &RionResizeDiagnosticOwnerKey);
  RionRuntimeTabsController *controller = owner.controller;
  if (!owner || owner.window != window || !controller ||
      ![controller resizeDiagnosticOwnsWindow:window] ||
      (owner.hadDelegate && !owner.delegate) || owner.delegate != window.delegate ||
      (delegate && (owner.delegate != delegate || window.delegate != delegate))) {
    return nil;
  }
  return owner;
}

static RionResizeDiagnosticCall * _Nullable RionResizeBegin(
    NSWindow * _Nullable window, id _Nullable delegate, id receiver, SEL selector, Class wrappedClass) {
  @try {
    RionResizeDiagnosticOwner *owner = RionResizeOwner(window, delegate);
    if (!owner) return nil;
    RionResizeDiagnosticCall *call = [RionResizeDiagnosticCall new];
    call.owner = owner;
    call.window = window;
    call.delegate = delegate;
    call.requiresDelegate = delegate != nil;
    call.event = NSApp.currentEvent;
    call.details = @{
      @"selector" : NSStringFromSelector(selector),
      @"wrappedClass" : NSStringFromClass(wrappedClass),
      @"definingClass" : NSStringFromClass(wrappedClass),
      @"receiverClass" : NSStringFromClass(object_getClass(receiver)),
      @"receiverPointer" : [NSString stringWithFormat:@"%p", receiver],
      @"enteredAtUnixSeconds" : @(NSDate.date.timeIntervalSince1970),
      @"beforeFrame" : RionResizeRect(window.frame)
    };
    return call;
  } @catch (__unused NSException *exception) {
    return nil;
  }
}

static void RionResizeComplete(RionResizeDiagnosticCall * _Nullable call,
                               NSDictionary *(^result)(void)) {
  if (!call) return;
  @try {
    NSWindow *window = call.window;
    if (call.requiresDelegate && !call.delegate) return;
    if (RionResizeOwner(window, call.delegate) != call.owner) return;
    NSMutableDictionary *details = [call.details mutableCopy];
    [details addEntriesFromDictionary:result()];
    details[@"returnedAtUnixSeconds"] = @(NSDate.date.timeIntervalSince1970);
    details[@"afterFrame"] = RionResizeRect(window.frame);
    [call.owner.controller recordResizeDiagnostic:@"method:return"
        event:call.event details:details];
  } @catch (__unused NSException *exception) {
    // Instrumentation failure must never change the original method outcome.
  }
}

static Method _Nullable RionResizeDirectMethod(Class target, SEL selector) {
  unsigned count = 0;
  Method *methods = class_copyMethodList(target, &count);
  Method found = nullptr;
  for (unsigned index = 0; index < count; ++index) {
    if (method_getName(methods[index]) == selector) found = methods[index];
  }
  free(methods);
  return found;
}

static Class _Nullable RionResizeDefiningClass(Class _Nullable target, SEL selector) {
  for (Class candidate = target; candidate; candidate = class_getSuperclass(candidate)) {
    if (RionResizeDirectMethod(candidate, selector)) return candidate;
  }
  return Nil;
}

static BOOL RionResizeType(const char * _Nullable actual, const char *expected) {
  while (actual && *actual && std::strchr("rnNoORV", *actual)) ++actual;
  if (!actual) return NO;
  return expected[0] == '@' ? actual[0] == '@' && actual[1] != '?'
                            : std::strcmp(actual, expected) == 0;
}

static BOOL RionResizeSignature(Method _Nullable method, const char *result,
                                std::initializer_list<const char *> arguments) {
  if (!method) return NO;
  NSMethodSignature *signature = [NSMethodSignature
      signatureWithObjCTypes:method_getTypeEncoding(method)];
  NSUInteger returnSize = 0;
  if (std::strcmp(result, @encode(void)) != 0) {
    NSGetSizeAndAlignment(result, &returnSize, nullptr);
  }
  if (!signature || signature.numberOfArguments != arguments.size() + 2 ||
      signature.methodReturnLength != returnSize ||
      !RionResizeType(signature.methodReturnType, result) ||
      !RionResizeType([signature getArgumentTypeAtIndex:0], @encode(id)) ||
      !RionResizeType([signature getArgumentTypeAtIndex:1], @encode(SEL))) return NO;
  NSUInteger index = 2;
  for (const char *argument : arguments) {
    if (!RionResizeType([signature getArgumentTypeAtIndex:index++], argument)) return NO;
  }
  return YES;
}

static NSDictionary *RionResizeInstall(Class _Nullable target, SEL selector) {
  static NSMutableDictionary<NSString *, NSDictionary *> *installed =
      [NSMutableDictionary dictionary];
  NSString *key = [NSString stringWithFormat:@"%p/%@", target, NSStringFromSelector(selector)];
  if (installed[key]) return installed[key];
  NSMutableDictionary *status = [@{
    @"selector" : NSStringFromSelector(selector),
    @"wrappedClass" : target ? NSStringFromClass(target) : @"",
    @"definingClass" : target ? NSStringFromClass(target) : @"",
    @"status" : @"unsupported"
  } mutableCopy];
  if (installed.count >= 32) {
    status[@"status"] = @"error";
    status[@"reason"] = @"hook-class-capacity";
    return status;
  }
  Method method = target ? RionResizeDirectMethod(target, selector) : nullptr;
  if (!method) { status[@"reason"] = @"method-absent"; return status; }
  const IMP original = method_getImplementation(method);
  id block = nil;
  if (selector == @selector(windowWillResize:toSize:) &&
      RionResizeSignature(method, @encode(NSSize), { @encode(NSWindow *), @encode(NSSize) })) {
    block = ^NSSize(id receiver, NSWindow *window, NSSize proposed) {
      RionResizeDiagnosticCall *call = RionResizeBegin(window, receiver, receiver, selector, target);
      using Function = NSSize (*)(id, SEL, NSWindow *, NSSize);
      const NSSize result = reinterpret_cast<Function>(original)(receiver, selector, window, proposed);
      RionResizeComplete(call, ^NSDictionary *{ return @{
        @"proposedSize" : RionResizeSize(proposed), @"returnedSize" : RionResizeSize(result) }; });
      return result;
    };
  } else if (selector == @selector(constrainFrameRect:toScreen:) &&
      RionResizeSignature(method, @encode(NSRect), { @encode(NSRect), @encode(NSScreen *) })) {
    block = ^NSRect(NSWindow *receiver, NSRect proposed, NSScreen * _Nullable screen) {
      RionResizeDiagnosticCall *call = RionResizeBegin(receiver, nil, receiver, selector, target);
      using Function = NSRect (*)(id, SEL, NSRect, NSScreen * _Nullable);
      const NSRect result = reinterpret_cast<Function>(original)(receiver, selector, proposed, screen);
      RionResizeComplete(call, ^NSDictionary *{ return @{
        @"proposedFrame" : RionResizeRect(proposed), @"returnedFrame" : RionResizeRect(result),
        @"screenPointer" : [NSString stringWithFormat:@"%p", screen],
        @"screenFrame" : RionResizeRect(screen ? screen.frame : NSZeroRect),
        @"screenVisibleFrame" : RionResizeRect(screen ? screen.visibleFrame : NSZeroRect) }; });
      return result;
    };
  } else if (selector == @selector(setFrame:display:) &&
      RionResizeSignature(method, @encode(void), { @encode(NSRect), @encode(BOOL) })) {
    block = ^(NSWindow *receiver, NSRect proposed, BOOL display) {
      RionResizeDiagnosticCall *call = RionResizeBegin(receiver, nil, receiver, selector, target);
      using Function = void (*)(id, SEL, NSRect, BOOL);
      reinterpret_cast<Function>(original)(receiver, selector, proposed, display);
      RionResizeComplete(call, ^NSDictionary *{ return @{
        @"proposedFrame" : RionResizeRect(proposed), @"display" : @(display) }; });
    };
  } else if (selector == @selector(nextEventMatchingMask:untilDate:inMode:dequeue:) &&
      RionResizeSignature(method, @encode(NSEvent *), {
        @encode(NSEventMask), @encode(NSDate *), @encode(NSRunLoopMode), @encode(BOOL) })) {
    block = ^NSEvent * _Nullable(NSApplication *receiver, NSEventMask mask, NSDate * _Nullable until,
                       NSRunLoopMode mode, BOOL dequeue) {
      using Function = NSEvent * _Nullable (*)(id, SEL, NSEventMask, NSDate * _Nullable, NSRunLoopMode, BOOL);
      const uint64_t beforeBindingSequence = NSThread.isMainThread
          ? RionResizeDiagnosticBindingSequence : 0;
      const NSTimeInterval enteredAt = CFAbsoluteTimeGetCurrent() + kCFAbsoluteTimeIntervalSince1970;
      NSEvent *event = reinterpret_cast<Function>(original)(receiver, selector, mask, until, mode, dequeue);
      @try {
        if (event && (event.type == NSEventTypeLeftMouseDragged || event.type == NSEventTypeLeftMouseUp)) {
          RionResizeDiagnosticOwner *owner = RionResizeOwner(event.window, nil);
          if (!owner || owner.bindingSequence > beforeBindingSequence) return event;
          RionResizeDiagnosticCall *call = RionResizeBegin(event.window, nil, receiver, selector, target);
          if (!call) return event;
          NSMutableDictionary *details = [call.details mutableCopy];
          details[@"enteredAtUnixSeconds"] = @(enteredAt);
          details[@"ownerSnapshotPhase"] = @"after-original-return";
          details[@"returnedOwnerFrame"] = details[@"beforeFrame"];
          [details removeObjectForKey:@"beforeFrame"];
          call.details = details;
          call.event = event;
          RionResizeComplete(call, ^NSDictionary *{ return @{
            @"mask" : @(mask), @"mode" : mode ?: @"", @"dequeue" : @(dequeue),
            @"eventDisposition" : dequeue ? @"dequeued" : @"peek",
            @"untilDateUnixSeconds" : @(until.timeIntervalSince1970),
            @"returnedEventPointer" : [NSString stringWithFormat:@"%p", event] }; });
        }
      } @catch (__unused NSException *exception) { }
      return event;
    };
  }
  if (!block) { status[@"reason"] = @"signature-mismatch"; return status; }
  IMP wrapper = imp_implementationWithBlock(block);
  if (!wrapper) { status[@"status"] = @"error"; status[@"reason"] = @"block-imp-unavailable"; return status; }
  method_setImplementation(method, wrapper);
  status[@"status"] = @"installed";
  installed[key] = [status copy];
  return installed[key];
}

static NSArray<NSDictionary *> *RionBindResizeDiagnosticHooks(
    NSWindow * _Nullable window, RionRuntimeTabsController * _Nullable controller) {
  NSMutableArray *statuses = [NSMutableArray array];
  if (!NSThread.isMainThread || !window || !controller) return statuses;
  @try {
    RionResizeDiagnosticOwner *owner = [RionResizeDiagnosticOwner new];
    owner.window = window;
    owner.controller = controller;
    owner.delegate = window.delegate;
    owner.hadDelegate = window.delegate != nil;
    owner.bindingSequence = ++RionResizeDiagnosticBindingSequence;
    objc_setAssociatedObject(window, &RionResizeDiagnosticOwnerKey, owner, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    const SEL delegateSelector = @selector(windowWillResize:toSize:);
    [statuses addObject:RionResizeInstall(RionResizeDefiningClass(object_getClass(window.delegate), delegateSelector), delegateSelector)];
    for (NSString *name in @[@"constrainFrameRect:toScreen:", @"setFrame:display:"]) {
      SEL selector = NSSelectorFromString(name);
      Class defining = RionResizeDefiningClass(object_getClass(window), selector);
      if (defining && defining != NSWindow.class) [statuses addObject:RionResizeInstall(defining, selector)];
      [statuses addObject:RionResizeInstall(NSWindow.class, selector)];
    }
    SEL next = @selector(nextEventMatchingMask:untilDate:inMode:dequeue:);
    [statuses addObject:RionResizeInstall(RionResizeDefiningClass(object_getClass(NSApp), next), next)];
  } @catch (__unused NSException *exception) {
    [statuses addObject:@{ @"selector" : @"installation", @"wrappedClass" : @"",
                          @"definingClass" : @"", @"status" : @"error", @"reason" : @"installation-exception" }];
  }
  return [statuses copy];
}

static void RionUnbindResizeDiagnosticHooks(NSWindow * _Nullable window,
                                           RionRuntimeTabsController * _Nullable controller) {
  if (!window || !controller) return;
  @try {
    RionResizeDiagnosticOwner *owner = objc_getAssociatedObject(window, &RionResizeDiagnosticOwnerKey);
    if (owner.controller == controller && owner.window == window) {
      objc_setAssociatedObject(window, &RionResizeDiagnosticOwnerKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
  } @catch (__unused NSException *exception) { }
}
NS_ASSUME_NONNULL_END
#endif
