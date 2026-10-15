#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <initializer_list>

// This executable never orders a window front or submits native input.
#ifndef RION_DESKTOP_E2E
#define RION_DESKTOP_E2E 1
#endif

@interface RionRuntimeTabsController : NSObject
@property(nonatomic, weak) NSWindow *target;
@property(nonatomic, strong) id retainedFixtureDelegate;
@property(nonatomic) BOOL ownsTarget;
@property(nonatomic) BOOL throwWhileRecording;
@property(nonatomic) NSUInteger recordingAttempts;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *records;
@end

#include "../../crates/rion-appkit/native/macos/RionRuntimeTabsController/01_resize_diagnostic_hooks.mm"

static void Require(BOOL condition, NSString *message) {
  if (!condition) {
    @throw [NSException exceptionWithName:@"FixtureAssertion"
                                  reason:message userInfo:nil];
  }
}

@implementation RionRuntimeTabsController
- (instancetype)init {
  if ((self = [super init])) {
    _ownsTarget = YES;
    _records = [NSMutableArray array];
  }
  return self;
}
- (BOOL)resizeDiagnosticOwnsWindow:(NSWindow *)window {
  return self.ownsTarget && self.target == window;
}
- (void)recordResizeDiagnostic:(NSString *)reason event:(NSEvent *)event
                       details:(NSDictionary *)details {
  self.recordingAttempts++;
  if (self.throwWhileRecording) {
    @throw [NSException exceptionWithName:@"RecordingFailure"
                                  reason:@"diagnostic-only failure" userInfo:nil];
  }
  [self.records addObject:@{ @"reason" : reason, @"event" : event ?: NSNull.null,
                            @"details" : details ?: @{} }];
}
@end

@interface ResizeFixtureDelegate : NSObject <NSWindowDelegate>
@property(nonatomic) NSUInteger calls;
@property(nonatomic, weak) id receivedSelf;
@property(nonatomic) SEL receivedSelector;
@property(nonatomic, weak) NSWindow *receivedWindow;
@property(nonatomic) NSSize receivedSize;
@property(nonatomic, copy) void (^insideOriginal)(void);
@property(nonatomic, strong) NSException *originalException;
@end

@implementation ResizeFixtureDelegate
- (NSSize)windowWillResize:(NSWindow *)window toSize:(NSSize)size {
  self.calls++;
  self.receivedSelf = self;
  self.receivedSelector = _cmd;
  self.receivedWindow = window;
  self.receivedSize = size;
  if (self.insideOriginal) self.insideOriginal();
  if (self.originalException) @throw self.originalException;
  return NSMakeSize(size.width - 7.25, size.height + 4.5);
}
@end

@interface ResizeFixtureWindow : NSWindow
@property(nonatomic) BOOL fixtureReady;
@property(nonatomic) NSRect fixtureFrame;
@property(nonatomic) NSUInteger constrainCalls;
@property(nonatomic) NSUInteger setCalls;
@property(nonatomic, weak) id receivedSelf;
@property(nonatomic) SEL receivedSelector;
@property(nonatomic) NSRect receivedRect;
@property(nonatomic, weak) NSScreen *receivedScreen;
@property(nonatomic) BOOL receivedDisplay;
@property(nonatomic, copy) void (^insideOriginal)(void);
@property(nonatomic, strong) NSException *originalException;
@end

@implementation ResizeFixtureWindow
- (NSRect)frame {
  return self.fixtureReady ? self.fixtureFrame : [super frame];
}
- (NSRect)constrainFrameRect:(NSRect)rect toScreen:(NSScreen *)screen {
  if (!self.fixtureReady) return [super constrainFrameRect:rect toScreen:screen];
  self.constrainCalls++;
  self.receivedSelf = self;
  self.receivedSelector = _cmd;
  self.receivedRect = rect;
  self.receivedScreen = screen;
  if (self.insideOriginal) self.insideOriginal();
  if (self.originalException) @throw self.originalException;
  return NSMakeRect(rect.origin.x + 0.25, rect.origin.y - 0.5,
                    rect.size.width - 3.5, rect.size.height + 2.25);
}
- (void)setFrame:(NSRect)rect display:(BOOL)display {
  if (!self.fixtureReady) { [super setFrame:rect display:display]; return; }
  self.setCalls++;
  self.receivedSelf = self;
  self.receivedSelector = _cmd;
  self.receivedRect = rect;
  self.receivedDisplay = display;
  if (self.insideOriginal) self.insideOriginal();
  if (self.originalException) @throw self.originalException;
  self.fixtureFrame = rect;
}
@end

@interface ResizeInheritedWindow : ResizeFixtureWindow
@end
@implementation ResizeInheritedWindow
@end

// Exercise an override that genuinely calls the wrapped NSWindow base method.
@interface ResizeSuperWindow : NSWindow
@property(nonatomic) BOOL fixtureReady;
@property(nonatomic) NSUInteger constrainCalls;
@property(nonatomic) NSUInteger setCalls;
@end
@implementation ResizeSuperWindow
- (NSRect)constrainFrameRect:(NSRect)rect toScreen:(NSScreen *)screen {
  if (self.fixtureReady) self.constrainCalls++;
  return [super constrainFrameRect:rect toScreen:screen];
}
- (void)setFrame:(NSRect)rect display:(BOOL)display {
  if (self.fixtureReady) self.setCalls++;
  [super setFrame:rect display:display];
}
@end

@interface ResizeAbsentDelegate : NSObject
@end
@implementation ResizeAbsentDelegate
@end

@interface ResizeWrongSignatureDelegate : NSObject
@property(nonatomic) NSUInteger calls;
- (NSInteger)windowWillResize:(id)window toSize:(NSInteger)value;
@end
@implementation ResizeWrongSignatureDelegate
- (NSInteger)windowWillResize:(id)window toSize:(NSInteger)value {
  (void)window;
  self.calls++;
  return value + 13;
}
@end

@interface ResizeGetterTrapView : NSView
@property(nonatomic) BOOL rejectLayoutQueries;
@property(nonatomic) NSUInteger forbiddenQueries;
@end
@implementation ResizeGetterTrapView
- (void)rejectQuery {
  if (!self.rejectLayoutQueries) return;
  self.forbiddenQueries++;
  @throw [NSException exceptionWithName:@"ForbiddenLayoutQuery"
                                reason:@"metadata must only read existing state" userInfo:nil];
}
- (NSSize)fittingSize { [self rejectQuery]; return [super fittingSize]; }
- (NSSize)intrinsicContentSize { [self rejectQuery]; return [super intrinsicContentSize]; }
- (NSArray<NSLayoutConstraint *> *)constraintsAffectingLayoutForOrientation:(NSLayoutConstraintOrientation)orientation {
  [self rejectQuery];
  return [super constraintsAffectingLayoutForOrientation:orientation];
}
- (void)layout { [self rejectQuery]; [super layout]; }
- (void)updateConstraints { [self rejectQuery]; [super updateConstraints]; }
- (void)layoutSubtreeIfNeeded { [self rejectQuery]; [super layoutSubtreeIfNeeded]; }
- (void)updateConstraintsForSubtreeIfNeeded { [self rejectQuery]; [super updateConstraintsForSubtreeIfNeeded]; }
- (void)sizeToFit { [self rejectQuery]; }
@end

@interface ResizeFixtureApplication : NSApplication
@property(nonatomic) NSUInteger nextCalls;
@property(nonatomic, weak) id receivedSelf;
@property(nonatomic) SEL receivedSelector;
@property(nonatomic) NSEventMask receivedMask;
@property(nonatomic, strong) NSDate *receivedDate;
@property(nonatomic, strong) NSRunLoopMode receivedMode;
@property(nonatomic) BOOL receivedDequeue;
@property(nonatomic, strong) NSEvent *fixtureEvent;
@property(nonatomic, copy) void (^insideOriginal)(void);
@property(nonatomic, strong) NSException *originalException;
@end
@implementation ResizeFixtureApplication
- (NSEvent *)nextEventMatchingMask:(NSEventMask)mask untilDate:(NSDate *)date
                            inMode:(NSRunLoopMode)mode dequeue:(BOOL)dequeue {
  self.nextCalls++;
  self.receivedSelf = self;
  self.receivedSelector = _cmd;
  self.receivedMask = mask;
  self.receivedDate = date;
  self.receivedMode = mode;
  self.receivedDequeue = dequeue;
  if (self.insideOriginal) self.insideOriginal();
  if (self.originalException) @throw self.originalException;
  return self.fixtureEvent;
}
@end

static NSRect FixtureRect(void) { return NSMakeRect(100.25, 100.5, 300.5, 200.25); }
static NSSize FixtureSize(void) { return NSMakeSize(712.25, 645.5); }

static ResizeFixtureWindow *NewWindow(Class windowClass = ResizeFixtureWindow.class) {
  ResizeFixtureWindow *window = [[windowClass alloc]
      initWithContentRect:NSMakeRect(100, 100, 300, 200)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed = NO;
  window.fixtureFrame = FixtureRect();
  window.fixtureReady = YES;
  window.constrainCalls = 0;
  window.setCalls = 0;
  Require(!window.visible, @"fixture must never publish a visible window");
  return window;
}

static RionRuntimeTabsController *Bind(NSWindow *window, id delegate) {
  window.delegate = delegate;
  RionRuntimeTabsController *controller = [RionRuntimeTabsController new];
  controller.target = window;
  controller.retainedFixtureDelegate = delegate;
  RionBindResizeDiagnosticHooks(window, controller);
  return controller;
}

static NSArray<NSDictionary *> *Records(RionRuntimeTabsController *controller, SEL selector) {
  NSMutableArray *result = [NSMutableArray array];
  for (NSDictionary *record in controller.records) {
    if ([record[@"details"][@"selector"] isEqual:NSStringFromSelector(selector)]) {
      [result addObject:record];
    }
  }
  return result;
}

static NSEvent *MouseEvent(NSWindow *window, NSEventType type) {
  NSEvent *event = [NSEvent mouseEventWithType:type location:NSMakePoint(10, 12)
      modifierFlags:0 timestamp:1 windowNumber:window.windowNumber context:nil
      eventNumber:17 clickCount:1 pressure:1];
  Require(event.window == window, @"native event must retain its exact hidden window");
  return event;
}

static void ResetApplication(ResizeFixtureApplication *application) {
  application.nextCalls = 0;
  application.insideOriginal = nil;
  application.originalException = nil;
  application.fixtureEvent = nil;
}

static void Run(NSMutableArray<NSString *> *passed, NSString *name, void (^test)(void)) {
  @try { test(); [passed addObject:name]; }
  @catch (NSException *exception) {
    NSData *output = [NSJSONSerialization dataWithJSONObject:@{
      @"status" : @"failed", @"case" : name, @"passed" : passed,
      @"exceptionName" : exception.name, @"reason" : exception.reason ?: @""
    } options:0 error:nil];
    fprintf(stderr, "%s\n", [[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding].UTF8String);
    std::exit(1);
  }
}

int main(void) {
  @autoreleasepool {
    NSApplication *shared = [ResizeFixtureApplication sharedApplication];
    Require(object_getClass(shared) == ResizeFixtureApplication.class,
            @"fixture must own the application method receiver");
    ResizeFixtureApplication *application = (ResizeFixtureApplication *)shared;
    NSMutableArray<NSString *> *passed = [NSMutableArray array];

    Run(passed, @"delegate size ABI and original receiver/selector/arguments", ^{
      ResizeFixtureWindow *window = NewWindow();
      ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
      RionRuntimeTabsController *controller = Bind(window, delegate);
      NSSize proposed = FixtureSize();
      NSSize result = [delegate windowWillResize:window toSize:proposed];
      Require(delegate.calls == 1 && delegate.receivedSelf == delegate &&
              delegate.receivedSelector == @selector(windowWillResize:toSize:) &&
              delegate.receivedWindow == window && NSEqualSizes(delegate.receivedSize, proposed),
              @"delegate original invocation changed");
      Require(NSEqualSizes(result, NSMakeSize(705, 650)), @"NSSize return ABI changed");
      Require(Records(controller, @selector(windowWillResize:toSize:)).count == 1,
              @"delegate return must be captured once");
      RionUnbindResizeDiagnosticHooks(window, controller);
    });

    Run(passed, @"window rect and BOOL ABI preserve exact original calls", ^{
      ResizeFixtureWindow *window = NewWindow();
      ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
      RionRuntimeTabsController *controller = Bind(window, delegate);
      NSRect proposed = FixtureRect();
      NSScreen *screen = NSScreen.mainScreen;
      NSRect result = [window constrainFrameRect:proposed toScreen:screen];
      Require(window.constrainCalls == 1 && window.receivedSelf == window &&
              window.receivedSelector == @selector(constrainFrameRect:toScreen:) &&
              NSEqualRects(window.receivedRect, proposed) && window.receivedScreen == screen,
              @"constraint original receiver or arguments changed");
      Require(NSEqualRects(result, NSMakeRect(100.5, 100, 297, 202.5)), @"NSRect return ABI changed");
      for (NSNumber *display in @[@NO, @YES]) {
        [window setFrame:proposed display:display.boolValue];
        Require(window.receivedSelf == window && window.receivedSelector == @selector(setFrame:display:) &&
                NSEqualRects(window.receivedRect, proposed) && window.receivedDisplay == display.boolValue &&
                NSEqualRects(window.frame, proposed), @"setFrame original arguments changed");
      }
      Require(window.setCalls == 2 && Records(controller, @selector(setFrame:display:)).count == 2,
              @"setFrame must forward exactly once per call");
      RionUnbindResizeDiagnosticHooks(window, controller);
    });

    Run(passed, @"subclass then actual NSWindow super has no recursion", ^{
      ResizeSuperWindow *window = [[ResizeSuperWindow alloc]
          initWithContentRect:NSMakeRect(100, 100, 300, 200)
                    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
                      backing:NSBackingStoreBuffered defer:NO];
      window.releasedWhenClosed = NO;
      NSRect proposed = NSMakeRect(120, 120, 320, 240);
      NSRect baseline = [window constrainFrameRect:proposed toScreen:NSScreen.mainScreen];
      ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
      RionRuntimeTabsController *controller = Bind(window, delegate);
      window.fixtureReady = YES;
      window.constrainCalls = 0;
      window.setCalls = 0;
      NSRect result = [window constrainFrameRect:proposed toScreen:NSScreen.mainScreen];
      Require(window.constrainCalls == 1 && NSEqualRects(result, baseline), @"super constraint forwarding changed");
      Require(Records(controller, @selector(constrainFrameRect:toScreen:)).count == 2,
              @"both subclass and NSWindow base returns must be observed");
      [controller.records removeAllObjects];
      [window setFrame:proposed display:NO];
      Require(window.setCalls == 1 && NSEqualRects(window.frame, proposed), @"super setFrame forwarding changed");
      Require(Records(controller, @selector(setFrame:display:)).count == 2,
              @"both setFrame implementations must be observed without recursion");
      Require(!window.visible, @"super forwarding must not show the fixture window");
      RionUnbindResizeDiagnosticHooks(window, controller);
    });

    Run(passed, @"inherited method stays on its defining class", ^{
      Require(!RionResizeDirectMethod(ResizeInheritedWindow.class, @selector(constrainFrameRect:toScreen:)),
              @"fixture unexpectedly defines an inherited override");
      ResizeFixtureWindow *window = NewWindow(ResizeInheritedWindow.class);
      ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
      RionRuntimeTabsController *controller = Bind(window, delegate);
      [window constrainFrameRect:FixtureRect() toScreen:nil];
      NSArray *records = Records(controller, @selector(constrainFrameRect:toScreen:));
      Require(window.constrainCalls == 1 && records.count == 1 &&
              [records[0][@"details"][@"definingClass"] isEqual:NSStringFromClass(ResizeFixtureWindow.class)] &&
              !RionResizeDirectMethod(ResizeInheritedWindow.class, @selector(constrainFrameRect:toScreen:)),
              @"inherited wrapping altered the method owner");
      RionUnbindResizeDiagnosticHooks(window, controller);
    });

    Run(passed, @"optional absent and incompatible signatures are not installed", ^{
      SEL selector = @selector(windowWillResize:toSize:);
      NSDictionary *absent = RionResizeInstall(ResizeAbsentDelegate.class, selector);
      Require([absent[@"status"] isEqual:@"unsupported"] && [absent[@"reason"] isEqual:@"method-absent"] &&
              !class_getInstanceMethod(ResizeAbsentDelegate.class, selector), @"optional method was invented");
      Method method = class_getInstanceMethod(ResizeWrongSignatureDelegate.class, selector);
      IMP original = method_getImplementation(method);
      NSDictionary *wrong = RionResizeInstall(ResizeWrongSignatureDelegate.class, selector);
      ResizeWrongSignatureDelegate *delegate = [ResizeWrongSignatureDelegate new];
      Require([wrong[@"status"] isEqual:@"unsupported"] && [wrong[@"reason"] isEqual:@"signature-mismatch"] &&
              method_getImplementation(method) == original && [delegate windowWillResize:nil toSize:19] == 32 &&
              delegate.calls == 1, @"incompatible ABI was wrapped or changed");
    });

    Run(passed, @"existing view metadata never requests fitting or layout", ^{
      ResizeGetterTrapView *content = [[ResizeGetterTrapView alloc] initWithFrame:FixtureRect()];
      ResizeGetterTrapView *accessory = [[ResizeGetterTrapView alloc] initWithFrame:NSMakeRect(0, 0, 300, 40)];
      [content addSubview:accessory];
      NSLayoutConstraint *existing = [accessory.widthAnchor constraintGreaterThanOrEqualToConstant:42.5];
      existing.priority = 750;
      [accessory addConstraint:existing];
      content.forbiddenQueries = 0;
      accessory.forbiddenQueries = 0;
      content.rejectLayoutQueries = YES;
      accessory.rejectLayoutQueries = YES;
      NSDictionary *metadata = RionResizeExistingViewMetadata(content, accessory);
      Require(!metadata[@"error"] && [metadata[@"views"] count] == 2 &&
              content.forbiddenQueries == 0 && accessory.forbiddenQueries == 0,
              @"metadata triggered a fitting, intrinsic, constraint-solver or layout query");
      BOOL foundExisting = NO;
      for (NSDictionary *view in metadata[@"views"]) {
        for (NSDictionary *constraint in view[@"constraints"]) {
          if ([constraint[@"constant"] doubleValue] == 42.5 && [constraint[@"priority"] doubleValue] == 750) {
            foundExisting = YES;
          }
        }
      }
      Require(foundExisting, @"metadata did not read the already-installed constraint");
      content.rejectLayoutQueries = NO;
      accessory.rejectLayoutQueries = NO;
    });

    Run(passed, @"nextEvent forwards exact object and marks peek versus dequeue", ^{
      ResizeFixtureWindow *window = NewWindow();
      ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
      RionRuntimeTabsController *controller = Bind(window, delegate);
      ResetApplication(application);
      NSEvent *event = MouseEvent(window, NSEventTypeLeftMouseDragged);
      application.fixtureEvent = event;
      NSDate *date = [NSDate dateWithTimeIntervalSince1970:123.5];
      NSRunLoopMode mode = @"fixture-native-tracking-mode";
      NSEventMask mask = NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp;
      for (NSNumber *dequeue in @[@NO, @YES]) {
        NSEvent *returned = [application nextEventMatchingMask:mask untilDate:date inMode:mode dequeue:dequeue.boolValue];
        Require(returned == event && application.receivedSelf == application &&
                application.receivedSelector == @selector(nextEventMatchingMask:untilDate:inMode:dequeue:) &&
                application.receivedMask == mask && application.receivedDate == date &&
                application.receivedMode == mode && application.receivedDequeue == dequeue.boolValue,
                @"nextEvent original invocation or object identity changed");
        NSDictionary *details = controller.records.lastObject[@"details"];
        Require([details[@"dequeue"] boolValue] == dequeue.boolValue &&
                [details[@"eventDisposition"] isEqual:(dequeue.boolValue ? @"dequeued" : @"peek")] &&
                controller.records.lastObject[@"event"] == event,
                @"peek must not become delivery evidence");
      }
      Require(application.nextCalls == 2 && controller.records.count == 2, @"nextEvent forwarded more than once");
      RionUnbindResizeDiagnosticHooks(window, controller);
      ResetApplication(application);
    });

    Run(passed, @"unowned calls remain exact pass-through without capture", ^{
      ResizeFixtureWindow *window = NewWindow();
      ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
      RionRuntimeTabsController *controller = Bind(window, delegate);
      RionUnbindResizeDiagnosticHooks(window, controller);
      [delegate windowWillResize:window toSize:FixtureSize()];
      [window constrainFrameRect:FixtureRect() toScreen:nil];
      [window setFrame:FixtureRect() display:YES];
      ResetApplication(application);
      application.fixtureEvent = MouseEvent(window, NSEventTypeLeftMouseUp);
      NSEvent *returned = [application nextEventMatchingMask:NSEventMaskLeftMouseUp
          untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES];
      Require(delegate.calls == 1 && window.constrainCalls == 1 && window.setCalls == 1 &&
              application.nextCalls == 1 && returned == application.fixtureEvent && controller.records.count == 0,
              @"unowned original behavior was changed or attributed");
      ResetApplication(application);
    });

    for (NSString *lane in @[@"delegate", @"constrain", @"setFrame", @"nextEvent"]) {
      Run(passed, [@"original exception identity: " stringByAppendingString:lane], ^{
        ResizeFixtureWindow *window = NewWindow();
        ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
        RionRuntimeTabsController *controller = Bind(window, delegate);
        ResetApplication(application);
        NSException *original = [NSException exceptionWithName:@"OriginalFailure" reason:lane userInfo:nil];
        delegate.originalException = original;
        window.originalException = original;
        application.originalException = original;
        NSException *observed = nil;
        @try {
          if ([lane isEqual:@"delegate"]) [delegate windowWillResize:window toSize:FixtureSize()];
          else if ([lane isEqual:@"constrain"]) [window constrainFrameRect:FixtureRect() toScreen:nil];
          else if ([lane isEqual:@"setFrame"]) [window setFrame:FixtureRect() display:NO];
          else [application nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
                                          inMode:NSDefaultRunLoopMode dequeue:YES];
        } @catch (NSException *exception) { observed = exception; }
        Require(observed == original && controller.records.count == 0,
                @"original exception was replaced, swallowed or published as a return");
        Require(delegate.calls + window.constrainCalls + window.setCalls + application.nextCalls == 1,
                @"throwing original was not called exactly once");
        RionUnbindResizeDiagnosticHooks(window, controller);
        ResetApplication(application);
      });

      Run(passed, [@"recording exception is observational: " stringByAppendingString:lane], ^{
        ResizeFixtureWindow *window = NewWindow();
        ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
        RionRuntimeTabsController *controller = Bind(window, delegate);
        controller.throwWhileRecording = YES;
        ResetApplication(application);
        application.fixtureEvent = MouseEvent(window, NSEventTypeLeftMouseDragged);
        if ([lane isEqual:@"delegate"]) {
          Require(NSEqualSizes([delegate windowWillResize:window toSize:FixtureSize()], NSMakeSize(705, 650)),
                  @"recording changed size result");
        } else if ([lane isEqual:@"constrain"]) {
          Require(NSEqualRects([window constrainFrameRect:FixtureRect() toScreen:nil],
                              NSMakeRect(100.5, 100, 297, 202.5)), @"recording changed rect result");
        } else if ([lane isEqual:@"setFrame"]) {
          [window setFrame:FixtureRect() display:YES];
          Require(NSEqualRects(window.frame, FixtureRect()), @"recording changed void method effect");
        } else {
          Require([application nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
                  inMode:NSDefaultRunLoopMode dequeue:YES] == application.fixtureEvent,
                  @"recording changed returned event identity");
        }
        Require(controller.recordingAttempts == 1 && controller.records.count == 0,
                @"recording exception escaped or retried");
        RionUnbindResizeDiagnosticHooks(window, controller);
        ResetApplication(application);
      });

      for (NSString *mutation in @[@"detach", @"rebind", @"delegate"]) {
        Run(passed, [NSString stringWithFormat:@"original-call %@ suppresses stale capture: %@", mutation, lane], ^{
          ResizeFixtureWindow *window = NewWindow();
          ResizeFixtureDelegate *delegate = [ResizeFixtureDelegate new];
          ResizeFixtureDelegate *replacement = [ResizeFixtureDelegate new];
          RionRuntimeTabsController *controller = Bind(window, delegate);
          ResetApplication(application);
          application.fixtureEvent = MouseEvent(window, NSEventTypeLeftMouseDragged);
          void (^mutate)(void) = ^{
            if ([mutation isEqual:@"detach"]) RionUnbindResizeDiagnosticHooks(window, controller);
            else if ([mutation isEqual:@"rebind"]) RionBindResizeDiagnosticHooks(window, controller);
            else window.delegate = replacement;
          };
          if ([lane isEqual:@"delegate"]) {
            delegate.insideOriginal = mutate;
            [delegate windowWillResize:window toSize:FixtureSize()];
          } else if ([lane isEqual:@"constrain"]) {
            window.insideOriginal = mutate;
            [window constrainFrameRect:FixtureRect() toScreen:nil];
          } else if ([lane isEqual:@"setFrame"]) {
            window.insideOriginal = mutate;
            [window setFrame:FixtureRect() display:NO];
          } else {
            application.insideOriginal = mutate;
            [application nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
                                        inMode:NSDefaultRunLoopMode dequeue:YES];
          }
          Require(controller.records.count == 0 && controller.recordingAttempts == 0,
                  @"an owner changed inside the original call was recorded as current");
          Require(delegate.calls + window.constrainCalls + window.setCalls + application.nextCalls == 1,
                  @"ownership change altered original call count");
          delegate.insideOriginal = nil;
          window.insideOriginal = nil;
          RionUnbindResizeDiagnosticHooks(window, controller);
          ResetApplication(application);
        });
      }
    }

    NSData *output = [NSJSONSerialization dataWithJSONObject:@{
      @"status" : @"passed", @"nativeForwardingOnly" : @YES,
      @"cases" : passed, @"caseCount" : @(passed.count)
    } options:0 error:nil];
    printf("%s\n", [[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding].UTF8String);
    return 0;
  }
}
