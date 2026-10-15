#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dispatch/dispatch.h>
#include <cstdlib>
#include <cstdio>
#include <cmath>
#include <unistd.h>

NS_ASSUME_NONNULL_BEGIN

static NSDictionary *PlainControlRect(NSRect value) {
  return @{ @"x" : @(value.origin.x), @"y" : @(value.origin.y),
            @"width" : @(value.size.width), @"height" : @(value.size.height) };
}
static NSDictionary *PlainControlSize(NSSize value) {
  return @{ @"width" : @(value.width), @"height" : @(value.height) };
}
static id PlainControlScreenId(NSScreen * _Nullable screen) {
  return screen.deviceDescription[@"NSScreenNumber"] ?: NSNull.null;
}
static NSDictionary *PlainControlScreenEvidence(void) {
  NSScreen *main = NSScreen.mainScreen;
  NSMutableArray<NSDictionary *> *screens = [NSMutableArray array];
  for (NSScreen *screen in NSScreen.screens) {
    [screens addObject:@{ @"id" : PlainControlScreenId(screen),
        @"frame" : PlainControlRect(screen.frame), @"visibleFrame" : PlainControlRect(screen.visibleFrame),
        @"scale" : @(screen.backingScaleFactor) }];
  }
  return @{ @"mainScreenWasNil" : @(main == nil), @"mainScreenId" : PlainControlScreenId(main),
            @"screens" : screens };
}
static NSDictionary *PlainControlRequestedGeometry(void) {
  return @{ @"upperBoundSize" : PlainControlSize(NSMakeSize(960, 677)),
            @"minimumSize" : PlainControlSize(NSMakeSize(640, 512)),
            @"shrinkDelta" : PlainControlSize(NSMakeSize(48, 32)) };
}
static BOOL PlainControlValidRect(NSRect value) {
  return std::isfinite(value.origin.x) && std::isfinite(value.origin.y) &&
      std::isfinite(value.size.width) && std::isfinite(value.size.height) &&
      value.size.width > 0 && value.size.height > 0;
}
static NSDictionary *Buttons(void) {
  return @{ @"hidLeft" : @(CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft)),
            @"combinedLeft" : @(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft)),
            @"appKitLeft" : @((NSEvent.pressedMouseButtons & 1) != 0) };
}
static BOOL Neutral(NSDictionary *buttons) {
  return ![buttons[@"hidLeft"] boolValue] && ![buttons[@"combinedLeft"] boolValue] &&
         ![buttons[@"appKitLeft"] boolValue];
}
static void Publish(NSDictionary *value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!data) {
    fprintf(stderr, "control JSON serialization failed: %s\n", error.localizedDescription.UTF8String);
    std::exit(1);
  }
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

@interface PlainResizeControl : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong, nullable) NSWindow *window;
@property(nonatomic, copy) NSString *windowId;
@property(nonatomic, copy) NSString *nonce;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *records;
@property(nonatomic, strong) NSDictionary *geometrySelection;
@property(nonatomic) NSRect selectedFrame;
@property(nonatomic) NSUInteger sequence;
@property(nonatomic) NSUInteger dropped;
@property(nonatomic) BOOL readySent;
@property(nonatomic) BOOL closeRequested;
@property(nonatomic) BOOL launchFinished;
@property(nonatomic) BOOL launchTurnObserved;
- (void)receiveCommand:(NSDictionary *)command;
- (void)reject:(NSString *)reason;
@end

@implementation PlainResizeControl
- (instancetype)init {
  if ((self = [super init])) {
    _records = [NSMutableArray array];
    _geometrySelection = @{};
  }
  return self;
}
- (void)reject:(NSString *)reason {
  Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : self.nonce, @"reason" : reason,
             @"screenEvidence" : PlainControlScreenEvidence(),
             @"requestedGeometry" : PlainControlRequestedGeometry(),
             @"geometrySelection" : self.geometrySelection,
             @"actualFrame" : self.window ? PlainControlRect(self.window.frame) : NSNull.null,
             @"buttons" : Buttons() });
  std::exit(1);
}
- (NSDictionary *)snapshot {
  NSWindow *window = self.window;
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  NSScreen *primary = NSScreen.screens.firstObject;
  NSUInteger visibleCount = 0;
  for (NSWindow *candidate in NSApp.windows) if (candidate.visible) ++visibleCount;
  CGEventRef pointerEvent = CGEventCreate(NULL);
  CGPoint pointer = pointerEvent ? CGEventGetLocation(pointerEvent) : CGPointMake(NAN, NAN);
  if (pointerEvent) CFRelease(pointerEvent);
  return @{ @"processId" : @(getpid()), @"windowId" : self.windowId,
            @"axIdentifier" : window.accessibilityIdentifier ?: @"",
            @"windowNumber" : @(window.windowNumber),
            @"windowPointer" : [NSString stringWithFormat:@"%p", window],
            @"visible" : @(window.visible), @"key" : @(window.keyWindow),
            @"main" : @(window.mainWindow), @"applicationActive" : @(NSApp.active),
            @"launchFinished" : @(self.launchFinished), @"launchTurnObserved" : @(self.launchTurnObserved),
            @"ownedVisibleWindowCount" : @(visibleCount),
            @"frame" : PlainControlRect(window.frame), @"minimumSize" : PlainControlSize(window.minSize),
            @"screenId" : PlainControlScreenId(screen), @"screenEvidence" : PlainControlScreenEvidence(),
            @"requestedGeometry" : PlainControlRequestedGeometry(), @"geometrySelection" : self.geometrySelection,
            @"quartzFrame" : PlainControlRect(NSMakeRect(window.frame.origin.x,
                NSMaxY(primary.frame) - NSMaxY(window.frame), window.frame.size.width, window.frame.size.height)),
            @"contentMinimumSize" : PlainControlSize(window.contentMinSize),
            @"contentBounds" : PlainControlRect(window.contentView.bounds),
            @"contentLayoutRect" : PlainControlRect(window.contentLayoutRect),
            @"derivedContentInsets" : PlainControlSize(NSMakeSize(window.frame.size.width - window.contentLayoutRect.size.width,
                window.frame.size.height - window.contentLayoutRect.size.height)),
            @"styleMask" : @(window.styleMask), @"inLiveResize" : @(window.inLiveResize),
            @"screenFrame" : PlainControlRect(screen.frame), @"visibleFrame" : PlainControlRect(screen.visibleFrame),
            @"backingScaleFactor" : @(screen.backingScaleFactor),
            @"pointer" : @{ @"x" : @(pointer.x), @"y" : @(pointer.y) },
            @"buttons" : Buttons() };
}
- (void)record:(NSString *)reason proposedSize:(nullable NSValue *)proposed {
  NSMutableDictionary *entry = [[self snapshot] mutableCopy];
  entry[@"sequence"] = @(++self.sequence);
  entry[@"reason"] = reason;
  entry[@"capturedAtUnixSeconds"] = @(NSDate.date.timeIntervalSince1970);
  if (proposed) entry[@"proposedSize"] = PlainControlSize(proposed.sizeValue);
  NSEvent *event = NSApp.currentEvent;
  if (event) {
    const BOOL pointerEvent = event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp ||
        event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeRightMouseUp ||
        event.type == NSEventTypeOtherMouseDown || event.type == NSEventTypeOtherMouseUp ||
        event.type == NSEventTypeMouseMoved || event.type == NSEventTypeLeftMouseDragged ||
        event.type == NSEventTypeRightMouseDragged || event.type == NSEventTypeOtherMouseDragged;
    const BOOL hasMouseDelta = event.type == NSEventTypeMouseMoved ||
        event.type == NSEventTypeLeftMouseDragged || event.type == NSEventTypeRightMouseDragged ||
        event.type == NSEventTypeOtherMouseDragged;
    if (pointerEvent) {
      CGEventRef native = event.CGEvent;
      entry[@"currentEvent"] = @{
        @"windowMatches" : @(event.window == self.window), @"windowNumber" : @(event.windowNumber),
        @"type" : @(event.type), @"timestamp" : @(event.timestamp),
        @"locationX" : @(event.locationInWindow.x), @"locationY" : @(event.locationInWindow.y),
        @"deltaX" : @(hasMouseDelta ? event.deltaX : 0), @"deltaY" : @(hasMouseDelta ? event.deltaY : 0),
        @"sourceProcessId" : @(native ? CGEventGetIntegerValueField(native, kCGEventSourceUnixProcessID) : -1) };
    } else entry[@"currentEvent"] = @{ @"type" : @(event.type), @"pointerFieldsAvailable" : @NO };
  }
  if (self.records.count == 128) { [self.records removeObjectAtIndex:0]; ++self.dropped; }
  [self.records addObject:entry];
}
- (void)maybeReady {
  NSWindow *window = self.window;
  if (self.readySent || !self.launchFinished || !self.launchTurnObserved ||
      !window.visible || !window.keyWindow || !window.mainWindow || !NSApp.active) return;
  const NSRect selected = self.selectedFrame;
  if (!PlainControlValidRect(window.frame) || !NSEqualRects(window.frame, selected) ||
      !window.screen || !NSContainsRect(window.screen.visibleFrame, window.frame) ||
      ![PlainControlScreenId(window.screen) isEqual:self.geometrySelection[@"screenId"]] ||
      !NSEqualSizes(window.minSize, NSMakeSize(640, 512)) ||
      window.frame.size.width < window.minSize.width + 48 ||
      window.frame.size.height < window.minSize.height + 32 || !Neutral(Buttons())) {
    [self reject:@"screen-fit native readback or resize margin was not admitted"];
  }
  self.readySent = YES;
  [self record:@"ready" proposedSize:nil];
  Publish(@{ @"stage" : @"ready", @"nonce" : self.nonce, @"snapshot" : [self snapshot] });
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  if (!Neutral(Buttons())) {
    [self reject:@"left button was held before control setup"];
  }
  NSDictionary *screenEvidence = PlainControlScreenEvidence();
  NSScreen *main = NSScreen.mainScreen;
  NSScreen *screen = main ?: NSScreen.screens.firstObject;
  if (!screen || !PlainControlValidRect(screen.frame) || !PlainControlValidRect(screen.visibleFrame)) {
    [self reject:@"no screen with valid native frame and visibleFrame was available"];
  }
  NSRect visible = screen.visibleFrame;
  NSSize selectedSize = NSMakeSize(MIN((CGFloat)960, visible.size.width), MIN((CGFloat)677, visible.size.height));
  CGFloat inset = MIN((CGFloat)56, MAX((CGFloat)0, visible.size.width - selectedSize.width));
  NSRect frame = NSMakeRect(NSMinX(visible) + inset, NSMaxY(visible) - selectedSize.height,
      selectedSize.width, selectedSize.height);
  self.selectedFrame = frame;
  self.geometrySelection = @{ @"selectionSource" : main ? @"mainScreen" : @"screens.firstObject",
      @"screenId" : PlainControlScreenId(screen), @"screenEvidence" : screenEvidence,
      @"requestedFrame" : PlainControlRect(NSMakeRect(NSMinX(visible) + 56, NSMaxY(visible) - 677, 960, 677)),
      @"selectedFrame" : PlainControlRect(frame) };
  if (selectedSize.width < 640 + 48 || selectedSize.height < 512 + 32 || !NSContainsRect(visible, frame)) {
    [self reject:@"screen-fit geometry cannot provide both original resize deltas above the native minimum"];
  }
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 960, 640)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.releasedWhenClosed = NO;
  self.window.title = @"Rion diagnostic plain Cocoa resize control";
  self.window.accessibilityIdentifier = [@"com.rionstudio.runtime.appkit-window.v1:" stringByAppendingString:self.windowId];
  self.window.delegate = self;
  // Match the observed raw frame minimum. Preserve Cocoa's default content
  // minimum/insets; this control does not invent an Electron content constraint.
  self.window.minSize = NSMakeSize(640, 512);
  [self.window setFrame:frame display:NO];
  [self record:@"configured" proposedSize:nil];
  [self.window makeKeyAndOrderFront:nil];
  if (@available(macOS 14.0, *)) [NSApp activate];
  else {
    [self reject:@"the diagnostic control requires macOS 14 or newer"];
  }
  self.launchFinished = YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    self.launchTurnObserved = YES;
    [self maybeReady];
  });
}
- (void)applicationDidBecomeActive:(NSNotification *)notification { (void)notification; [self maybeReady]; }
- (void)windowDidBecomeKey:(NSNotification *)notification { (void)notification; [self maybeReady]; }
- (void)windowDidBecomeMain:(NSNotification *)notification { (void)notification; [self maybeReady]; }
- (void)windowWillStartLiveResize:(NSNotification *)notification {
  (void)notification; [self record:@"WillStartLiveResize" proposedSize:nil];
}
- (void)windowDidResize:(NSNotification *)notification {
  (void)notification; [self record:@"DidResize" proposedSize:nil];
}
- (void)windowDidEndLiveResize:(NSNotification *)notification {
  (void)notification; [self record:@"DidEndLiveResize" proposedSize:nil];
}
- (NSSize)windowWillResize:(NSWindow *)sender toSize:(NSSize)size {
  if (sender == self.window) [self record:@"windowWillResize:unchanged-return" proposedSize:[NSValue valueWithSize:size]];
  return size;
}
- (void)receiveCommand:(NSDictionary *)command {
  if (self.closeRequested || ![command[@"nonce"] isEqual:self.nonce]) {
    [self reject:@"unexpected control command"];
  }
  if ([command[@"command"] isEqual:@"checkpoint"] && self.readySent &&
      [@[@"right", @"bottom"] containsObject:command[@"name"]]) {
    [self record:[@"checkpoint:" stringByAppendingString:command[@"name"]] proposedSize:nil];
    Publish(@{ @"stage" : @"checkpoint", @"nonce" : self.nonce,
               @"name" : command[@"name"], @"snapshot" : [self snapshot] });
    return;
  }
  if (![command[@"command"] isEqual:@"close"]) {
    [self reject:@"unknown control command"];
  }
  self.closeRequested = YES;
  NSDictionary *before = [self snapshot];
  [self.window close];
  [self record:@"closed" proposedSize:nil];
  Publish(@{ @"stage" : @"closed", @"nonce" : self.nonce,
             @"beforeClose" : before, @"afterClose" : [self snapshot],
             @"journal" : @{ @"capacity" : @128, @"sequence" : @(self.sequence),
                             @"dropped" : @(self.dropped), @"records" : self.records },
             @"coverage" : @"Delegate/notification snapshots; not an all-input event journal" });
  [NSApp terminate:nil];
}
@end

int main(int argc, const char * _Nonnull * _Nonnull argv) {
  @autoreleasepool {
    if (argc != 3) { fprintf(stderr, "expected exact window ID and nonce\n"); return 1; }
    PlainResizeControl *control = [PlainResizeControl new];
    control.windowId = [NSString stringWithUTF8String:argv[1]];
    control.nonce = [NSString stringWithUTF8String:argv[2]];
    if (!Neutral(Buttons())) {
      [control reject:@"left button was held at control startup"];
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSApp.delegate = control;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @autoreleasepool {
        char input[1024];
        while (fgets(input, sizeof(input), stdin)) {
          NSDictionary *command = nil;
          NSData *data = [[NSString stringWithUTF8String:input] dataUsingEncoding:NSUTF8StringEncoding];
          id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
          if ([value isKindOfClass:NSDictionary.class]) command = value;
          dispatch_async(dispatch_get_main_queue(), ^{ [control receiveCommand:command ?: @{}]; });
          if ([command[@"command"] isEqual:@"close"]) return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{ [control receiveCommand:@{}]; });
      }
    });
    [NSApp run];
    return 1; // Only the exact close command may terminate this process cleanly.
  }
}
NS_ASSUME_NONNULL_END
